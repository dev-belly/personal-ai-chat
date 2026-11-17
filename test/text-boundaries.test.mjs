import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createChatHandler } from '../lib/server/chat-handler.ts';
import { readJsonBody, RequestBodyError, validateMessages } from '../lib/chat-validation.ts';
import { readChatResponse } from '../lib/chat-transport.ts';
import { sendUIChat } from '../lib/chat-ui-transport.ts';
import { encodeChatEvent } from '../lib/chat-protocol.ts';
import { buildConversation } from '../lib/chat-client.ts';
import { createConversationRepository, ConversationStoreError, exportConversation } from '../lib/local/conversation-store.ts';
import { inspectText, textFindings } from '../scripts/check-text.mjs';

const env = { ANTHROPIC_API_KEY: 'fixture-key', CLAUDE_MODEL: 'fixture-model', CHAT_ACCESS_TOKEN: 'unicode-fixture-'.repeat(3) };
const messages = [{ role: 'user', content: '你好🙂' }];
const options = { method: 'POST', headers: { Authorization: `Bearer ${env.CHAT_ACCESS_TOKEN}` } };
const streamOf = (chunks) => new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); } });

test('invalid UTF-8 and escaped unpaired surrogates are rejected before constructing a provider', async () => {
  let calls = 0;
  const handler = createChatHandler({ env: () => env, providerFactory: () => { calls += 1; throw Error('must not run'); }, log: () => {} });
  const prefix = Buffer.from('{"messages":[{"role":"user","content":"');
  const suffix = Buffer.from('"}]}');
  for (const middle of [Buffer.from([255]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82])]) {
    const response = await handler(new Request('https://local/api/chat', { ...options, body: Buffer.concat([prefix, middle, suffix]) }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /UTF-8/);
  }
  const response = await handler(new Request('https://local/api/chat', { ...options, body: JSON.stringify({ messages: [{ role: 'user', content: 'bad\uD83D' }] }) }));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.equal(validateMessages([{ role: 'user', content: '\uDE42' }]).ok, false);
  assert.throws(() => buildConversation([], 'bad\uD83D'), /不完整/);
});

test('valid Chinese and emoji survive one-byte request chunks without replacement', async () => {
  const bytes = Buffer.from(JSON.stringify({ messages }));
  const request = new Request('https://local', { method: 'POST', duplex: 'half', body: streamOf([...bytes].map(byte => new Uint8Array([byte]))) });
  assert.deepEqual(await readJsonBody(request), { messages });
  await assert.rejects(readJsonBody(new Request('https://local', { method: 'POST', body: new Uint8Array([0xe2, 0x82]) })), error => error instanceof RequestBodyError && error.status === 400 && /UTF-8/.test(error.message));
});

for (const format of ['legacy', 'ui-message']) {
  function app(chunks, complete = '正常回复') {
    const handler = createChatHandler({ format, env: () => env, log: () => {}, providerFactory: () => ({ complete: async () => complete, stream: async () => (async function* () { yield* chunks; })() }) });
    return async (input, init) => handler(new Request(new URL(String(input), 'https://local'), init));
  }
  async function read(chunks, updates) {
    const fetch = app(chunks);
    if (format === 'ui-message') return sendUIChat({ messages, accessToken: env.CHAT_ACCESS_TOKEN, fetch, onDelta: text => updates.push(text) });
    return readChatResponse(await fetch('/api/chat', { ...options, headers: { ...options.headers, Accept: 'text/event-stream' }, body: JSON.stringify({ messages }) }), { onDelta: text => updates.push(text) });
  }
  test(`${format} preserves surrogate pairs split across actual provider deltas`, async () => {
    const updates = [];
    assert.equal(await read(['中文\uD83D', '', '\uDE42'], updates), '中文🙂');
    assert.deepEqual(updates, ['中文', '中文🙂']);
    assert.ok(updates.every(text => text.isWellFormed()));
  });
  test(`${format} never commits malformed or unfinished provider characters`, async () => {
    for (const chunks of [['前文', '\uDE42'], ['前文\uD83D'], ['\uD83Dx']]) {
      const updates = [];
      await assert.rejects(read(chunks, updates), /不完整|中断/);
      assert.ok(updates.every(text => text.isWellFormed()));
    }
  });
}

test('the legacy JSON endpoint rejects malformed complete model text', async () => {
  const handler = createChatHandler({ env: () => env, log: () => {}, providerFactory: () => ({ complete: async () => 'bad\uD83D', stream: async () => (async function* () {})() }) });
  const response = await handler(new Request('https://local', { ...options, body: JSON.stringify({ messages }) }));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'invalid_reply');
});

test('both browser readers buffer escaped surrogate halves without displaying broken characters', async () => {
  const id = randomUUID();
  const legacy = ['start', 'text-delta', 'text-delta', 'done'].map((type, index) => encodeChatEvent(type, index === 0 ? { requestId: id } : index === 1 ? { delta: '前文\uD83D' } : index === 2 ? { delta: '\uDE42' } : {}));
  const updates = [];
  assert.equal(await readChatResponse(new Response(streamOf(legacy), { headers: { 'Content-Type': 'text/event-stream' } }), { onDelta: text => updates.push(text) }), '前文🙂');
  assert.deepEqual(updates, ['前文', '前文🙂']);
  const chunks = [{ type: 'start', messageId: id, messageMetadata: { requestId: id } }, { type: 'text-start', id }, { type: 'text-delta', id, delta: '前文\uD83D' }, { type: 'text-delta', id, delta: '\uDE42' }, { type: 'text-end', id }, { type: 'finish', finishReason: 'stop' }];
  const response = () => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', 'X-Vercel-AI-UI-Message-Stream': 'v1', 'X-Request-ID': id } });
  const seen = [];
  assert.equal(await sendUIChat({ messages, accessToken: env.CHAT_ACCESS_TOKEN, fetch: async () => response(), onDelta: text => seen.push(text) }), '前文🙂');
  assert.ok(seen.every(text => text.isWellFormed()));
});

test('invalid UTF-8 in a standard UI stream fails before it reaches displayed text', async () => {
  const id = randomUUID();
  const chunks = [{ type: 'start', messageId: id, messageMetadata: { requestId: id } }, { type: 'text-start', id }, { type: 'text-delta', id, delta: 'bad|' }, { type: 'text-end', id }, { type: 'finish', finishReason: 'stop' }];
  const bytes = Buffer.from(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  bytes[bytes.indexOf('|')] = 255;
  const seen = [];
  await assert.rejects(sendUIChat({ messages, accessToken: env.CHAT_ACCESS_TOKEN, fetch: async () => new Response(bytes, { headers: { 'Content-Type': 'text/event-stream', 'X-Vercel-AI-UI-Message-Stream': 'v1', 'X-Request-ID': id } }), onDelta: text => seen.push(text) }), /中断/);
  assert.deepEqual(seen, []);
});

test('saved titles preserve complete emoji and combining clusters at the 80-unit boundary', async t => {
  const store = createConversationRepository(`unicode-${randomUUID()}`);
  t.after(() => store.database.delete());
  for (const ending of ['🙂', '👨‍👩‍👧‍👦', 'e\u0301']) {
    const content = '中'.repeat(79) + ending;
    const saved = await store.save({ mode: 'demo', messages: [{ role: 'user', content, status: 'sent' }] });
    assert.equal(saved.title, '中'.repeat(79));
    assert.equal((await store.load(saved.id)).messages[0].content, content);
    assert.equal(JSON.parse(exportConversation('demo', saved.messages)).messages[0].content, content);
  }
});

test('malformed stored messages and overlong user messages cannot enter an archive or export', async t => {
  const store = createConversationRepository(`unicode-reject-${randomUUID()}`);
  t.after(() => store.database.delete());
  for (const content of ['bad\uD83D', '\uDE42', 'x'.repeat(8_001)]) {
    const data = [{ role: 'user', content, status: 'sent' }];
    await assert.rejects(store.save({ mode: 'demo', messages: data }), ConversationStoreError);
    assert.throws(() => exportConversation('demo', data), ConversationStoreError);
  }
  assert.equal(await store.database.summaries.count(), 0);
});

test('text scanning checks source bytes without rewriting them and accepts multilingual content', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chat-text-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const broken = Buffer.from([0xff]);
    writeFileSync(path.join(root, 'broken.tsx'), broken);
    writeFileSync(path.join(root, 'README.md'), '\uFEFF中文 → English 🙂\r\n');
    const result = inspectText(root);
    assert.equal(result.checkedFiles, 2);
    assert.deepEqual(result.issues, [{ path: 'broken.tsx', line: 1, reason: 'not valid UTF-8' }]);
    assert.deepEqual(readFileSync(path.join(root, 'broken.tsx')), broken);
    for (const text of ['bad\uFFFD', 'caf\u00C3\u00A9', 'bad\u0000']) assert.equal(textFindings(Buffer.from(text)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
