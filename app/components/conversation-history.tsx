'use client';

import type { useConversationHistory } from '../hooks/use-conversation-history';
export type ConversationHistoryState = ReturnType<typeof useConversationHistory>;

export default function ConversationHistory({ history }: { history: ConversationHistoryState }) {
  if (!history.open) return null;
  return <section className="conversation-history" aria-label="会话历史">
    <div className="history-heading"><h2>会话历史</h2><span>仅保存在此浏览器</span></div>
    <input type="search" aria-label="搜索会话标题" placeholder="搜索会话标题"
      value={history.search} onChange={(event) => history.setSearch(event.target.value)} />
    {history.reading ? <p>正在读取会话…</p> : history.unavailable
      ? <p role="status">浏览器暂时无法读取本机会话，当前聊天仍可使用。</p>
      : history.items.length === 0 ? <p>{history.search ? '没有找到匹配的会话。' : '尚未保存会话；聊天后点击“保存会话”。'}</p>
      : <ul className="history-list">{history.items.map((row) => <li key={row.id}>
        <button type="button" className="history-open" disabled={history.busy} onClick={() => history.load(row.id)}>
          <span className="history-title">{row.title}</span>
          <small>{row.mode === 'demo' ? '本地模拟' : '真实服务'} · {row.messageCount} 条消息</small>
        </button>
        <button type="button" className="clear-btn" aria-label={`删除会话：${row.title}`} disabled={history.busy}
          onClick={() => history.remove(row)}>删除</button>
      </li>)}</ul>}
  </section>;
}
