import { randomUUID } from 'node:crypto';
import { createUIMessageStreamResponse } from 'ai';
import type { UIMessageChunk } from 'ai';
import { authorizeRequest, readJsonBody, RequestBodyError } from '../chat-validation.ts';
import { validateChatPayload } from '../chat-contract.ts';
import type { ChatProvider, WireFormat } from '../chat-contract.ts';
import { encodeChatEvent } from '../chat-protocol.ts';
import { createModelProvider, resolveChatConfiguration } from './model-provider.ts';
import type { ChatEnvironment, ModelConfiguration } from './model-provider.ts';
import {
  createRequestScope,
  publicChatError,
  validateReply,
  validateTextStream,
} from './chat-service.ts';
import type { PublicChatFailure, RequestScope } from './chat-service.ts';

export function isChatConfigured(env: ChatEnvironment = process.env): boolean {
  return Boolean(resolveChatConfiguration(env));
}
export function wantsEventStream(request: Request): boolean {
  return (request.headers.get('accept') || '').split(',').some((entry) => {
    const [type, ...parameters] = entry.trim().toLowerCase().split(';');
    return (
      type?.trim() === 'text/event-stream' &&
      !parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?$/.test(parameter.trim()))
    );
  });
}

interface HandlerOptions {
  env?: () => ChatEnvironment;
  providerFactory?: (config: ModelConfiguration) => ChatProvider;
  timeoutMs?: number;
  format?: WireFormat;
  log?: (entry: { requestId: string; code: string; status: number }) => void;
}
interface StreamOptions {
  iterator: AsyncIterator<string>;
  requestId: string;
  scope: RequestScope;
  report: (error: unknown) => PublicChatFailure;
}

export function createChatHandler({
  env = () => process.env,
  providerFactory = createModelProvider,
  timeoutMs = 50_000,
  format = 'legacy',
  log = (entry) => console.error('Chat request failed', entry),
}: HandlerOptions = {}): (request: Request) => Promise<Response> {
  return async function handleChat(request) {
    const requestId = randomUUID();
    const headers = { 'Cache-Control': 'no-store', 'X-Request-ID': requestId };
    const json = (body: unknown, status: number) => Response.json(body, { status, headers });
    const config = resolveChatConfiguration(env());
    if (!config) return json({ error: '服务尚未完成安全配置' }, 503);
    if (!authorizeRequest(request.headers.get('authorization'), config.accessToken)) {
      return json({ error: '访问口令无效' }, 401);
    }
    const scope = createRequestScope(request.signal, timeoutMs);
    const report = (error: unknown) => {
      const failure = publicChatError(error, scope.timedOut);
      log({ requestId, code: failure.code, status: failure.status });
      return failure;
    };
    try {
      const validation = validateChatPayload(await readJsonBody(request, scope.signal), format);
      if (!validation.ok) {
        scope.dispose();
        return json({ error: validation.error }, 400);
      }
      scope.signal.throwIfAborted();
      const provider = providerFactory(config.model);
      if (format === 'ui-message' || wantsEventStream(request)) {
        const source = await provider.stream(validation.messages, { signal: scope.signal });
        const iterator = validateTextStream(source)[Symbol.asyncIterator]();
        const options = { iterator, requestId, scope, report };
        const streamHeaders = {
          ...headers,
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
        };
        if (format === 'ui-message') {
          return createUIMessageStreamResponse({
            stream: uiMessageStream(options),
            headers: streamHeaders,
          });
        }
        return new Response(legacyStream(options), {
          headers: {
            ...streamHeaders,
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        });
      }
      const content = validateReply(
        await provider.complete(validation.messages, { signal: scope.signal }),
      );
      scope.dispose();
      return json({ content }, 200);
    } catch (error) {
      scope.dispose();
      if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
      if (request.signal.aborted && !scope.timedOut) return json({ error: '请求已取消' }, 499);
      const failure = report(error);
      return json({ error: failure.error, code: failure.code, requestId }, failure.status);
    }
  };
}

// Both encodings pull from the same policy-checked iterator. Cancellation is
// propagated by the response body rather than an unconsumed background tee.
function createStream<T>(
  options: StreamOptions,
  codec: {
    start(id: string): T[];
    delta(value: string, id: string): T;
    finish(id: string): T[];
    error(failure: PublicChatFailure, id: string): T;
  },
): ReadableStream<T> {
  const { iterator, requestId, scope, report } = options;
  let closed = false;
  return new ReadableStream<T>({
    start(controller) {
      for (const event of codec.start(requestId)) controller.enqueue(event);
    },
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (closed) return;
        if (done) {
          for (const event of codec.finish(requestId)) controller.enqueue(event);
          closed = true;
          scope.dispose();
          controller.close();
        } else controller.enqueue(codec.delta(value, requestId));
      } catch (error) {
        if (closed) return;
        closed = true;
        if (!scope.signal.aborted || scope.timedOut)
          controller.enqueue(codec.error(report(error), requestId));
        scope.dispose();
        controller.close();
      }
    },
    async cancel() {
      closed = true;
      scope.abort();
      scope.dispose();
      try {
        await iterator.return?.();
      } catch {
        /* Expected disconnect. */
      }
    },
  });
}
function legacyStream(options: StreamOptions): ReadableStream<Uint8Array> {
  return createStream(options, {
    start: (requestId) => [encodeChatEvent('start', { requestId })],
    delta: (delta) => encodeChatEvent('text-delta', { delta }),
    finish: () => [encodeChatEvent('done', {})],
    error: (failure, requestId) =>
      encodeChatEvent('error', { error: failure.error, code: failure.code, requestId }),
  });
}
function uiMessageStream(options: StreamOptions): ReadableStream<UIMessageChunk> {
  return createStream<UIMessageChunk>(options, {
    start: (id) => [
      { type: 'start', messageId: id, messageMetadata: { requestId: id } },
      { type: 'text-start', id },
    ],
    delta: (delta, id) => ({ type: 'text-delta', id, delta }),
    finish: (id) => [
      { type: 'text-end', id },
      { type: 'finish', finishReason: 'stop' },
    ],
    error: (failure) => ({ type: 'error', errorText: failure.error }),
  });
}
