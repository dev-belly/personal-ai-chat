import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readChatResponse } from '../lib/chat-transport.ts';
import { sendUIChat } from '../lib/chat-ui-transport.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const accessToken = 'local-http-smoke-'.repeat(3);
const apiKey = 'local-upstream-fixture-only';
let upstreamMode = 'text';
const calls = [];
function normalizedMessages(messages) {
  return messages.map(({ role, content }) => ({
    role,
    content:
      typeof content === 'string'
        ? content
        : content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
  }));
}

let checks = 0;
let heldStream;

async function streamFixture(response, mode) {
  response.setHeader('Content-Type', 'text/event-stream');
  const event = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'fixture-model',
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  event('content_block_start', {
    index: 0,
    content_block:
      mode === 'tool'
        ? { type: 'tool_use', id: 'fixture-tool', name: 'fixture', input: {} }
        : { type: 'text', text: '' },
  });
  if (mode === 'tool')
    event('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"private_tool_input":true}' },
    });
  const text = (value) =>
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: value } });
  if (mode === 'held') {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let markClosed;
    const closed = new Promise((resolve) => {
      markClosed = resolve;
    });
    heldStream = { release, closed };
    response.once('close', () => {
      markClosed();
      release();
    });
    text('第一段');
    await gate;
    if (response.destroyed) return;
    text('第二段🙂');
  } else if (mode === 'whitespace') text(' \n ');
  else if (mode === 'oversized') text('x'.repeat(32_001));
  else if (mode !== 'empty' && mode !== 'tool') text('来自本地流式测试的回复🙂');
  if (mode === 'stream-error') {
    event('error', {
      error: { type: 'overloaded_error', message: 'PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK' },
    });
  } else if (mode !== 'incomplete') {
    event('content_block_stop', { index: 0 });
    event('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    event('message_stop', {});
  }
  response.end();
}

async function compatibleFixture(response, payload, mode) {
  if (!payload.stream) {
    response.end(
      JSON.stringify({
        id: 'compatible-fixture',
        object: 'chat.completion',
        created: 0,
        model: 'local-fixture',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '兼容服务的回复' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  response.setHeader('Content-Type', 'text/event-stream');
  const chunk = (content, finish = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'compatible-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'local-fixture',
        choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
      })}\n\n`,
    );
  if (mode === 'held') {
    let release, markClosed;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const closed = new Promise((resolve) => {
      markClosed = resolve;
    });
    heldStream = { release, closed };
    response.once('close', () => {
      markClosed();
      release();
    });
    chunk('第一段');
    await gate;
    if (response.destroyed) return;
    chunk('第二段🙂');
  } else chunk('兼容服务的回复');
  chunk('', 'stop');
  response.end('data: [DONE]\n\n');
}

// The model boundary is a loopback fixture. These checks never use real keys,
// contact a model provider or modify an existing deployment.
const upstream = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  calls.push({
    path: request.url,
    key: request.headers['x-api-key'],
    authorization: request.headers.authorization,
    body: payload,
  });
  response.setHeader('Content-Type', 'application/json');
  if (upstreamMode === 'auth' || upstreamMode === 'rate') {
    response.statusCode = upstreamMode === 'auth' ? 401 : 429;
    response.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: upstreamMode === 'auth' ? 'authentication_error' : 'rate_limit_error',
          message: 'PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK',
        },
      }),
    );
    return;
  }
  if (request.url.endsWith('/chat/completions'))
    return compatibleFixture(response, payload, upstreamMode);
  if (payload.stream) return streamFixture(response, upstreamMode);
  const content =
    upstreamMode === 'empty'
      ? []
      : upstreamMode === 'whitespace'
        ? [{ type: 'text', text: ' \n ' }]
        : upstreamMode === 'tool'
          ? [{ type: 'tool_use', id: 'fixture-tool', name: 'fixture', input: {} }]
          : [{ type: 'text', text: '来自本地 HTTP 测试的回复' }];
  response.end(
    JSON.stringify({
      id: 'msg_local_fixture',
      type: 'message',
      role: 'assistant',
      model: 'local-fixture',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    child.kill('SIGTERM');
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function start(upstreamPort, configured = true, provider = 'anthropic') {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    [
      require.resolve('next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        CHAT_PROVIDER: provider,
        CHAT_MODEL: 'local-fixture',
        OPENAI_COMPATIBLE_API_KEY: configured ? apiKey : '',
        OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        ANTHROPIC_API_KEY: configured ? apiKey : '',
        CLAUDE_MODEL: 'local-fixture',
        CHAT_ACCESS_TOKEN: accessToken,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-16_000);
    });
  }
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Next.js exited before readiness: ${output}`);
      try {
        const response = await fetch(`${origin}/api/chat`, { signal: AbortSignal.timeout(1_000) });
        await response.arrayBuffer();
        if (response.ok) return { child, origin };
      } catch {
        /* A refused connection is normal while the process starts. */
      }
      await delay(100);
    }
    throw new Error(`Next.js readiness timed out: ${output}`);
  } catch (error) {
    await stop(child);
    throw error;
  }
}

async function check(label, operation) {
  await operation();
  checks += 1;
  console.log(`PASS ${label}`);
}

async function within(promise, ms = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('stream fixture timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let app;
try {
  const upstreamPort = await listen(upstream);
  app = await start(upstreamPort);
  const post = (body, token = accessToken, options = {}) =>
    fetch(`${app.origin}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: options.stream ? 'text/event-stream' : 'application/json',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: options.signal || AbortSignal.timeout(10_000),
    });
  const valid = { messages: [{ role: 'user', content: '你好，HTTP 测试' }] };

  await check('readiness reveals configuration only and is not cached', async () => {
    const response = await fetch(`${app.origin}/api/chat`);
    assert.deepEqual(await response.json(), { configured: true });
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(calls.length, 0);
  });
  await check('invalid access token does not call the upstream', async () => {
    assert.equal((await post(valid, 'wrong')).status, 401);
    assert.equal(calls.length, 0);
  });
  for (const [label, body, status] of [
    ['malformed JSON', '{', 400],
    ['invalid message roles', { messages: [{ role: 'assistant', content: 'invalid' }] }, 400],
    ['oversized request', 'x'.repeat(64 * 1024 + 1), 413],
  ]) {
    await check(`${label} is rejected before any upstream call`, async () => {
      assert.equal((await post(body)).status, status);
      assert.equal(calls.length, 0);
    });
  }
  await check('a real HTTP request forwards normalized messages and returns text', async () => {
    const response = await post({ messages: [{ ...valid.messages[0], ignored: 'not forwarded' }] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { content: '来自本地 HTTP 测试的回复' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/v1/messages');
    assert.equal(calls[0].key, apiKey);
    assert.deepEqual(normalizedMessages(calls[0].body.messages), valid.messages);
    assert.equal(calls[0].body.model, 'local-fixture');
  });
  for (const [mode, status] of [
    ['auth', 502],
    ['rate', 429],
  ]) {
    await check(`upstream ${mode} failure is sanitized without automatic retries`, async () => {
      upstreamMode = mode;
      const before = calls.length;
      const response = await post(valid);
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(typeof body.error, 'string');
      assert.doesNotMatch(
        JSON.stringify(body),
        /PRIVATE_UPSTREAM_DETAIL|local-upstream-fixture-only/,
      );
      assert.equal(calls.length, before + 1);
    });
  }
  for (const mode of ['empty', 'whitespace', 'tool']) {
    await check(
      `${mode} upstream content cannot become a successful assistant message`,
      async () => {
        upstreamMode = mode;
        const response = await post(valid);
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(typeof body.error, 'string');
        assert.equal(Object.hasOwn(body, 'content'), false);
      },
    );
  }
  await check('SSE authentication and validation cannot bypass the request boundary', async () => {
    const before = calls.length;
    for (const [body, token, status] of [
      [valid, 'wrong', 401],
      ['{', accessToken, 400],
    ]) {
      const response = await post(body, token, { stream: true });
      assert.equal(response.status, status);
      assert.match(response.headers.get('content-type'), /application\/json/);
    }
    assert.equal(calls.length, before);
  });
  await check('SSE reaches the browser before the upstream final message is released', async () => {
    upstreamMode = 'held';
    let firstDelta;
    const first = new Promise((resolve) => {
      firstDelta = resolve;
    });
    const response = await post(valid, accessToken, { stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('x-request-id'), /^[\da-f-]{36}$/);
    const before = calls.length;
    const reading = readChatResponse(response, {
      onDelta: (text) => {
        if (text === '第一段') firstDelta();
      },
    });
    try {
      await within(
        Promise.race([
          first,
          reading.then(() => {
            throw new Error('completed before first delta');
          }),
        ]),
      );
      assert.equal(calls.at(-1).body.stream, true);
      assert.deepEqual(normalizedMessages(calls.at(-1).body.messages), valid.messages);
    } finally {
      heldStream.release();
    }
    assert.equal(await reading, '第一段第二段🙂');
    assert.equal(calls.length, before);
  });
  for (const mode of ['empty', 'whitespace', 'tool', 'incomplete', 'stream-error', 'oversized']) {
    await check(`SSE ${mode} emits a sanitized error instead of completion`, async () => {
      upstreamMode = mode;
      const before = calls.length;
      const response = await post(valid, accessToken, { stream: true });
      const body = await response.text();
      assert.match(body, /event: error/);
      assert.doesNotMatch(body, /event: done|PRIVATE_UPSTREAM_DETAIL|local-upstream-fixture-only/);
      assert.equal(calls.length, before + 1);
    });
  }
  for (const [mode, status] of [
    ['auth', 502],
    ['rate', 429],
  ]) {
    await check(
      `SSE opening ${mode} error preserves HTTP status and makes one upstream request`,
      async () => {
        upstreamMode = mode;
        const before = calls.length;
        const response = await post(valid, accessToken, { stream: true });
        assert.equal(response.status, status);
        assert.doesNotMatch(await response.text(), /PRIVATE_UPSTREAM_DETAIL/);
        assert.equal(calls.length, before + 1);
      },
    );
  }
  await check('disconnecting a live HTTP stream closes the upstream connection', async () => {
    upstreamMode = 'held';
    const controller = new AbortController();
    let firstDelta;
    const first = new Promise((resolve) => {
      firstDelta = resolve;
    });
    const response = await post(valid, accessToken, { stream: true, signal: controller.signal });
    const reading = readChatResponse(response, {
      signal: controller.signal,
      onDelta: () => firstDelta(),
    });
    await within(Promise.race([first, reading]));
    controller.abort();
    await assert.rejects(reading, { name: 'AbortError' });
    await within(heldStream.closed);
  });
  const ui = (options = {}) =>
    sendUIChat({
      messages: valid.messages,
      accessToken,
      api: `${app.origin}/api/chat/ui`,
      ...options,
    });
  await check(
    'the official UI transport streams typed messages through production HTTP',
    async () => {
      upstreamMode = 'held';
      let firstDelta;
      const first = new Promise((resolve) => {
        firstDelta = resolve;
      });
      const reading = ui({
        onDelta: (text) => {
          if (text === '第一段') firstDelta();
        },
      });
      try {
        await within(
          Promise.race([
            first,
            reading.then(() => {
              throw new Error('UI completed before initial text');
            }),
          ]),
        );
      } finally {
        heldStream?.release();
      }
      assert.equal(await reading, '第一段第二段🙂');
      assert.deepEqual(normalizedMessages(calls.at(-1).body.messages), valid.messages);
    },
  );
  await check(
    'UI authentication and unsupported message parts are rejected before a model call',
    async () => {
      const before = calls.length;
      await assert.rejects(
        ui({ accessToken: 'wrong' }),
        (error) => error.message === '访问口令无效',
      );
      const response = await fetch(`${app.origin}/api/chat/ui`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { id: 'untrusted', role: 'user', parts: [{ type: 'tool-call', toolName: 'shell' }] },
          ],
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(calls.length, before);
    },
  );
  for (const mode of ['incomplete', 'stream-error', 'empty']) {
    await check(`UI ${mode} cannot become a completed turn`, async () => {
      upstreamMode = mode;
      const before = calls.length;
      await assert.rejects(
        ui(),
        (error) => Boolean(error.requestId) && !/PRIVATE_UPSTREAM_DETAIL/.test(error.message),
      );
      assert.equal(calls.length, before + 1);
    });
  }
  await check('cancelling a production UI stream aborts the Anthropic connection', async () => {
    upstreamMode = 'held';
    const controller = new AbortController();
    await assert.rejects(ui({ signal: controller.signal, onDelta: () => controller.abort() }), {
      name: 'AbortError',
    });
    await within(heldStream.closed);
  });
  await stop(app.child);
  app = await start(upstreamPort, true, 'openai-compatible');
  await check(
    'OpenAI-compatible JSON requests use the configured endpoint and private bearer key',
    async () => {
      upstreamMode = 'text';
      const response = await post(valid);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { content: '兼容服务的回复' });
      assert.equal(calls.at(-1).path, '/v1/chat/completions');
      assert.equal(calls.at(-1).authorization, `Bearer ${apiKey}`);
      assert.deepEqual(normalizedMessages(calls.at(-1).body.messages), valid.messages);
    },
  );
  await check('the same standard UI transport reads the OpenAI-compatible provider', async () => {
    assert.equal(await ui(), '兼容服务的回复');
  });
  await check(
    'OpenAI-compatible authentication failure is sanitized and never retried',
    async () => {
      upstreamMode = 'auth';
      const before = calls.length;
      await assert.rejects(ui(), (error) => !/PRIVATE_UPSTREAM_DETAIL/.test(error.message));
      assert.equal(calls.length, before + 1);
    },
  );
  await check('UI cancellation also closes an OpenAI-compatible model stream', async () => {
    upstreamMode = 'held';
    const controller = new AbortController();
    await assert.rejects(ui({ signal: controller.signal, onDelta: () => controller.abort() }), {
      name: 'AbortError',
    });
    await within(heldStream.closed);
  });
  await stop(app.child);
  app = await start(upstreamPort, false);
  await check('unconfigured service returns 503 without contacting the upstream', async () => {
    const before = calls.length;
    assert.deepEqual(await (await fetch(`${app.origin}/api/chat`)).json(), { configured: false });
    assert.equal((await post(valid)).status, 503);
    assert.equal(calls.length, before);
  });
  console.log(`HTTP checks passed: ${checks}; local fixture only, no model calls.`);
} finally {
  if (app) await stop(app.child);
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
