"use client";

import { useState, useRef, useEffect } from "react";
import { buildConversation, localDemoReply, MAX_INPUT_CHARS, shouldSubmit, waitForDemo } from "../lib/chat-client.mjs";
import "./globals.css";

export default function Home() {
  const [mode, setMode] = useState("demo");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [service, setService] = useState("checking");
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false);
  const activeRequest = useRef(null);
  const generation = useRef(0);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => {
    try { setAccessToken(sessionStorage.getItem("chat-access-token") || ""); }
    catch { setStorageWarning(true); }
    return () => { generation.current += 1; activeRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    if (mode !== "live") return;
    const controller = new AbortController();
    setService("checking");
    fetch("/api/chat", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("status unavailable");
        const status = await response.json();
        if (!controller.signal.aborted) setService(status.configured === true ? "ready" : "unconfigured");
      })
      .catch(() => { if (!controller.signal.aborted) setService("unavailable"); });
    return () => controller.abort();
  }, [mode, statusAttempt]);
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  async function sendMessage(override) {
    const text = (typeof override === "string" ? override : input).trim();
    if (!text || text.length > MAX_INPUT_CHARS || activeRequest.current) return;
    if (mode === "live" && (!accessToken.trim() || service !== "ready")) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const requestId = ++generation.current;
    const userMsg = { role: "user", content: text, status: "pending", id: requestId };
    const history = buildConversation(messages, text);
    setMessages((previous) => [...previous, userMsg]);
    setInput("");
    setLoading(true);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
    try {
      let content;
      if (mode === "demo") {
        await waitForDemo(controller.signal);
        content = localDemoReply(text);
      } else {
        const response = await fetch("/api/chat", {
          method: "POST", signal: controller.signal,
          headers: { Authorization: `Bearer ${accessToken.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `请求失败（HTTP ${response.status}）`);
        if (typeof data?.content !== "string" || !data.content.trim()) throw new Error("服务返回了无效响应，请重试");
        content = data.content;
      }
      if (requestId !== generation.current) return;
      setMessages((previous) => [...previous.map((item) => item.id === requestId ? { ...item, status: "sent" } : item), { role: "assistant", content }]);
    } catch (error) {
      if (requestId !== generation.current) return;
      const content = controller.signal.aborted
        ? (timedOut ? "请求超时，请重试。" : "已取消本次请求。")
        : (error instanceof TypeError ? "网络连接失败，请检查连接后重试。" : error.message);
      setMessages((previous) => [...previous.map((item) => item.id === requestId ? { ...item, status: "failed" } : item), { role: "error", content, retryText: text }]);
    } finally {
      clearTimeout(timeout);
      if (requestId === generation.current) { activeRequest.current = null; setLoading(false); }
    }
  }

  function clearChat() {
    generation.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setLoading(false);
    setMessages([]);
    setInput("");
  }

  function updateAccessToken(value) {
    setAccessToken(value);
    try {
      if (value) sessionStorage.setItem("chat-access-token", value);
      else sessionStorage.removeItem("chat-access-token");
    } catch { setStorageWarning(true); }
  }

  const canSend = mode === "demo" || (service === "ready" && Boolean(accessToken.trim()));
  return (
    <div className="app">
      <header className="header">
        <h1>Personal AI Chat</h1>
        <div className="header-actions">
          <select aria-label="聊天模式" value={mode} onChange={(event) => { clearChat(); setMode(event.target.value); }}>
            <option value="demo">本地模拟</option><option value="live">真实服务</option>
          </select>
          {mode === "live" && <input className="access-token" type="password" value={accessToken} onChange={(event) => updateAccessToken(event.target.value)} placeholder="访问口令（非 API Key）" aria-label="Chat access token" autoComplete="off" maxLength={256} />}
          {messages.length > 0 && <button className="clear-btn" onClick={clearChat}>新建会话</button>}
        </div>
      </header>
      <div className="mode-notice" role="status">
        {mode === "demo" ? "本地模拟：固定示例回复，无模型调用，消息不上传。" : (
          service === "checking" ? "正在检查服务配置…" : service === "ready" ? "真实服务已配置。输入独立访问口令后可发送；消息将交给配置的模型服务。" :
          service === "unconfigured" ? "真实服务尚未配置。部署者需设置 API Key、模型 ID 和访问口令；现在仍可切换本地模拟。" : "无法检查服务状态，请重试或切换本地模拟。"
        )}
        {mode === "live" && service !== "ready" && service !== "checking" && <button className="clear-btn" onClick={() => setStatusAttempt((value) => value + 1)}>重新检查</button>}
        {storageWarning && <p>浏览器禁止会话存储，访问口令仅保留在当前页面内。</p>}
      </div>
      <main className="chat-container" aria-live="polite" aria-busy={loading}>
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="logo">&#10022;</div>
            <p>{mode === "demo" ? "无需密钥，先体验聊天流程" : "连接你的私人模型服务"}</p>
            {mode === "demo" ? <button className="clear-btn" onClick={() => setInput("帮我制定学习计划")}>试试：帮我制定学习计划</button> : <p className="access-hint">访问口令由部署者提供，请勿在此填写上游 API Key。</p>}
          </div>
        ) : (
          <div className="messages">
            {messages.map((message, index) => (
              <div key={index} className={"message " + message.role}>
                <div className="message-content">{message.role === "user" ? "你" : message.role === "assistant" ? (mode === "demo" ? "本地模拟回复" : "AI") : "提示"}</div>
                <div className="message-text">{message.content.split("\n").map((line, lineIndex) => <p key={lineIndex}>{line || "\u00A0"}</p>)}</div>
                {message.retryText && index === messages.length - 1 && <button className="clear-btn retry-btn" disabled={loading || !canSend} onClick={() => sendMessage(message.retryText)}>重试这条消息</button>}
              </div>
            ))}
            {loading && <div className="message assistant"><div className="message-content">{mode === "demo" ? "加载模拟回复" : "等待模型回复"}</div><div className="message-text typing"><span className="dot"/><span className="dot"/><span className="dot"/></div></div>}
            <div ref={messagesEndRef}/>
          </div>
        )}
      </main>
      <footer className="input-area">
        <div className="input-wrapper">
          <textarea ref={textareaRef} aria-label="消息内容" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (shouldSubmit(event)) { event.preventDefault(); sendMessage(); } }} placeholder="输入消息… Enter 发送，Shift+Enter 换行" rows={1} maxLength={MAX_INPUT_CHARS} disabled={loading}/>
          {loading ? <button className="clear-btn" onClick={() => activeRequest.current?.abort()}>取消</button> : <button className="send-btn" onClick={() => sendMessage()} disabled={!input.trim() || !canSend} aria-label="Send message">↑</button>}
        </div>
        <p className="input-hint">{mode === "demo" ? "模拟内容不代表真实 AI 能力。" : "请求仅携带最近的完整对话轮次，最多 40 条 / 32,000 字符。"}</p>
      </footer>
    </div>
  );
}
