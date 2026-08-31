import Anthropic from "@anthropic-ai/sdk";
import {
  authorizeRequest,
  isValidAccessTokenConfiguration,
  readJsonBody,
  RequestBodyError,
  validateMessages,
} from "../../../lib/chat-validation.mjs";

export const maxDuration = 60;

export async function POST(request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_MODEL;
  const accessToken = process.env.CHAT_ACCESS_TOKEN;

  if (!apiKey || !model || !isValidAccessTokenConfiguration(accessToken)) {
    return Response.json(
      { error: "服务尚未完成安全配置" },
      { status: 503 }
    );
  }

  if (!authorizeRequest(request.headers.get("authorization"), accessToken)) {
    return Response.json({ error: "访问口令无效" }, { status: 401 });
  }

  try {
    const payload = await readJsonBody(request);
    const validation = validateMessages(payload?.messages);

    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: 400 });
    }

    const client = new Anthropic({
      apiKey,
      baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    });

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: validation.messages,
    });

    const content =
      response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") || "(无响应内容)";

    return Response.json({ content });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Chat upstream request failed", {
      name: error?.name,
      status: error?.status,
    });

    if (error?.status === 401) {
      return Response.json({ error: "上游服务认证失败" }, { status: 502 });
    }
    if (error?.status === 429) {
      return Response.json(
        { error: "请求过于频繁，请稍后再试" },
        { status: 429 }
      );
    }

    return Response.json(
      { error: "上游服务暂时不可用" },
      { status: 502 }
    );
  }
}
