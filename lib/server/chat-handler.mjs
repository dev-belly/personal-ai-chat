import { randomUUID } from 'node:crypto';
import {
  authorizeRequest,
  isValidAccessTokenConfiguration,
  readJsonBody,
  RequestBodyError,
  validateMessages,
} from '../chat-validation.mjs';
import { encodeChatEvent } from '../chat-protocol.mjs';
import { createAnthropicProvider } from './anthropic-provider.mjs';
import {
  createRequestScope,
  publicChatError,
  validateReply,
  validateTextStream,
} from './chat-service.mjs';

function configuration(env) {
  return {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.CLAUDE_MODEL,
    accessToken: env.CHAT_ACCESS_TOKEN,
    baseURL: env.ANTHROPIC_BASE_URL,
  };
}

export function isChatConfigured(env = process.env) {
  const config = configuration(env);
  return Boolean(
    config.apiKey && config.model && isValidAccessTokenConfiguration(config.accessToken),
  );
}

export function wantsEventStream(request) {
  return (request.headers.get('accept') || '').split(',').some((entry) => {
    const [type, ...parameters] = entry.trim().toLowerCase().split(';');
    return (
      type.trim() === 'text/event-stream' &&
      !parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?$/.test(parameter.trim()))
    );
  });
}

// Dependency injection tests the HTTP boundary without Next.js or real models.
// Runtime configuration is read once per request, never at build time.
export function createChatHandler({
  env = () => process.env,
  providerFactory = createAnthropicProvider,
  timeoutMs = 50_000,
  log = (entry) => console.error('Chat request failed', entry),
} = {}) {
  return async function handleChat(request) {
    const requestId = randomUUID();
    const headers = { 'Cache-Control': 'no-store', 'X-Request-ID': requestId };
    const json = (body, status) => Response.json(body, { status, headers });
    const currentEnv = env();
    const config = configuration(currentEnv);
    if (!isChatConfigured(currentEnv)) return json({ error: '服务尚未完成安全配置' }, 503);
    if (!authorizeRequest(request.headers.get('authorization'), config.accessToken)) {
      return json({ error: '访问口令无效' }, 401);
    }

    const scope = createRequestScope(request.signal, timeoutMs);
    const report = (error) => {
      const failure = publicChatError(error, scope.timedOut);
      // No prompts, reply text, tokens, SDK error bodies or provider URLs.
      log({ requestId, code: failure.code, status: failure.status });
      return failure;
    };
    try {
      const payload = await readJsonBody(request, scope.signal);
      const validation = validateMessages(payload?.messages);
      if (!validation.ok) {
        scope.dispose();
        return json({ error: validation.error }, 400);
      }
      scope.signal.throwIfAborted();
      const provider = providerFactory(config);
      if (wantsEventStream(request)) {
        const source = await provider.stream(validation.messages, { signal: scope.signal });
        const iterator = validateTextStream(source)[Symbol.asyncIterator]();
        const stream = createResponseStream({ iterator, requestId, scope, report });
        return new Response(stream, {
          headers: {
            ...headers,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
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

function createResponseStream({ iterator, requestId, scope, report }) {
  let closed = false;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encodeChatEvent('start', { requestId }));
    },
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (closed) return;
        if (done) {
          controller.enqueue(encodeChatEvent('done', {}));
          closed = true;
          scope.dispose();
          controller.close();
        } else {
          controller.enqueue(encodeChatEvent('text-delta', { delta: value }));
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        if (!scope.signal.aborted || scope.timedOut) {
          const failure = report(error);
          controller.enqueue(
            encodeChatEvent('error', { error: failure.error, code: failure.code, requestId }),
          );
        }
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
        /* Disconnects are expected. */
      }
    },
  });
}
