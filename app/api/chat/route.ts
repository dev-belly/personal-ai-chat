import { createChatHandler, isChatConfigured } from '../../../lib/server/chat-handler.ts';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const handleChat = createChatHandler();

export async function GET() {
  return Response.json(
    { configured: isChatConfigured() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  return handleChat(request);
}
