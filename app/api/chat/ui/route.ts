import { createChatHandler } from '../../../../lib/server/chat-handler.ts';
export const maxDuration = 60;
const handleChat = createChatHandler({ format: 'ui-message' });
export async function POST(request: Request): Promise<Response> {
  return handleChat(request);
}
