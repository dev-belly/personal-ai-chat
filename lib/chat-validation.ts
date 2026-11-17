import { timingSafeEqual } from 'node:crypto';

import { MAX_REQUEST_BYTES, validateConversation } from './chat-contract.ts';
import type { ValidationResult } from './chat-contract.ts';
export {
  MAX_REQUEST_BYTES,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_TOTAL_CHARS,
} from './chat-contract.ts';

export class RequestBodyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RequestBodyError';
    this.status = status;
  }
}

export function isValidAccessTokenConfiguration(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length >= 32 &&
    token.length <= 256 &&
    /^[\x21-\x7E]+$/.test(token)
  );
}

export function authorizeRequest(header: unknown, expectedToken: unknown): boolean {
  if (typeof header !== 'string' || typeof expectedToken !== 'string') {
    return false;
  }

  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;

  const suppliedToken = header.slice(prefix.length);
  const suppliedBytes = Buffer.from(suppliedToken, 'utf8');
  const expectedBytes = Buffer.from(expectedToken, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

export async function readJsonBody(
  request: Request,
  signal: AbortSignal = request.signal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestBodyError('请求内容过大', 413);
  }

  if (!request.body) {
    throw new RequestBodyError('请求内容为空', 400);
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  let text = '';
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestBodyError('请求内容过大', 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    signal?.throwIfAborted();
    if (error instanceof TypeError) throw new RequestBodyError('请求不是有效的 UTF-8 文本', 400);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBodyError('请求不是有效的 JSON', 400);
  }
}

export function validateMessages(messages: unknown): ValidationResult {
  return validateConversation(messages);
}
