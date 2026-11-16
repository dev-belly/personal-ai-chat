import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatHandler, wantsEventStream } from '../lib/server/chat-handler.mjs';
import { createRequestScope, publicChatError } from '../lib/server/chat-service.mjs';
import { readChatResponse } from '../lib/chat-transport.mjs';

const env = {
  ANTHROPIC_API_KEY: 'fixture-only',
  CLAUDE_MODEL: 'fixture-model',
  CHAT_ACCESS_TOKEN: 'test-'.repeat(10),
};
const valid = { messages: [{ role: 'user', content: 'hello' }] };
function request({ stream = true, token = env.CHAT_ACCESS_TOKEN, body = valid, signal } = {}) {
  return new Request('https://example.test/api/chat', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function handler(provider, options = {}) {
  return createChatHandler({
    env: () => env,
    providerFactory: () => provider,
    log: () => {},
    ...options,
  });
}

test('SSE authentication and input checks run before constructing a provider', async () => {
  let called = false;
  const handle = handler(
    {},
    {
      providerFactory: () => {
        called = true;
        throw new Error('must not run');
      },
    },
  );
  for (const [input, status] of [
    [{ token: 'wrong' }, 401],
    [{ body: '{' }, 400],
    [{ body: { messages: [{ role: 'assistant', content: 'bad' }] } }, 400],
    [{ body: 'x'.repeat(65_537) }, 413],
  ]) {
    const response = await handle(request(input));
    assert.equal(response.status, status);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('x-request-id'), /^[\da-f-]{36}$/);
  }
  assert.equal(called, false);
});

test('negotiation is opt-in, case insensitive and honors explicit q=0', () => {
  for (const [accept, expected] of [
    ['application/json', false],
    ['text/event-stream;q=0', false],
    ['text/event-stream; q=0.000', false],
    ['application/json, Text/Event-Stream; q=0.9', true],
  ]) {
    assert.equal(
      wantsEventStream(new Request('https://example.test', { headers: { Accept: accept } })),
      expected,
    );
  }
});

test('JSON and streaming paths use one reply policy and preserve JSON shape', async () => {
  const handle = handler({
    complete: async () => 'hello',
    stream: async () =>
      (async function* () {
        yield 'hel';
        yield 'lo';
      })(),
  });
  assert.deepEqual(await (await handle(request({ stream: false }))).json(), { content: 'hello' });
  const response = await handle(request());
  assert.match(response.headers.get('cache-control'), /no-transform/);
  assert.equal(await readChatResponse(response), 'hello');
});

test('pre-stream upstream errors retain status while sanitizing logs and response', async () => {
  const logs = [];
  const handle = handler(
    {
      stream() {
        throw Object.assign(new Error('PRIVATE_DETAIL'), { status: 429 });
      },
    },
    {
      log: (entry) => logs.push(entry),
    },
  );
  const response = await handle(request());
  assert.equal(response.status, 429);
  const data = await response.json();
  assert.equal(data.code, 'upstream_rate_limit');
  assert.equal(data.requestId, response.headers.get('x-request-id'));
  assert.equal(logs[0].requestId, data.requestId);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['code', 'requestId', 'status']);
  assert.doesNotMatch(JSON.stringify({ logs, data }), /PRIVATE_DETAIL|fixture-only/);
});

test('midstream failure emits error, never done, and closes the provider', async () => {
  let closed = false;
  const handle = handler({
    stream: async () =>
      (async function* () {
        try {
          yield 'partial';
          throw new Error('PRIVATE_DETAIL');
        } finally {
          closed = true;
        }
      })(),
  });
  const response = await handle(request());
  const body = await response.text();
  assert.match(body, /event: error/);
  assert.doesNotMatch(body, /event: done|PRIVATE_DETAIL/);
  assert.equal(closed, true);
});

test('reply limits and empty content apply to streams and JSON replies', async () => {
  for (const content of ['', ' \n ', 'x'.repeat(32_001)]) {
    const handle = handler({
      complete: async () => content,
      stream: async () =>
        (async function* () {
          yield content;
        })(),
    });
    assert.equal((await handle(request({ stream: false }))).status, 502);
    await assert.rejects(readChatResponse(await handle(request())));
  }
});

test('a total deadline terminates an upstream stalled after headers', async () => {
  let upstreamSignal;
  const handle = handler(
    {
      stream: async (_messages, { signal }) => {
        upstreamSignal = signal;
        return (async function* () {
          yield 'partial';
          await delay(10_000, null, { signal });
        })();
      },
    },
    { timeoutMs: 30 },
  );
  await assert.rejects(
    readChatResponse(await handle(request())),
    (error) => error.code === 'upstream_timeout',
  );
  assert.equal(upstreamSignal.aborted, true);
});

test('cancelling the response interrupts an in-flight upstream read', async () => {
  let upstreamSignal;
  let closed = false;
  const handle = handler({
    stream: async (_messages, { signal }) => {
      upstreamSignal = signal;
      return (async function* () {
        try {
          yield 'partial';
          await delay(10_000, null, { signal });
        } finally {
          closed = true;
        }
      })();
    },
  });
  const response = await handle(request());
  const reader = response.body.getReader();
  await reader.read(); // start
  await reader.read(); // delta; next pull is now allowed to await upstream
  await reader.cancel();
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(closed, true);
});

test('disposing a request scope removes its deadline and parent listener', async () => {
  const parent = new AbortController();
  const scope = createRequestScope(parent.signal, 5);
  scope.dispose();
  parent.abort();
  await delay(10);
  assert.equal(scope.signal.aborted, false);
  assert.equal(scope.timedOut, false);
  assert.equal(publicChatError(new Error('secret')).error.includes('secret'), false);
});

test('the deadline also cancels a stalled incoming request body before any provider call', async () => {
  let called = false;
  let cancelled = false;
  const handle = handler(
    {},
    {
      timeoutMs: 15,
      providerFactory: () => {
        called = true;
      },
    },
  );
  const response = await handle(
    new Request('https://example.test/api/chat', {
      method: 'POST',
      duplex: 'half',
      headers: { Authorization: `Bearer ${env.CHAT_ACCESS_TOKEN}` },
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'upstream_timeout');
  assert.equal(called, false);
  assert.equal(cancelled, true);
});
