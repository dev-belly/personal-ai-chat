import { DefaultChatTransport, readUIMessageStream } from 'ai';
import type { UIMessageChunk } from 'ai';
import { publicErrorSchema, requestMetadataSchema, toUIMessages } from './chat-contract.ts';
import type { ChatUIMessage, TextMessage } from './chat-contract.ts';
import { MAX_EVENT_CHARS, MAX_REPLY_CHARS } from './chat-protocol.ts';
import { ChatResponseError } from './chat-transport.ts';
import type { ReadReplyOptions } from './chat-transport.ts';

// Bound a malformed SSE frame before the SDK's parser accumulates it. Byte
// framing is independent of split UTF-8 characters, which the SDK decodes.
function boundedFrames(): TransformStream<Uint8Array, Uint8Array> {
  let bytes = 0;
  let previous = -1;
  let beforePrevious = -1;
  return new TransformStream({
    transform(chunk, controller) {
      for (const byte of chunk) {
        bytes += 1;
        if (bytes > MAX_EVENT_CHARS) throw new Error('UI stream frame exceeds budget');
        if (byte === 10 && (previous === 10 || (previous === 13 && beforePrevious === 10)))
          bytes = 0;
        beforePrevious = previous;
        previous = byte;
      }
      controller.enqueue(chunk);
    },
  });
}

interface SendUIOptions extends ReadReplyOptions {
  messages: TextMessage[];
  accessToken: string;
  api?: string;
  fetch?: typeof globalThis.fetch;
}

export async function sendUIChat({
  messages,
  accessToken,
  signal,
  onDelta = () => {},
  api = '/api/chat/ui',
  fetch: fetchImplementation = globalThis.fetch,
}: SendUIOptions): Promise<string> {
  let requestId: string | undefined;
  const fail = (message = '回复传输中断，请重试', code?: string) =>
    new ChatResponseError(message, requestId, code);
  const transport = new DefaultChatTransport<ChatUIMessage>({
    api,
    headers: { Authorization: `Bearer ${accessToken.trim()}` },
    prepareSendMessagesRequest: ({ messages }) => ({ body: { messages } }),
    fetch: async (input, init) => {
      const response = await fetchImplementation(input, init);
      requestId = response.headers.get('x-request-id') || undefined;
      if (!response.ok) {
        const parsed = publicErrorSchema.safeParse(await response.json().catch(() => null));
        throw fail(
          parsed.success ? parsed.data.error : `请求失败（HTTP ${response.status}）`,
          parsed.success ? parsed.data.code : undefined,
        );
      }
      if (!response.body || response.headers.get('x-vercel-ai-ui-message-stream') !== 'v1')
        throw fail('服务返回了无效的消息流，请重试');
      return new Response(response.body.pipeThrough(boundedFrames()), {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  let started = false;
  let finished = false;
  let totalChars = 0;
  let content = '';
  const inspect = new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      signal?.throwIfAborted();
      if (chunk.type === 'start' || chunk.type === 'message-metadata') {
        const parsed = requestMetadataSchema.safeParse(chunk.messageMetadata);
        if (!parsed.success || (requestId && parsed.data.requestId !== requestId)) throw fail();
        requestId = parsed.data.requestId;
        if (chunk.type === 'start') {
          if (started || chunk.messageId !== requestId) throw fail();
          started = true;
        }
      } else if (chunk.type === 'error') throw fail(chunk.errorText);
      else if (chunk.type === 'abort') throw fail('回复已中止，请重试');
      else if (chunk.type === 'text-delta') {
        if (!started || finished) throw fail();
        totalChars += chunk.delta.length;
        if (totalChars > MAX_REPLY_CHARS) throw fail('回复内容过长，请重试');
      } else if (chunk.type === 'finish') {
        if (
          !started ||
          finished ||
          chunk.finishReason === 'error' ||
          chunk.finishReason === 'interrupted'
        )
          throw fail();
        finished = true;
      }
      controller.enqueue(chunk);
    },
  });
  try {
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'page-session',
      messageId: undefined,
      messages: toUIMessages(messages),
      abortSignal: signal,
    });
    for await (const message of readUIMessageStream<ChatUIMessage>({
      stream: stream.pipeThrough(inspect),
      terminateOnError: true,
    })) {
      const next = message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      if (next !== content) {
        content = next;
        onDelta(content);
      }
    }
    signal?.throwIfAborted();
    if (!started || !finished || !content.trim()) throw fail();
    return content;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
    if (error instanceof ChatResponseError || (error instanceof TypeError && !requestId))
      throw error;
    throw fail();
  }
}
