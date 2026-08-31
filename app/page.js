"use client";

import { useState, useRef, useEffect } from "react";
import "./globals.css";

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setAccessToken(sessionStorage.getItem("chat-access-token") || "");
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  async function sendMessage() {
    const text = input.trim();
    const token = accessToken.trim();
    if (!text || !token || loading) return;

    const userMsg = { role: "user", content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: newMessages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Request failed (" + res.status + ")");
      }

      const data = await res.json();
      if (typeof data.content !== "string") {
        throw new Error("服务返回了无效响应");
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.content },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "error", content: err.message },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function clearChat() {
    setMessages([]);
  }

  function updateAccessToken(value) {
    setAccessToken(value);
    if (value) {
      sessionStorage.setItem("chat-access-token", value);
    } else {
      sessionStorage.removeItem("chat-access-token");
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Claude Chat</h1>
        <div className="header-actions">
          <input
            className="access-token"
            type="password"
            value={accessToken}
            onChange={(event) => updateAccessToken(event.target.value)}
            placeholder="Access token"
            aria-label="Chat access token"
            autoComplete="off"
            maxLength={256}
          />
          {messages.length > 0 && (
            <button className="clear-btn" onClick={clearChat}>
              New Chat
            </button>
          )}
        </div>
      </header>

      <main className="chat-container">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="logo">&#10022;</div>
            <p>Start chatting with Claude</p>
            {!accessToken.trim() && (
              <p className="access-hint">Enter your private access token first.</p>
            )}
          </div>
        ) : (
          <div className="messages">
            {messages.map((msg, i) => (
              <div key={i} className={"message " + msg.role}>
                <div className="message-content">
                  {msg.role === "user"
                    ? "You"
                    : msg.role === "assistant"
                      ? "Claude"
                      : "Warning"}
                </div>
                <div className="message-text">
                  {msg.content.split("\n").map((line, j) => (
                    <p key={j}>{line || "\u00A0"}</p>
                  ))}
                </div>
              </div>
            ))}
            {loading && (
              <div className="message assistant">
                <div className="message-content">Claude</div>
                <div className="message-text typing">
                  <span className="dot"></span>
                  <span className="dot"></span>
                  <span className="dot"></span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      <footer className="input-area">
        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
            rows={1}
            disabled={loading}
          />
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={loading || !input.trim() || !accessToken.trim()}
            aria-label="Send message"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
}
