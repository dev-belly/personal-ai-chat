import { toUIMessages } from './chat-contract.ts';
import type { DisplayMessage, TextMessage, WireFormat } from './chat-contract.ts';
import { isWellFormedText } from './text-boundaries.ts';
export const MAX_INPUT_CHARS = 8_000;
const MAX_REQUEST_BYTES = 64 * 1024;

function requestBytes(history: TextMessage[], text: string, format: WireFormat) {
  const messages: TextMessage[] = [...history, { role: 'user', content: text }];
  return new TextEncoder().encode(
    JSON.stringify({ messages: format === 'ui-message' ? toUIMessages(messages) : messages }),
  ).byteLength;
}

// Only completed turns enter a real request. Failed/cancelled attempts remain
// visible in the UI but cannot create consecutive user messages upstream.
export function buildConversation(
  messages: DisplayMessage[],
  text: string,
  format: WireFormat = 'legacy',
): TextMessage[] {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT_CHARS) {
    throw new Error('请输入 1—8,000 字符的消息');
  }
  if (!isWellFormedText(text)) throw new Error('输入包含不完整的字符，请重新输入。');
  const complete: TextMessage[] = [];
  for (let i = 0; i < messages.length - 1; i += 1) {
    const user = messages[i];
    const assistant = messages[i + 1];
    if (
      user?.role === 'user' &&
      user.status === 'sent' &&
      assistant?.role === 'assistant' &&
      (!assistant.status || assistant.status === 'sent')
    ) {
      complete.push(
        { role: 'user', content: user.content },
        { role: 'assistant', content: assistant.content },
      );
      i += 1;
    }
  }
  let history = complete.slice(-38).map(({ role, content }) => ({ role, content }));
  while (
    history.reduce((size, item) => size + item.content.length, text.length) > 32_000 ||
    requestBytes(history, text, format) > MAX_REQUEST_BYTES
  ) {
    history = history.slice(2);
  }
  return [...history, { role: 'user', content: text }];
}

interface SubmitEvent {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}

export function shouldSubmit(event: SubmitEvent) {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    !event.nativeEvent?.isComposing &&
    event.keyCode !== 229
  );
}

export function localDemoReply(text: string) {
  if (/代码|code|python|javascript/i.test(text)) {
    return '【本地模拟 · 固定示例】\n可以先把需求拆成输入、处理、输出，再为边界情况写测试。\n例如：空输入、重复输入、网络失败。\n这段文字由浏览器预设规则选择，没有调用 AI 模型，也没有发送你的消息。';
  }
  if (/计划|学习|plan|study/i.test(text)) {
    return '【本地模拟 · 固定示例】\n一份可执行的学习计划可以分三步：\n1. 写下本周要完成的一个具体目标。\n2. 每天安排一段练习时间，并保留练习结果。\n3. 周末复盘困难，再调整下一周的任务。\n这是界面演示文字，不是 AI 根据你的情况生成的建议。';
  }
  return '【本地模拟 · 固定示例】\n消息已在当前页面中显示。你可以继续发送、清空会话，或切换到真实服务。\n试试“帮我制定学习计划”或“如何测试代码”。\n演示模式只选择浏览器内置回复，不访问模型 API、不上传聊天内容。';
}

export async function waitForDemo(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 300);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
