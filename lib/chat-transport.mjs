import { MAX_EVENT_CHARS, MAX_REPLY_CHARS } from './chat-protocol.mjs';

export class ChatResponseError extends Error {
  constructor(message, requestId, code = 'invalid_response') {
    super(message);
    this.name = 'ChatResponseError';
    this.requestId = requestId;
    this.code = code;
  }
}

function parseEvent(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: JSON.parse(data.join('\n')) } : null;
}

// Uses fetch rather than EventSource: POST and the private Authorization header
// stay supported. A clean TCP EOF is not proof of application-level completion.
export async function readChatResponse(response, { onDelta = () => {}, signal } = {}) {
  let requestId = response.headers.get('x-request-id') || undefined;
  const fail = (message = '回复传输中断，请重试', code) =>
    new ChatResponseError(message, requestId, code);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw fail(
      typeof data?.error === 'string' ? data.error : `请求失败（HTTP ${response.status}）`,
      data?.code,
    );
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    const data = await response.json().catch(() => null);
    if (
      typeof data?.content !== 'string' ||
      !data.content.trim() ||
      data.content.length > MAX_REPLY_CHARS
    ) {
      throw fail('服务返回了无效响应，请重试');
    }
    signal?.throwIfAborted();
    return data.content;
  }
  if (!response.body) throw fail();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let content = '';
  let started = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (frame.length > MAX_EVENT_CHARS) throw fail('服务返回了过大的数据帧，请重试');
        const item = parseEvent(frame);
        if (!item) continue;
        const data = item.data;
        if (item.event === 'start') {
          if (started || typeof data?.requestId !== 'string') throw fail();
          if (requestId && data.requestId !== requestId) throw fail();
          started = true;
          requestId = data.requestId;
        } else if (item.event === 'text-delta') {
          if (!started || typeof data?.delta !== 'string') throw fail();
          content += data.delta;
          if (content.length > MAX_REPLY_CHARS) throw fail('回复内容过长，请重试');
          onDelta(content);
        } else if (item.event === 'error') {
          throw fail(typeof data?.error === 'string' ? data.error : undefined, data?.code);
        } else if (item.event === 'done') {
          if (!started || !content.trim()) throw fail('上游服务未返回有效文本，请重试');
          return content;
        }
        // Unknown events are ignored for forward-compatible additions.
      }
      if (buffer.length > MAX_EVENT_CHARS) throw fail('服务返回了过大的数据帧，请重试');
      if (done) throw fail();
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
    if (error instanceof ChatResponseError) throw error;
    throw fail();
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
