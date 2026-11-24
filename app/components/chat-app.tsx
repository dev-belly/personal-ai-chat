'use client';

import { useState, useRef, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { MAX_INPUT_CHARS, shouldSubmit } from '../../lib/chat-client.ts';
import { useChat } from '../hooks/use-chat';
import type { ChatMode } from '../../lib/chat-contract.ts';
import ConversationHistory from './conversation-history';
import { useConversationHistory } from '../hooks/use-conversation-history';

const MessageMarkdown = dynamic(() => import('./message-markdown'), { ssr: false });

export default function ChatApp() {
  const [mode, setMode] = useState<ChatMode>('demo');
  const [accessToken, setAccessToken] = useState('');
  const [service, setService] = useState<'checking' | 'ready' | 'unconfigured' | 'unavailable'>(
    'checking',
  );
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false);
  const viewportRef = useRef<HTMLElement>(null);
  const followLatest = useRef(true);
  const { messages, loading, input, inputError, setInput, sendMessage, clearChat, restoreConversation, cancelRequest } = useChat({
    mode,
    accessToken,
    ready: service === 'ready',
  });
  const history = useConversationHistory({ mode, messages, draft: input,
    restore: (saved) => {
      followLatest.current = true;
      restoreConversation(saved.messages);
      setMode(saved.mode);
    },
    clear: clearChat,
  });
  function newConversation(nextMode: ChatMode = mode) {
    if (!history.confirmDiscard()) return;
    followLatest.current = true;
    history.resetSelection();
    clearChat();
    setMode(nextMode);
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followLatest.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, loading]);
  useEffect(() => {
    try {
      setAccessToken(sessionStorage.getItem('chat-access-token') || '');
    } catch {
      setStorageWarning(true);
    }
  }, []);
  useEffect(() => {
    if (mode !== 'live') return;
    const controller = new AbortController();
    setService('checking');
    fetch('/api/chat', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('status unavailable');
        const status = await response.json();
        if (!controller.signal.aborted)
          setService(status.configured === true ? 'ready' : 'unconfigured');
      })
      .catch(() => {
        if (!controller.signal.aborted) setService('unavailable');
      });
    return () => controller.abort();
  }, [mode, statusAttempt]);
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [input]);

  function updateAccessToken(value: string) {
    setAccessToken(value);
    try {
      if (value) sessionStorage.setItem('chat-access-token', value);
      else sessionStorage.removeItem('chat-access-token');
    } catch {
      setStorageWarning(true);
    }
  }

  const canSend = mode === 'demo' || (service === 'ready' && Boolean(accessToken.trim()));
  function submitMessage(retry?: string) {
    followLatest.current = true;
    sendMessage(retry);
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Personal AI Chat</h1>
        <div className="header-actions">
          <button className="clear-btn" aria-expanded={history.open} onClick={() => history.setOpen(!history.open)}>会话历史</button>
          <select
            aria-label="聊天模式"
            value={mode}
            onChange={(event) => newConversation(event.target.value === 'live' ? 'live' : 'demo')}
          >
            <option value="demo">本地模拟</option>
            <option value="live">真实服务</option>
          </select>
          {mode === 'live' && (
            <input
              className="access-token"
              type="password"
              value={accessToken}
              onChange={(event) => updateAccessToken(event.target.value)}
              placeholder="访问口令（非 API Key）"
              aria-label="Chat access token"
              autoComplete="off"
              maxLength={256}
            />
          )}
          {messages.length > 0 && (
            <button className="clear-btn" onClick={() => newConversation()}>
              新建会话
            </button>
          )}
        </div>
      </header>
      <div className="mode-notice" role="status">
        {mode === 'demo'
          ? '本地模拟：固定示例回复，无模型调用，消息不上传。'
          : service === 'checking'
            ? '正在检查服务配置…'
            : service === 'ready'
              ? '真实服务已配置。输入独立访问口令后可发送；消息将交给配置的模型服务。'
              : service === 'unconfigured'
                ? '真实服务尚未配置。部署者需设置 API Key、模型 ID 和访问口令；现在仍可切换本地模拟。'
                : '无法检查服务状态，请重试或切换本地模拟。'}
        {mode === 'live' && service !== 'ready' && service !== 'checking' && (
          <button className="clear-btn" onClick={() => setStatusAttempt((value) => value + 1)}>
            重新检查
          </button>
        )}
        {storageWarning && <p>浏览器禁止会话存储，访问口令仅保留在当前页面内。</p>}
      </div>
      <ConversationHistory history={history} />
      {messages.length > 0 && <div className="conversation-actions">
        <button className="clear-btn" disabled={loading || history.busy} onClick={history.save}>
          {history.selected ? '更新保存' : '保存会话'}
        </button>
        <button className="clear-btn" disabled={loading || history.busy} onClick={history.download}>导出会话</button>
        <span>仅在点击保存后保留到本浏览器</span>
      </div>}
      {(history.notice || history.error || history.busy) && <div className="history-status" role="status">
        {history.busy ? '正在处理会话…' : history.error || history.notice}
      </div>}
      <main className="chat-container" ref={viewportRef} aria-live="polite" aria-busy={loading}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          followLatest.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
        }}
      >
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="logo">&#10022;</div>
            <p>{mode === 'demo' ? '无需密钥，先体验聊天流程' : '连接你的私人模型服务'}</p>
            {mode === 'demo' ? (
              <button className="clear-btn" disabled={history.busy} onClick={() => setInput('帮我制定学习计划')}>
                试试：帮我制定学习计划
              </button>
            ) : (
              <p className="access-hint">访问口令由部署者提供，请勿在此填写上游 API Key。</p>
            )}
          </div>
        ) : (
          <div className="messages">
            {messages.map((message, index) => (
              <div key={index} className={'message ' + message.role}>
                <div className="message-content">
                  {message.role === 'user'
                    ? '你'
                    : message.role === 'assistant'
                      ? mode === 'demo'
                        ? '本地模拟回复'
                        : 'AI'
                      : '提示'}
                  {message.status === 'streaming' && ' · 正在回复'}
                  {message.status === 'incomplete' && ' · 未完成回复'}
                </div>
                <div className="message-text">
                  {message.role === 'assistant' ? <MessageMarkdown content={message.content} streaming={message.status === 'streaming'} />
                    : message.content.split('\n').map((line, lineIndex) => <p key={lineIndex}>{line || '\u00A0'}</p>)}
                </div>
                {message.requestId && (
                  <small className="input-hint">请求编号：{message.requestId}</small>
                )}
                {message.retryText && index === messages.length - 1 && (
                  <button
                    className="clear-btn retry-btn"
                    disabled={loading || history.busy || !canSend}
                    onClick={() => submitMessage(message.retryText)}
                  >
                    重试这条消息
                  </button>
                )}
              </div>
            ))}
            {loading && !messages.some((message) => message.status === 'streaming') && (
              <div className="message assistant">
                <div className="message-content">
                  {mode === 'demo' ? '加载模拟回复' : '等待模型回复'}
                </div>
                <div className="message-text typing">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              </div>
            )}
          </div>
        )}
      </main>
      <footer className="input-area">
        {inputError && <p className="input-hint" role="alert">{inputError}</p>}
        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            aria-label="消息内容"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (!history.busy && shouldSubmit(event)) {
                event.preventDefault();
                submitMessage();
              }
            }}
            placeholder="输入消息… Enter 发送，Shift+Enter 换行"
            rows={1}
            maxLength={MAX_INPUT_CHARS}
            disabled={loading || history.busy}
          />
          {loading ? (
            <button className="clear-btn" onClick={cancelRequest}>
              取消
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={() => submitMessage()}
              disabled={!input.trim() || history.busy || !canSend}
              aria-label="发送消息"
            >
              发送
            </button>
          )}
        </div>
        <p className="input-hint">
          {mode === 'demo'
            ? '模拟内容不代表真实 AI 能力。'
            : '请求仅携带最近的完整对话轮次，最多 40 条 / 32,000 字符。'}
        </p>
      </footer>
    </div>
  );
}
