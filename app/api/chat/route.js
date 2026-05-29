import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
});

export async function POST(request) {
  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return Response.json({ error: "消息格式错误" }, { status: 400 });
    }

    const model = process.env.CLAUDE_MODEL || "mimo-v2-pro";

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: messages.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
    });

    const content =
      response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") || "(无响应内容)";

    return Response.json({ content });
  } catch (error) {
    console.error("API error:", error);

    if (error.status === 401) {
      return Response.json({ error: "API Key 无效" }, { status: 500 });
    }
    if (error.status === 429) {
      return Response.json(
        { error: "请求过于频繁，请稍后再试" },
        { status: 429 }
      );
    }

    return Response.json(
      { error: error.message || "服务暂时不可用" },
      { status: 500 }
    );
  }
}