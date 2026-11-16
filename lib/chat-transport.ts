import { legacyReplySchema, publicErrorSchema } from './chat-contract.ts';
import { MAX_EVENT_CHARS, MAX_REPLY_CHARS } from './chat-protocol.ts';

export class ChatResponseError extends Error {
  readonly requestId: string | undefined;
  readonly code: string;
  constructor(message: string, requestId?: string, code = 'invalid_response') {
    super(message);
    this.name = 'ChatResponseError';
    this.requestId = requestId;
    this.code = code;
  }
}

function parseEvent(frame: string): { event: string; data: Record<string, unknown> } | null {
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
  if (!data.length) return null;
  const parsed: unknown = JSON.parse(data.join('\n'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('invalid event');
  return { event, data: parsed as Record<string, unknown> };
}

// Uses fetch rather than EventSource: POST and the private Authorization header
// stay supported. A clean TCP EOF is not proof of application-level completion.
export interface ReadReplyOptions {
  onDelta?: (content: string) => void;
  signal?: AbortSignal;
}

export async function readChatResponse(
  response: Response,
  { onDelta = () => {}, signal }: ReadReplyOptions = {},
): Promise<string> {
  let requestId = response.headers.get('x-request-id') || undefined;
  const fail = (message = '回复传输中断，请重试', code?: string) =>
    new ChatResponseError(message, requestId, code);
  if (!response.ok) {
    const parsed = publicErrorSchema.safeParse(await response.json().catch(() => null));
    throw fail(
      parsed.success ? parsed.data.error : `请求失败（HTTP ${response.status}）`,
      parsed.success ? parsed.data.code : undefined,
    );
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    const parsed = legacyReplySchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw fail('服务返回了无效响应，请重试');
    signal?.throwIfAborted();
    return parsed.data.content;
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
          throw fail(
            typeof data.error === 'string' ? data.error : undefined,
            typeof data.code === 'string' ? data.code : undefined,
          );
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
