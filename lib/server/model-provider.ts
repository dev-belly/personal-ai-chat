import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import type { ChatProvider, TextMessage } from '../chat-contract.ts';
import { isValidAccessTokenConfiguration } from '../chat-validation.ts';
import { ChatError } from './chat-service.ts';

export type ChatEnvironment = Record<string, string | undefined>;
export interface ModelConfiguration {
  provider: 'anthropic' | 'openai-compatible';
  apiKey: string;
  model: string;
  baseURL: string;
}
export interface ChatConfiguration {
  model: ModelConfiguration;
  accessToken: string;
}

export function resolveChatConfiguration(env: ChatEnvironment): ChatConfiguration | undefined {
  if (!isValidAccessTokenConfiguration(env.CHAT_ACCESS_TOKEN)) return;
  const provider = env.CHAT_PROVIDER || 'anthropic';
  if (provider !== 'anthropic' && provider !== 'openai-compatible') return;
  const model = (env.CHAT_MODEL || (provider === 'anthropic' ? env.CLAUDE_MODEL : '') || '').trim();
  const apiKey = (
    provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_COMPATIBLE_API_KEY
  )?.trim();
  const endpoint =
    provider === 'anthropic'
      ? env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
      : env.OPENAI_COMPATIBLE_BASE_URL;
  if (!model || !apiKey || !endpoint) return;
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const path = url.pathname.replace(/\/+$/, '');
    // Existing deployments configured an Anthropic origin rather than /v1.
    url.pathname = provider === 'anthropic' && !path.endsWith('/v1') ? `${path}/v1` : path || '/';
    return {
      accessToken: env.CHAT_ACCESS_TOKEN,
      model: {
        provider,
        apiKey,
        model,
        baseURL: url.toString().replace(/\/$/, ''),
      },
    };
  } catch {
    return;
  }
}

// Explicit provider instances keep user configuration local to the deployment;
// bare model strings must not silently route private prompts to AI Gateway.
export function createModelProvider(config: ModelConfiguration): ChatProvider {
  const provider =
    config.provider === 'anthropic'
      ? createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL })
      : createOpenAICompatible({
          name: 'configured',
          apiKey: config.apiKey,
          baseURL: config.baseURL,
        });
  const model = provider(config.model);
  const parameters = (messages: TextMessage[], signal: AbortSignal) => ({
    model,
    messages,
    maxOutputTokens: 4096,
    maxRetries: 0,
    abortSignal: signal,
  });
  return {
    async complete(messages, { signal }) {
      const result = await generateText(parameters(messages, signal));
      return result.text;
    },
    async stream(messages, { signal }) {
      const controller = new AbortController();
      const result = streamText({
        ...parameters(messages, AbortSignal.any([signal, controller.signal])),
        streamRetries: 0,
        onError: () => {},
      });
      const reader = result.fullStream[Symbol.asyncIterator]();
      try {
        // Read past SDK bookkeeping. A provider authentication failure must
        // still become an HTTP error before the application opens its stream.
        let first = await reader.next();
        while (!first.done && first.value.type !== 'text-delta' && first.value.type !== 'finish') {
          if (first.value.type === 'error') throw first.value.error;
          if (first.value.type === 'abort')
            throw signal.reason || new DOMException('已取消', 'AbortError');
          first = await reader.next();
        }
        if (first.done) throw new ChatError('回复传输中断，请重试', 'incomplete_stream');
        const initial = first.value;
        return (async function* () {
          let part = initial;
          let finished = false;
          try {
            while (true) {
              if (part.type === 'text-delta') yield part.text;
              else if (part.type === 'error') throw part.error;
              else if (part.type === 'abort')
                throw signal.reason || new DOMException('已取消', 'AbortError');
              else if (part.type === 'finish') {
                // AI SDK 7 reports an interrupted provider EOF separately from
                // an explicit model termination. Partial output is never saved.
                if (
                  part.finishReason === 'interrupted' ||
                  part.finishReason === 'error' ||
                  !part.rawFinishReason
                ) {
                  throw new ChatError('回复传输中断，请重试', 'incomplete_stream');
                }
                finished = true;
                break;
              }
              const next = await reader.next();
              if (next.done) break;
              part = next.value;
            }
            if (!finished) throw new ChatError('回复传输中断，请重试', 'incomplete_stream');
          } finally {
            controller.abort();
            await reader.return?.();
          }
        })();
      } catch (error) {
        controller.abort();
        await reader.return?.();
        throw error;
      }
    },
  };
}
