import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createConversationRepository, ConversationConflictError, ConversationStoreError,
  exportConversation, snapshotMessages } from '../lib/local/conversation-store.ts';
import { buildConversation } from '../lib/chat-client.ts';

const messages = [ { role: 'user', content: '学习 TypeScript', status: 'sent', request: 7 },
  { role: 'assistant', content: '先做一个小项目。', status: 'sent', request: 7 } ];
async function repository(t) {
  const result = createConversationRepository(`chat-fixture-${randomUUID()}`);
  t.after(() => result.database.delete());
  return result;
}

test('an actual IndexedDB transaction saves metadata and messages and restores a completed turn', async (t) => {
  const store = await repository(t);
  const saved = await store.save({ mode: 'demo', messages });
  const loaded = await store.load(saved.id);
  assert.equal(loaded.title, '学习 TypeScript');
  assert.equal(loaded.revision, 1);
  assert.deepEqual(buildConversation(loaded.messages, '下一步').map(item => item.content), ['学习 TypeScript', '先做一个小项目。', '下一步']);
  assert.equal((await store.list('TYPESCRIPT')).length, 1);
  assert.equal((await store.list('未找到')).length, 0);
  assert.deepEqual(loaded.messages.map(item => item.request), [undefined, undefined]);
});

test('a failed second-table write rolls back the first metadata write', async (t) => {
  const store = await repository(t);
  const fail = () => { throw new Error('fixture write failure'); };
  store.database.bodies.hook('creating', fail);
  await assert.rejects(store.save({ mode: 'demo', messages }), /fixture write failure/);
  assert.equal(await store.database.summaries.count(), 0);
  assert.equal(await store.database.bodies.count(), 0);
});

test('stale saves cannot overwrite a newer revision', async (t) => {
  const store = await repository(t);
  const saved = await store.save({ mode: 'live', messages });
  const changed = [...messages, { role: 'user', content: '第二轮', status: 'sent' }, { role: 'assistant', content: '新回复', status: 'sent' }];
  const newer = await store.save({ id: saved.id, expectedRevision: saved.revision, mode: 'live', messages: changed });
  await assert.rejects(store.save({ id: saved.id, expectedRevision: saved.revision, mode: 'live', messages }), ConversationConflictError);
  const loaded = await store.load(saved.id);
  assert.equal(loaded.revision, 2);
  assert.deepEqual(loaded.messages, newer.messages);
});

test('a stale delete is refused and a completed delete removes both tables without resurrection', async (t) => {
  const store = await repository(t);
  const first = await store.save({ mode: 'demo', messages });
  const current = await store.save({ id: first.id, expectedRevision: 1, mode: 'demo', messages });
  await assert.rejects(store.remove(first.id, 1), ConversationConflictError);
  assert.equal((await store.list()).length, 1);
  await store.remove(current.id, current.revision);
  assert.equal(await store.database.summaries.count(), 0);
  assert.equal(await store.database.bodies.count(), 0);
  await assert.rejects(store.save({ id: current.id, expectedRevision: current.revision, mode: 'demo', messages }), ConversationStoreError);
});

test('pending and partial messages never become successful context after saving or exporting', () => {
  const unfinished = [...messages, { role: 'user', status: 'pending', content: '未完成提问', request: 9 },
    { role: 'assistant', status: 'streaming', content: '半截回复', request: 9 },
    { role: 'error', content: '已取消', retryText: '未完成提问' }];
  const snapshot = snapshotMessages(unfinished);
  assert.equal(snapshot[2].status, 'failed');
  assert.equal(snapshot[3].status, 'incomplete');
  assert.deepEqual(buildConversation(snapshot, '继续').map(item => item.content), ['学习 TypeScript', '先做一个小项目。', '继续']);
  const exported = JSON.parse(exportConversation('live', unfinished));
  assert.equal(exported.format, 'personal-ai-chat');
  assert.deepEqual(exported.messages, snapshot);
});

test('saving projects only conversation data and never the access-token configuration', async (t) => {
  const store = await repository(t);
  const saved = await store.save({ mode: 'demo', messages, accessToken: 'SECRET_MUST_NOT_PERSIST', apiKey: 'PRIVATE_MODEL_KEY' });
  const rows = { summaries: await store.database.summaries.toArray(), bodies: await store.database.bodies.toArray() };
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_MUST_NOT_PERSIST|PRIVATE_MODEL_KEY|accessToken|apiKey/);
  assert.doesNotMatch(exportConversation(saved.mode, saved.messages), /"request"/);
});

test('malformed or oversized snapshots fail before any write', async (t) => {
  const store = await repository(t);
  for (const bad of [[], [{ role: 'system', content: 'not allowed' }], [{ role: 'user', content: 'x'.repeat(32_001) }],
    Array.from({ length: 30 }, () => ({ role: 'assistant', status: 'sent', content: '中'.repeat(32_000) }))]) {
    await assert.rejects(store.save({ mode: 'demo', messages: bad }), ConversationStoreError);
  }
  assert.equal(await store.database.summaries.count(), 0);
});

test('corrupt persisted content is rejected without deleting or replacing stored data', async (t) => {
  const store = await repository(t);
  const saved = await store.save({ mode: 'demo', messages });
  await store.database.bodies.put({ sessionId: saved.id, messages: [{ role: 'system', content: 'untrusted' }] });
  await assert.rejects(store.load(saved.id), ConversationStoreError);
  assert.equal(await store.database.summaries.count(), 1);
});

test('two concurrent saves of the same revision have one winner and cannot mix snapshots', async (t) => {
  const store = await repository(t);
  const first = await store.save({ mode: 'live', messages });
  const variants = ['one', 'two'].map(content => [{ role: 'user', status: 'sent', content }, { role: 'assistant', status: 'sent', content: `reply-${content}` }]);
  const results = await Promise.allSettled(variants.map(messages => store.save({ id: first.id, expectedRevision: 1, mode: 'live', messages })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason instanceof ConversationConflictError).length, 1);
  const loaded = await store.load(first.id);
  assert.equal(loaded.messages[1].content, `reply-${loaded.messages[0].content}`);
  assert.equal(loaded.revision, 2);
});

test('the archive limit preserves existing records and refuses an unbounded create', async (t) => {
  const store = await repository(t);
  for (let index = 0; index < 100; index += 1) await store.save({ mode: 'demo', messages });
  await assert.rejects(store.save({ mode: 'demo', messages }), ConversationStoreError);
  assert.equal(await store.database.summaries.count(), 100);
  assert.equal(await store.database.bodies.count(), 100);
});

test('a damaged revision record cannot be repaired by silently overwriting it', async (t) => {
  const store = await repository(t);
  const first = await store.save({ mode: 'live', messages });
  await store.database.summaries.update(first.id, { revision: -1 });
  await assert.rejects(store.save({ id: first.id, expectedRevision: -1, mode: 'live', messages }), ConversationStoreError);
  assert.equal((await store.database.summaries.get(first.id)).revision, -1);
});
