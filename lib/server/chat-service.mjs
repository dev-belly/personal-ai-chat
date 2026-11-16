import { MAX_REPLY_CHARS } from '../chat-protocol.mjs';

export class ChatError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    this.status = status;
  }
}

export function validateReply(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new ChatError('上游服务未返回有效文本，请重试', 'empty_reply');
  }
  if (content.length > MAX_REPLY_CHARS) {
    throw new ChatError('回复内容过长，请缩小问题范围后重试', 'reply_too_large');
  }
  return content;
}

// The service consumes text, not vendor event shapes. An interrupted provider
// iterator must throw rather than silently completing a partial reply.
export async function* validateTextStream(source) {
  let length = 0;
  let hasText = false;
  for await (const delta of source) {
    if (typeof delta !== 'string') throw new ChatError('上游响应格式异常，请重试', 'invalid_reply');
    length += delta.length;
    if (length > MAX_REPLY_CHARS) {
      throw new ChatError('回复内容过长，请缩小问题范围后重试', 'reply_too_large');
    }
    hasText ||= Boolean(delta.trim());
    if (delta) yield delta;
  }
  if (!hasText) throw new ChatError('上游服务未返回有效文本，请重试', 'empty_reply');
}

export function publicChatError(error, timedOut = false) {
  if (timedOut || error?.name === 'APIConnectionTimeoutError') {
    return { error: '请求超时，请重试', code: 'upstream_timeout', status: 504 };
  }
  if (error instanceof ChatError) {
    return { error: error.message, code: error.code, status: error.status };
  }
  if (error?.status === 401) {
    return { error: '上游服务认证失败', code: 'upstream_auth', status: 502 };
  }
  if (error?.status === 429) {
    return { error: '请求过于频繁，请稍后再试', code: 'upstream_rate_limit', status: 429 };
  }
  return { error: '上游服务暂时不可用，请重试', code: 'upstream_unavailable', status: 502 };
}

// Also covers a stream that stalls after sending HTTP headers.
export function createRequestScope(parentSignal, timeoutMs = 50_000) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    abort,
    dispose() {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
    },
  };
}
