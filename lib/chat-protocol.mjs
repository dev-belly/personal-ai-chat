// Browser-safe wire contract. Never import provider SDKs or server secrets here.
export const MAX_REPLY_CHARS = 32_000;
export const MAX_EVENT_CHARS = 256 * 1024;

export function encodeChatEvent(event, data) {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
