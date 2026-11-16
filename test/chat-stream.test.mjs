import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeChatEvent, MAX_EVENT_CHARS, MAX_REPLY_CHARS } from '../lib/chat-protocol.mjs';
import { readChatResponse } from '../lib/chat-transport.mjs';
import { buildConversation } from '../lib/chat-client.mjs';
import { chatReducer, initialChatState } from '../lib/chat-state.mjs';

function responseFor(bytes, { split = 1, onCancel = () => {} } = {}) {
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + split));
        offset = Math.min(offset + split, bytes.length);
      },
      cancel: onCancel,
    }),
    { headers: { 'Content-Type': 'text/event-stream', 'X-Request-ID': 'request-test' } },
  );
}

function events(...items) {
  return Buffer.concat(items.map(([event, data]) => encodeChatEvent(event, data)));
}

const start = ['start', { requestId: 'request-test' }];
const delta = (text) => ['text-delta', { delta: text }];
const done = ['done', {}];

test('SSE survives byte-by-byte UTF-8, escaped newlines and split CRLF boundaries', async () => {
  const bytes = events(start, delta('中文🙂\n'), delta('下一行'), done);
  const crlf = new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll('\n', '\r\n'));
  const updates = [];
  assert.equal(
    await readChatResponse(responseFor(crlf), { onDelta: (text) => updates.push(text) }),
    '中文🙂\n下一行',
  );
  assert.deepEqual(updates, ['中文🙂\n', '中文🙂\n下一行']);
});

test('coalesced events, comment heartbeats and multiline data parse correctly', async () => {
  const bytes = Buffer.concat([
    events(start),
    Buffer.from(
      ': keepalive\n\nevent: future\ndata: {}\n\n' +
        'event: text-delta\ndata: {\ndata: "delta":"hello"}\n\n',
    ),
    events(done),
  ]);
  assert.equal(await readChatResponse(responseFor(bytes, { split: bytes.length })), 'hello');
});

test('EOF after partial text cannot become a successful reply', async () => {
  let partial;
  await assert.rejects(
    readChatResponse(responseFor(events(start, delta('半截答案'))), {
      onDelta: (text) => {
        partial = text;
      },
    }),
    (error) => error.name === 'ChatResponseError' && error.requestId === 'request-test',
  );
  assert.equal(partial, '半截答案');
});

test('a sanitized midstream error retains the trace ID and code', async () => {
  await assert.rejects(
    readChatResponse(
      responseFor(
        events(start, delta('partial'), [
          'error',
          { error: '服务暂时不可用', code: 'upstream_unavailable' },
        ]),
      ),
    ),
    (error) =>
      error.message === '服务暂时不可用' &&
      error.code === 'upstream_unavailable' &&
      error.requestId === 'request-test',
  );
});

for (const [label, bytes] of [
  ['missing start', events(delta('text'), done)],
  ['repeated start', events(start, start, delta('text'), done)],
  ['mismatched request ID', events(['start', { requestId: 'other' }], delta('text'), done)],
  ['empty completion', events(start, done)],
  ['whitespace completion', events(start, delta(' \n '), done)],
  ['malformed JSON', Buffer.from('event: start\ndata: {\n\n')],
  ['incomplete event', Buffer.from('event: start\ndata: {}')],
  ['oversized reply', events(start, delta('x'.repeat(MAX_REPLY_CHARS + 1)), done)],
  ['oversized frame', Buffer.from(`data: ${'x'.repeat(MAX_EVENT_CHARS)}\n\n`)],
]) {
  test(`${label} is rejected rather than saved`, async () => {
    let cancelled = false;
    await assert.rejects(
      readChatResponse(
        responseFor(bytes, {
          split: 16_384,
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
    );
    // Malformed input is rejected before all fixture bytes are requested.
    if (label === 'oversized reply') assert.equal(cancelled, true);
  });
}

test('abort cancels a stalled body reader and does not publish late chunks', async () => {
  let cancelled = false;
  let updates = 0;
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
  const reading = readChatResponse(response, {
    signal: controller.signal,
    onDelta: () => {
      updates += 1;
    },
  });
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(updates, 0);
});

test('JSON callers remain supported and HTTP failures retain a request ID', async () => {
  assert.equal(
    await readChatResponse(Response.json({ content: 'compatible reply' })),
    'compatible reply',
  );
  await assert.rejects(
    readChatResponse(
      Response.json(
        { error: '访问口令无效' },
        {
          status: 401,
          headers: { 'X-Request-ID': 'failed-request' },
        },
      ),
    ),
    (error) => error.message === '访问口令无效' && error.requestId === 'failed-request',
  );
});

test('partial, failed and cancelled turns are excluded when retrying', () => {
  let state = chatReducer(initialChatState, { type: 'begin', id: 1, text: 'first' });
  state = chatReducer(state, { type: 'complete', id: 1, content: 'finished' });
  state = chatReducer(state, { type: 'begin', id: 2, text: 'second' });
  state = chatReducer(state, { type: 'delta', id: 2, content: 'partial' });
  assert.deepEqual(
    buildConversation(state.messages, 'while streaming').map((item) => item.content),
    ['first', 'finished', 'while streaming'],
  );
  state = chatReducer(state, { type: 'fail', id: 2, error: 'interrupted', text: 'second' });
  assert.equal(
    state.messages.find((message) => message.content === 'partial').status,
    'incomplete',
  );
  assert.deepEqual(
    buildConversation(state.messages, 'retry').map((item) => item.content),
    ['first', 'finished', 'retry'],
  );
});

test('clearing and immediately sending isolates the new session from every stale action', () => {
  let state = chatReducer(initialChatState, { type: 'begin', id: 1, text: 'old' });
  state = chatReducer(state, { type: 'clear' });
  state = chatReducer(state, { type: 'begin', id: 2, text: 'new' });
  const current = state;
  for (const type of ['delta', 'complete', 'fail']) {
    state = chatReducer(state, { type, id: 1, content: 'late', error: 'late' });
    assert.equal(state, current);
  }
  state = chatReducer(state, { type: 'delta', id: 2, content: 'new partial' });
  state = chatReducer(state, { type: 'complete', id: 2, content: 'new complete' });
  assert.equal(state.activeId, null);
  assert.deepEqual(
    buildConversation(state.messages, 'next').map((item) => item.content),
    ['new', 'new complete', 'next'],
  );
});
