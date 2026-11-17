import assert from 'node:assert/strict';
import test from 'node:test';
import { chatReducer, initialChatState } from '../lib/chat-state.ts';
import { buildConversation } from '../lib/chat-client.ts';

test('restoring a conversation settles partial states and ignores a previous in-flight request', () => {
  let state = chatReducer(initialChatState, { type: 'begin', id: 8, text: 'in flight' });
  state = chatReducer(state, { type: 'restore', messages: [
    { role: 'user', content: 'saved', status: 'sent', request: 1 },
    { role: 'assistant', content: 'saved reply', status: 'sent', request: 1 },
    { role: 'user', content: 'unfinished', status: 'pending', request: 8 },
    { role: 'assistant', content: 'partial', status: 'streaming', request: 8 },
  ] });
  const restored = state;
  for (const type of ['delta', 'complete', 'fail']) {
    state = chatReducer(state, { type, id: 8, content: 'late result', error: 'late error' });
    assert.equal(state, restored);
  }
  assert.equal(state.activeId, null);
  assert.equal(state.messages[2].status, 'failed');
  assert.equal(state.messages[3].status, 'incomplete');
  assert.deepEqual(buildConversation(state.messages, 'next').map(item => item.content), ['saved', 'saved reply', 'next']);
});

test('reusing request IDs after reloading cannot rewrite restored messages', () => {
  let state = chatReducer(initialChatState, { type: 'restore', messages: [
    { role: 'user', content: 'old', status: 'sent', request: 1 },
    { role: 'assistant', content: 'old reply', status: 'sent', request: 1 },
  ] });
  state = chatReducer(state, { type: 'begin', id: 1, text: 'new' });
  state = chatReducer(state, { type: 'complete', id: 1, content: 'new reply' });
  assert.deepEqual(state.messages.map(item => item.content), ['old', 'old reply', 'new', 'new reply']);
});
