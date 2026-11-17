import { z } from 'zod';
import type { UIMessage } from 'ai';
import { isWellFormedText } from './text-boundaries.ts';

export const unicodeTextSchema = z.string().refine(isWellFormedText, '消息包含不完整的 Unicode 字符');

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_TOTAL_CHARS = 32_000;

const textMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: unicodeTextSchema.min(1, '消息内容必须是非空文本'),
});

export const conversationSchema = z
  .array(textMessageSchema)
  .min(1, '消息列表不能为空')
  .max(MAX_MESSAGES, `消息数量不能超过 ${MAX_MESSAGES} 条`)
  .superRefine((messages, context) => {
    let total = 0;
    messages.forEach((message, index) => {
      if (message.role !== (index % 2 === 0 ? 'user' : 'assistant')) {
        context.addIssue({
          code: 'custom',
          path: [index, 'role'],
          message: '消息角色必须从 user 开始并严格交替',
        });
      }
      const limit = message.role === 'user' ? MAX_MESSAGE_CHARS : MAX_TOTAL_CHARS;
      if (!message.content.trim())
        context.addIssue({
          code: 'custom',
          path: [index, 'content'],
          message: '消息内容必须是非空文本',
        });
      if (message.content.length > limit)
        context.addIssue({
          code: 'custom',
          path: [index, 'content'],
          message: `单条消息不能超过 ${limit} 个字符`,
        });
      total += message.content.length;
    });
    if (total > MAX_TOTAL_CHARS)
      context.addIssue({ code: 'custom', message: `会话内容不能超过 ${MAX_TOTAL_CHARS} 个字符` });
    if (messages.at(-1)?.role !== 'user')
      context.addIssue({ code: 'custom', message: '最后一条消息必须来自 user' });
  });

export type TextMessage = z.infer<typeof textMessageSchema>;
export type ValidationResult = { ok: true; messages: TextMessage[] } | { ok: false; error: string };

// The UI endpoint accepts text parts only. System messages, tool/file payloads
// and arbitrary executable data cannot silently become trusted model context.
export const uiRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        role: z.enum(['user', 'assistant']),
        parts: z
          .array(
            z
              .object({
                type: z.literal('text'),
                text: unicodeTextSchema,
                state: z.enum(['streaming', 'done']).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(8),
      }),
    )
    .min(1)
    .max(MAX_MESSAGES),
});

export const requestMetadataSchema = z.object({ requestId: z.string().uuid() });
export type ChatUIMessage = UIMessage<z.infer<typeof requestMetadataSchema>>;
export type WireFormat = 'legacy' | 'ui-message';
export type ChatMode = 'demo' | 'live';

export function toUIMessages(messages: TextMessage[]): ChatUIMessage[] {
  return messages.map(({ role, content }, index) => ({
    id: `context-${index}`,
    role,
    parts: [{ type: 'text', text: content }],
  }));
}

export function validateConversation(messages: unknown): ValidationResult {
  const parsed = conversationSchema.safeParse(messages);
  return parsed.success
    ? { ok: true, messages: parsed.data }
    : { ok: false, error: parsed.error.issues[0]?.message || '消息格式不合法' };
}

export function validateChatPayload(payload: unknown, format: WireFormat): ValidationResult {
  if (format === 'ui-message') {
    const parsed = uiRequestSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: '消息格式不合法，仅支持用户与助理的文本消息' };
    return validateConversation(
      parsed.data.messages.map(({ role, parts }) => ({
        role,
        content: parts.map((part) => part.text).join(''),
      })),
    );
  }
  const parsed = z.object({ messages: z.unknown() }).safeParse(payload);
  return validateConversation(parsed.success ? parsed.data.messages : undefined);
}

export const publicErrorSchema = z.object({
  error: unicodeTextSchema.min(1).max(500),
  code: z.string().optional(),
  requestId: z.string().optional(),
});
export const legacyReplySchema = z.object({
  content: unicodeTextSchema
    .refine((text) => Boolean(text.trim()))
    .max(32_000),
});

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  status?: 'pending' | 'sent' | 'streaming' | 'failed' | 'incomplete';
  request?: number;
  retryText?: string;
  requestId?: string;
}

export interface ChatProvider {
  complete(messages: TextMessage[], options: { signal: AbortSignal }): Promise<string>;
  stream(messages: TextMessage[], options: { signal: AbortSignal }): Promise<AsyncIterable<string>>;
}
