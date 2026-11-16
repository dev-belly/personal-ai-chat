import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const require = createRequire(`${root}/package.json`);
const { chromium } = require('playwright');
const token = 'browser-fixture-only-'.repeat(3);
const calls = [];
let held;
let mode = 'held';
const upstream = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  calls.push(input);
  res.setHeader('Content-Type', 'text/event-stream');
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id: 'fixture',
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  const text = (value) =>
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: value } });
  const current = mode;
  if (current === 'held') {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let close;
    const closed = new Promise((resolve) => (close = resolve));
    held = { release, closed };
    res.once('close', () => {
      release();
      close();
    });
    text('第一段');
    await gate;
    if (res.destroyed) return;
    text('第二段🙂');
  } else if (current === 'error') {
    text('这是一段未完成回答');
    event('error', { error: { type: 'overloaded_error', message: 'private fixture detail' } });
    res.end();
    return;
  } else text('完整新回复');
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
  event('message_stop', {});
  res.end();
});

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('upstream disconnect timed out')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const upstreamPort = await listen(upstream);
const reservation = createServer();
const port = await listen(reservation);
await new Promise((resolve) => reservation.close(resolve));
const app = spawn(
  process.execPath,
  [
    require.resolve('next/dist/bin/next'),
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      ANTHROPIC_API_KEY: 'local-test-key',
      CLAUDE_MODEL: 'fixture',
      CHAT_ACCESS_TOKEN: token,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let logs = '';
app.stdout.on('data', (chunk) => (logs += chunk));
app.stderr.on('data', (chunk) => (logs += chunk));
let browser;
try {
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${origin}/api/chat`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const input = page.getByRole('textbox', { name: '消息内容' });
  const send = async (text) => {
    await input.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  await send('帮我制定学习计划');
  await page.getByText('【本地模拟 · 固定示例】', { exact: true }).waitFor();
  assert.equal(calls.length, 0);
  await page.getByRole('button', { name: '新建会话' }).click();
  await page.getByRole('combobox', { name: '聊天模式' }).selectOption('live');
  await page.getByRole('textbox', { name: 'Chat access token' }).fill(token);
  await page.getByText('真实服务已配置。', { exact: false }).waitFor();
  await send('incremental');
  await page.getByText('第一段', { exact: true }).waitFor();
  await page.getByText('AI · 正在回复', { exact: true }).waitFor();
  assert.equal(await input.isDisabled(), true);
  await page.screenshot({ path: `${screenshots}/stream-desktop.png` });
  held.release();
  await page.getByText('第一段第二段🙂', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
  console.log('PASS desktop incremental response before completion');
  await send('cancel-check');
  await page.getByText('第一段', { exact: true }).waitFor();
  const cancelled = held;
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByText('AI · 未完成回复', { exact: true }).waitFor();
  await page.getByText('已取消本次请求。', { exact: true }).waitFor();
  await within(cancelled.closed);
  mode = 'complete';
  await page.getByRole('button', { name: '重试这条消息' }).click();
  await page.getByText('完整新回复', { exact: true }).waitFor();
  assert.deepEqual(
    calls.at(-1).messages.map((item) => item.content),
    ['incremental', '第一段第二段🙂', 'cancel-check'],
  );
  console.log('PASS cancellation, partial label, retry and clean history');
  mode = 'error';
  await send('error-check');
  await page.getByText('这是一段未完成回答', { exact: true }).waitFor();
  await page.getByText('上游服务暂时不可用，请重试', { exact: true }).waitFor();
  await page.getByText('请求编号：', { exact: false }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /private fixture detail/);
  console.log('PASS midstream error with incomplete reply and public request ID');
  mode = 'held';
  await send('old-session');
  await page.getByText('AI · 正在回复', { exact: true }).waitFor();
  await page.getByText('第一段', { exact: true }).last().waitFor();
  const old = held;
  await page.getByRole('button', { name: '新建会话' }).click();
  mode = 'complete';
  await send('new-session');
  await page.getByText('完整新回复', { exact: true }).waitFor();
  old.release();
  await within(old.closed);
  assert.deepEqual(calls.at(-1).messages, [{ role: 'user', content: 'new-session' }]);
  assert.doesNotMatch(await page.locator('main').innerText(), /第一段|old-session|未完成/);
  console.log('PASS clear during stream and immediate fresh session');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox', { name: '聊天模式' }).selectOption('demo');
  await send('代码测试');
  await page.getByText('【本地模拟 · 固定示例】', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.screenshot({ path: `${screenshots}/stream-mobile.png` });
  assert.deepEqual(errors, []);
  console.log('PASS mobile layout, mode switch and no browser runtime errors');
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: `${screenshots}/failure.png` }).catch(() => {});
  }
  console.error('Next.js fixture output:', logs);
  throw error;
} finally {
  if (browser) await browser.close();
  if (app.exitCode === null && app.signalCode === null) {
    const exited = once(app, 'exit');
    const timer = setTimeout(() => app.kill('SIGKILL'), 5_000);
    try {
      app.kill('SIGTERM');
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
