import { timingSafeEqual } from "node:crypto";

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_TOTAL_CHARS = 32_000;

export class RequestBodyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

export function isValidAccessTokenConfiguration(token) {
  return (
    typeof token === "string" &&
    token.length >= 32 &&
    token.length <= 256 &&
    token === token.trim()
  );
}

export function authorizeRequest(header, expectedToken) {
  if (typeof header !== "string" || typeof expectedToken !== "string") {
    return false;
  }

  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const suppliedToken = header.slice(prefix.length);
  if (suppliedToken.length !== expectedToken.length) return false;

  return timingSafeEqual(
    Buffer.from(suppliedToken, "utf8"),
    Buffer.from(expectedToken, "utf8"),
  );
}

export async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestBodyError("请求内容过大", 413);
  }

  if (!request.body) {
    throw new RequestBodyError("请求内容为空", 400);
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestBodyError("请求内容过大", 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBodyError("请求不是有效的 JSON", 400);
  }
}

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "消息列表不能为空" };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, error: `消息数量不能超过 ${MAX_MESSAGES} 条` };
  }

  let totalChars = 0;
  const normalized = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const expectedRole = index % 2 === 0 ? "user" : "assistant";

    if (!message || message.role !== expectedRole) {
      return { ok: false, error: "消息角色必须从 user 开始并严格交替" };
    }
    if (typeof message.content !== "string" || !message.content.trim()) {
      return { ok: false, error: "消息内容必须是非空文本" };
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      return {
        ok: false,
        error: `单条消息不能超过 ${MAX_MESSAGE_CHARS} 个字符`,
      };
    }

    totalChars += message.content.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      return {
        ok: false,
        error: `会话内容不能超过 ${MAX_TOTAL_CHARS} 个字符`,
      };
    }

    normalized.push({ role: message.role, content: message.content });
  }

  if (normalized.at(-1).role !== "user") {
    return { ok: false, error: "最后一条消息必须来自 user" };
  }

  return { ok: true, messages: normalized };
}
