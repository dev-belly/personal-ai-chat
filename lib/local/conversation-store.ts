import { Dexie } from 'dexie';
import type { EntityTable } from 'dexie';
import { z } from 'zod';
import type { ChatMode, DisplayMessage } from '../chat-contract.ts';

export const MAX_SAVED_CONVERSATIONS = 100;
export const MAX_SAVED_BYTES = 512 * 1024;
const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'error']),
  content: z.string().max(32_000),
  status: z.enum(['sent', 'failed', 'incomplete']).optional(),
  retryText: z.string().max(8_000).optional(),
  requestId: z.string().max(128).optional(),
}).strict().superRefine((message, context) => {
  const valid = message.role === 'user' ? ['sent', 'failed'].includes(message.status || '')
    : message.role === 'assistant' ? ['sent', 'incomplete'].includes(message.status || '') : message.status === undefined;
  if (!valid || (message.status === 'sent' && !message.content.trim())) {
    context.addIssue({ code: 'custom', message: '消息状态与角色不匹配' });
  }
});
const messagesSchema = z.array(messageSchema).min(1).max(400);
const summarySchema = z.object({
  id: z.string().uuid(), title: z.string().min(1).max(80), mode: z.enum(['demo', 'live']),
  revision: z.number().int().positive(), createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(), messageCount: z.number().int().min(1).max(400),
}).strict();
export type ConversationSummary = z.infer<typeof summarySchema>;
export type StoredMessage = z.infer<typeof messageSchema>;
export interface SavedConversation extends ConversationSummary { messages: StoredMessage[] }
interface ConversationBody { sessionId: string; messages: StoredMessage[] }

export class ConversationStoreError extends Error {
  constructor(message: string) { super(message); this.name = 'ConversationStoreError'; }
}
export class ConversationConflictError extends ConversationStoreError {
  constructor() { super('这条会话已在其他页面更新，请重新打开后再保存。'); this.name = 'ConversationConflictError'; }
}

export class ConversationDatabase extends Dexie {
  summaries!: EntityTable<ConversationSummary, 'id'>;
  bodies!: EntityTable<ConversationBody, 'sessionId'>;
  constructor(name = 'personal-ai-chat-local') {
    super(name);
    this.version(1).stores({ summaries: 'id, updatedAt, mode', bodies: 'sessionId' });
  }
}

export function snapshotMessages(messages: DisplayMessage[]): StoredMessage[] {
  const projected = messages.map(({ role, content, status, retryText, requestId }) => ({
    role, content,
    ...(role !== 'error' ? { status: role === 'user'
      ? (status === 'sent' ? 'sent' : 'failed')
      : (status === 'sent' ? 'sent' : 'incomplete') } : {}),
    ...(retryText ? { retryText } : {}), ...(requestId ? { requestId } : {}),
  }));
  const parsed = messagesSchema.safeParse(projected);
  if (!parsed.success) throw new ConversationStoreError('会话内容无法保存，请检查消息格式或新建会话。');
  if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > MAX_SAVED_BYTES) {
    throw new ConversationStoreError('这条会话内容较多，请新建会话后继续。');
  }
  return parsed.data;
}

function parseSaved(summary: unknown, messages: unknown): SavedConversation {
  const metadata = summarySchema.safeParse(summary);
  const body = messagesSchema.safeParse(messages);
  if (!metadata.success || !body.success || body.data.length !== metadata.data.messageCount) {
    throw new ConversationStoreError('这条本机会话无法读取，当前聊天不会被替换。');
  }
  if (new TextEncoder().encode(JSON.stringify(body.data)).byteLength > MAX_SAVED_BYTES) {
    throw new ConversationStoreError('这条本机会话超过可读取的大小。');
  }
  return { ...metadata.data, messages: body.data };
}

export interface SaveConversationInput {
  id?: string; expectedRevision?: number; mode: ChatMode; messages: DisplayMessage[];
}

export function createConversationRepository(name?: string) {
  const database = new ConversationDatabase(name);
  return {
    database,
    async list(search = ''): Promise<ConversationSummary[]> {
      const rows = await database.summaries.orderBy('updatedAt').reverse().toArray();
      const parsed = z.array(summarySchema).safeParse(rows);
      if (!parsed.success) throw new ConversationStoreError('本机会话目录无法读取，当前聊天仍可使用。');
      const query = search.trim().toLocaleLowerCase();
      return parsed.data.filter((row) => row.title.toLocaleLowerCase().includes(query));
    },
    async load(id: string): Promise<SavedConversation> {
      return database.transaction('r', database.summaries, database.bodies, async () => {
        const summary = await database.summaries.get(id);
        const body = await database.bodies.get(id);
        if (!summary || !body) throw new ConversationStoreError('这条会话已被删除或无法读取。');
        return parseSaved(summary, body.messages);
      });
    },
    async save(input: SaveConversationInput): Promise<SavedConversation> {
      const messages = snapshotMessages(input.messages);
      if (input.mode !== 'demo' && input.mode !== 'live') throw new ConversationStoreError('聊天模式不合法。');
      return database.transaction('rw', database.summaries, database.bodies, async () => {
        const existing = input.id ? await database.summaries.get(input.id) : undefined;
        if (input.id && !existing) throw new ConversationStoreError('这条会话已被删除，请另存为新会话。');
        if (existing && !summarySchema.safeParse(existing).success) throw new ConversationStoreError('这条会话的目录已损坏，未覆盖现有记录。');
        if (existing && existing.revision !== input.expectedRevision) throw new ConversationConflictError();
        if (!existing && await database.summaries.count() >= MAX_SAVED_CONVERSATIONS) {
          throw new ConversationStoreError('本机会话已满，请先删除不再需要的记录。');
        }
        const now = Date.now();
        const title = messages.find((message) => message.role === 'user')?.content.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名会话';
        const summary = summarySchema.parse({ id: existing?.id || crypto.randomUUID(), title,
          mode: input.mode, revision: (existing?.revision || 0) + 1, createdAt: existing?.createdAt ?? now,
          updatedAt: Math.max(now, existing?.updatedAt ?? 0), messageCount: messages.length });
        await database.summaries.put(summary);
        await database.bodies.put({ sessionId: summary.id, messages });
        return { ...summary, messages };
      });
    },
    async remove(id: string, expectedRevision: number): Promise<void> {
      await database.transaction('rw', database.summaries, database.bodies, async () => {
        const existing = await database.summaries.get(id);
        if (!existing) return;
        if (existing.revision !== expectedRevision) throw new ConversationConflictError();
        await database.bodies.delete(id);
        await database.summaries.delete(id);
      });
    },
  };
}
export type ConversationRepository = ReturnType<typeof createConversationRepository>;
let browserRepository: ConversationRepository | undefined;
export function getConversationRepository(): ConversationRepository {
  if (!globalThis.indexedDB) throw new ConversationStoreError('浏览器未开放本机保存，当前聊天仍可继续。');
  return browserRepository ||= createConversationRepository();
}

export function exportConversation(mode: ChatMode, messages: DisplayMessage[]): string {
  return JSON.stringify({ format: 'personal-ai-chat', version: 1, mode,
    exportedAt: new Date().toISOString(), messages: snapshotMessages(messages) }, null, 2);
}
