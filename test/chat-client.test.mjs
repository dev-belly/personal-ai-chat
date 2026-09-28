import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversation, localDemoReply, MAX_INPUT_CHARS, shouldSubmit, waitForDemo } from '../lib/chat-client.mjs';
import { authorizeRequest, validateMessages } from '../lib/chat-validation.mjs';

test('retry and following requests exclude failed user attempts', () => {
  const previous = [
    { role: 'user', content: 'first', status: 'sent' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'failed', status: 'failed' },
    { role: 'error', content: 'network error' },
  ];
  const next = buildConversation(previous, 'retry');
  assert.deepEqual(next.map((item) => item.content), ['first', 'reply', 'retry']);
  assert.equal(validateMessages(next).ok, true);
});

test('long sessions retain complete recent turns within server limits', () => {
  const previous = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(4_000), status: 'sent',
  }));
  const next = buildConversation(previous, 'continue');
  assert.equal(validateMessages(next).ok, true);
  assert.equal(next[0].role, 'user');
  assert.ok(next.length < 40);
});

test('a long assistant reply remains usable on the following turn', () => {
  const previous = [
    { role: 'user', content: 'Explain the plan', status: 'sent' },
    { role: 'assistant', content: 'reply '.repeat(2_000) },
  ];
  const next = buildConversation(previous, 'Continue');
  assert.equal(validateMessages(next).ok, true);
  assert.equal(next[1].content.length, 12_000);
});

test('oversized input rejects immediately', () => {
  assert.throws(() => buildConversation([], 'x'.repeat(MAX_INPUT_CHARS + 1)));
});

test('Enter submits only outside composition and Shift+Enter', () => {
  assert.equal(shouldSubmit({ key: 'Enter' }), true);
  assert.equal(shouldSubmit({ key: 'Enter', shiftKey: true }), false);
  assert.equal(shouldSubmit({ key: 'Enter', nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldSubmit({ key: 'Enter', keyCode: 229 }), false);
});

test('demo returns explicit fixed samples without a network call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('demo must stay offline'); };
  try {
    assert.match(localDemoReply('学习计划'), /本地模拟 · 固定示例/);
    assert.equal(localDemoReply('学习计划'), localDemoReply('学习计划'));
    assert.match(localDemoReply('代码测试'), /没有调用 AI 模型/);
    const controller = new AbortController();
    const waiting = waitForDemo(controller.signal);
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
  } finally { globalThis.fetch = originalFetch; }
});

test('same-character-length non-ASCII token is rejected without throwing', () => {
  assert.equal(authorizeRequest('Bearer ' + 'é'.repeat(32), 'x'.repeat(32)), false);
});
