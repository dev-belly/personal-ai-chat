'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import {
  buildConversation,
  localDemoReply,
  MAX_INPUT_CHARS,
  waitForDemo,
} from '../../lib/chat-client.mjs';
import { chatReducer, initialChatState } from '../../lib/chat-state.mjs';
import { readChatResponse } from '../../lib/chat-transport.mjs';

export function useChat({ mode, accessToken, ready }) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [input, setInput] = useState('');
  const activeRequest = useRef(null);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
      activeRequest.current?.abort();
    },
    [],
  );

  async function sendMessage(override) {
    const text = (typeof override === 'string' ? override : input).trim();
    if (!text || text.length > MAX_INPUT_CHARS || activeRequest.current) return;
    if (mode === 'live' && (!accessToken.trim() || !ready)) return;
    const history = buildConversation(state.messages, text);
    const controller = new AbortController();
    activeRequest.current = controller;
    const id = ++generation.current;
    dispatch({ type: 'begin', id, text });
    setInput('');
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    try {
      let content;
      if (mode === 'demo') {
        await waitForDemo(controller.signal);
        content = localDemoReply(text);
      } else {
        const response = await fetch('/api/chat', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${accessToken.trim()}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ messages: history }),
        });
        content = await readChatResponse(response, {
          signal: controller.signal,
          onDelta: (content) => {
            if (id === generation.current) dispatch({ type: 'delta', id, content });
          },
        });
      }
      if (id === generation.current) dispatch({ type: 'complete', id, content });
    } catch (error) {
      if (id !== generation.current) return;
      const message = controller.signal.aborted
        ? timedOut
          ? '请求超时，请重试。'
          : '已取消本次请求。'
        : error instanceof TypeError
          ? '网络连接失败，请检查连接后重试。'
          : error.message;
      dispatch({ type: 'fail', id, error: message, text, requestId: error.requestId });
    } finally {
      clearTimeout(timeout);
      if (id === generation.current) activeRequest.current = null;
    }
  }

  function clearChat() {
    generation.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    dispatch({ type: 'clear' });
    setInput('');
  }

  return {
    messages: state.messages,
    loading: state.activeId !== null,
    input,
    setInput,
    sendMessage,
    clearChat,
    cancelRequest: () => activeRequest.current?.abort(),
  };
}
