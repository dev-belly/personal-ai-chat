import Anthropic from '@anthropic-ai/sdk';
import { ChatError } from './chat-service.mjs';

// Only this adapter understands vendor events. Future providers implement the
// same complete()/stream() interface without changing the browser protocol.
export function createAnthropicProvider({ apiKey, model, baseURL }) {
  const client = new Anthropic({ apiKey, baseURL: baseURL || 'https://api.anthropic.com' });
  const parameters = (messages) => ({ model, max_tokens: 4096, messages });
  const options = (signal) => ({ signal, timeout: 50_000, maxRetries: 0 });
  return {
    async complete(messages, { signal }) {
      const response = await client.messages.create(parameters(messages), options(signal));
      return (Array.isArray(response.content) ? response.content : [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
    },
    async stream(messages, { signal }) {
      // Await headers so initial 401/429 errors retain their HTTP status.
      const events = await client.messages.create(
        { ...parameters(messages), stream: true },
        options(signal),
      );
      return textEvents(events);
    },
  };
}

async function* textEvents(events) {
  let stopped = false;
  try {
    for await (const event of events) {
      if (event.type === 'message_stop') {
        stopped = true;
        break;
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block?.type === 'text' &&
        typeof event.content_block.text === 'string' &&
        event.content_block.text
      ) {
        yield event.content_block.text;
      } else if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        typeof event.delta.text === 'string'
      ) {
        yield event.delta.text;
      }
      // Tool input, thinking, ping and future events are not assistant text.
    }
    if (!stopped) throw new ChatError('回复传输中断，请重试', 'incomplete_stream');
  } finally {
    events.controller.abort();
  }
}
