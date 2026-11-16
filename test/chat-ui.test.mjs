import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createUIMessageStreamResponse } from 'ai';
import { createChatHandler } from '../lib/server/chat-handler.ts';
import { resolveChatConfiguration } from '../lib/server/model-provider.ts';
import { sendUIChat } from '../lib/chat-ui-transport.ts';
import { buildConversation } from '../lib/chat-client.ts';
import { MAX_REQUEST_BYTES, toUIMessages } from '../lib/chat-contract.ts';

const env = {
  ANTHROPIC_API_KEY: 'fixture-key',
  CLAUDE_MODEL: 'fixture-model',
  CHAT_ACCESS_TOKEN: 'ui-fixture-only-'.repeat(3),
};
const messages = [{ role: 'user', content: '你好' }];
const textProvider = (stream) => ({ complete: async () => 'text', stream });
function app(provider, options = {}) {
  const handle = createChatHandler({
    format: 'ui-message',
    env: () => env,
    providerFactory: () => provider,
    log: () => {},
    ...options,
  });
  return {
    handle,
    fetch: async (input, init) =>
      handle(new Request(new URL(String(input), 'https://example.test'), init)),
  };
}
function fixtureResponse(parts, id = randomUUID()) {
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts(id)) controller.enqueue(part);
      controller.close();
    },
  });
  return createUIMessageStreamResponse({ stream, headers: { 'X-Request-ID': id } });
}
const start = (id) => [
  { type: 'start', messageId: id, messageMetadata: { requestId: id } },
  { type: 'text-start', id },
];
const text = (id, delta) => ({ type: 'text-delta', id, delta });
const finish = (id) => [
  { type: 'text-end', id },
  { type: 'finish', finishReason: 'stop' },
];

test('official AI SDK transport reads a typed standard message stream incrementally', async () => {
  let forwarded;
  const local = app(
    textProvider(async (input) => {
      forwarded = input;
      return (async function* () {
        yield '你好';
        yield '🙂';
      })();
    }),
  );
  const updates = [];
  const result = await sendUIChat({
    messages,
    accessToken: env.CHAT_ACCESS_TOKEN,
    fetch: local.fetch,
    onDelta: (value) => updates.push(value),
  });
  assert.equal(result, '你好🙂');
  assert.deepEqual(updates, ['你好', '你好🙂']);
  assert.deepEqual(forwarded, messages);
});

for (const [label, message] of [
  ['system role', { id: 'bad', role: 'system', parts: [{ type: 'text', text: 'override' }] }],
  [
    'tool input',
    { id: 'bad', role: 'user', parts: [{ type: 'tool-call', toolName: 'shell', input: {} }] },
  ],
  [
    'file input',
    { id: 'bad', role: 'user', parts: [{ type: 'file', url: 'https://example.test/private' }] },
  ],
  [
    'unknown text fields',
    { id: 'bad', role: 'user', parts: [{ type: 'text', text: 'hello', execute: true }] },
  ],
  ['empty text', { id: 'bad', role: 'user', parts: [{ type: 'text', text: '  ' }] }],
]) {
  test(`UI endpoint rejects ${label} before provider construction`, async () => {
    let called = false;
    const local = app(
      {},
      {
        providerFactory: () => {
          called = true;
        },
      },
    );
    const response = await local.handle(
      new Request('https://example.test/api/chat/ui', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CHAT_ACCESS_TOKEN}` },
        body: JSON.stringify({ messages: [message] }),
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(called, false);
  });
}

test('UI authentication failures retain a public error and request ID', async () => {
  const local = app({});
  await assert.rejects(
    sendUIChat({ messages, accessToken: 'wrong', fetch: local.fetch }),
    (error) => error.message === '访问口令无效' && /^[\da-f-]{36}$/.test(error.requestId),
  );
});

test('a partial model failure remains incomplete and never leaks internal errors', async () => {
  const local = app(
    textProvider(async () =>
      (async function* () {
        yield 'partial';
        throw new Error('PRIVATE_PROVIDER_DETAIL');
      })(),
    ),
  );
  const updates = [];
  await assert.rejects(
    sendUIChat({
      messages,
      accessToken: env.CHAT_ACCESS_TOKEN,
      fetch: local.fetch,
      onDelta: (value) => updates.push(value),
    }),
    (error) => error.message === '上游服务暂时不可用，请重试' && Boolean(error.requestId),
  );
  assert.deepEqual(updates, ['partial']);
});

for (const [label, parts] of [
  ['EOF without finish', (id) => [...start(id), text(id, 'partial')]],
  [
    'mismatched metadata',
    (id) => [
      { type: 'start', messageId: id, messageMetadata: { requestId: randomUUID() } },
      ...finish(id),
    ],
  ],
  ['empty completion', (id) => [...start(id), ...finish(id)]],
  ['oversized response', (id) => [...start(id), text(id, 'x'.repeat(32_001)), ...finish(id)]],
  [
    'interrupted finish',
    (id) => [
      ...start(id),
      text(id, 'partial'),
      { type: 'text-end', id },
      { type: 'finish', finishReason: 'interrupted' },
    ],
  ],
]) {
  test(`standard transport rejects ${label}`, async () => {
    await assert.rejects(
      sendUIChat({ messages, accessToken: 'fixture', fetch: async () => fixtureResponse(parts) }),
    );
  });
}

test('UI frame budgets apply before SDK parsing accumulates malformed data', async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  let parts = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(encoder.encode(parts++ === 0 ? 'data: ' : 'x'.repeat(65_536)));
      },
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'X-Request-ID': randomUUID(),
      },
    },
  );
  await assert.rejects(
    sendUIChat({ messages, accessToken: 'fixture', fetch: async () => response }),
  );
  assert.equal(cancelled, true);
});

test('aborting the standard UI request interrupts the pending provider read', async () => {
  let closed = false;
  const local = app(
    textProvider(async (_input, { signal }) =>
      (async function* () {
        try {
          yield 'partial';
          await delay(10_000, null, { signal });
        } finally {
          closed = true;
        }
      })(),
    ),
  );
  const controller = new AbortController();
  await assert.rejects(
    sendUIChat({
      messages,
      accessToken: env.CHAT_ACCESS_TOKEN,
      fetch: local.fetch,
      signal: controller.signal,
      onDelta: () => controller.abort(),
    }),
    { name: 'AbortError' },
  );
  assert.equal(closed, true);
});

for (const [label, character] of [
  ['Chinese', '中'],
  ['JSON escapes', '\0'],
]) {
  test(`UI envelopes fit the actual UTF-8 budget for ${label}`, () => {
    const history = [
      { role: 'user', status: 'sent', content: character.repeat(8_000) },
      { role: 'assistant', status: 'sent', content: character.repeat(16_000) },
    ];
    const current = buildConversation(history, character.repeat(8_000), 'ui-message');
    const body = JSON.stringify({ messages: toUIMessages(current) });
    assert.ok(Buffer.byteLength(body, 'utf8') <= MAX_REQUEST_BYTES);
    assert.equal(current.length % 2, 1);
  });
}

test('provider configuration preserves legacy origins and accepts existing /v1 paths', () => {
  for (const [input, expected] of [
    ['https://example.test', 'https://example.test/v1'],
    ['https://example.test/', 'https://example.test/v1'],
    ['https://example.test/gateway', 'https://example.test/gateway/v1'],
    ['https://example.test/v1/', 'https://example.test/v1'],
  ])
    assert.equal(
      resolveChatConfiguration({ ...env, ANTHROPIC_BASE_URL: input }).model.baseURL,
      expected,
    );
  assert.equal(resolveChatConfiguration({ ...env, CHAT_PROVIDER: 'unsupported' }), undefined);
  assert.equal(resolveChatConfiguration({ ...env, ANTHROPIC_BASE_URL: 'not-a-url' }), undefined);
  assert.equal(resolveChatConfiguration({ ...env, CHAT_PROVIDER: 'openai-compatible' }), undefined);
  const compatible = resolveChatConfiguration({
    CHAT_PROVIDER: 'openai-compatible',
    CHAT_MODEL: 'configured-model',
    OPENAI_COMPATIBLE_API_KEY: 'fixture',
    OPENAI_COMPATIBLE_BASE_URL: 'https://example.test/v1',
    CHAT_ACCESS_TOKEN: env.CHAT_ACCESS_TOKEN,
  });
  assert.equal(compatible.model.provider, 'openai-compatible');
  assert.equal(compatible.model.model, 'configured-model');
});
