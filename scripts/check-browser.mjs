import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const require = createRequire(`${root}/package.json`);
const { chromium } = require('playwright');
const token = 'browser-fixture-only-'.repeat(3);
const calls = [];
function normalizedMessages(messages) {
  return messages.map(({ role, content }) => ({
    role,
    content:
      typeof content === 'string'
        ? content
        : content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
  }));
}

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
  if (current === 'held' || current === 'markdown') {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let close;
    const closed = new Promise((resolve) => (close = resolve));
    held = { release, closed };
    res.once('close', () => {
      release();
      close();
    });
    text(current === 'markdown' ? '## 可运行示例\n\n| 能力 | 状态 |\n| --- | --- |\n| 流式渲染 | 运行中 |\n\n```typescript\nconst answer = ' : '第一段');
    await gate;
    if (res.destroyed) return;
    text(current === 'markdown'
      ? '42;\n```\n\n[官方文档](https://example.com/docs)\n\n![外部图片](https://tracker.invalid/pixel)\n\n<script>window.__unsafeMarkdown = true</script>\n\n<a href="javascript:window.__unsafeMarkdown=true">危险链接</a>'
      : '第二段🙂');
  } else if (current === 'error') {
    text('这是一段未完成回答');
    event('error', { error: { type: 'overloaded_error', message: 'private fixture detail' } });
    res.end();
    return;
  } else if (current === 'split-unicode') { text('中文\uD83D'); text('\uDE42'); }
  else text('完整新回复');
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const input = page.getByRole('textbox', { name: '消息内容' });
  const chatMode = page.getByRole('combobox', { name: '聊天模式' });
  const newChat = page.getByRole('button', { name: '新建会话', exact: true });
  const send = async (text) => {
    await input.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  const respondToDiscard = async (action, decision = 'accept') => {
    const respond = page.waitForEvent('dialog').then(async (dialog) => {
      const type = dialog.type();
      const message = dialog.message();
      if (decision === 'dismiss') await dialog.dismiss();
      else await dialog.accept();
      assert.equal(type, 'confirm');
      assert.match(message, /未保存的内容/);
    });
    await Promise.all([respond, action()]);
  };
  await send('帮我制定学习计划');
  await page.getByText('【本地模拟 · 固定示例】', { exact: true }).waitFor();
  assert.equal(calls.length, 0);
  await respondToDiscard(() => newChat.click(), 'dismiss');
  await page.getByText('【本地模拟 · 固定示例】', { exact: true }).waitFor();
  await respondToDiscard(() => newChat.click());
  await input.fill('还没有发送的草稿');
  await respondToDiscard(() => chatMode.selectOption('live'), 'dismiss');
  assert.equal(await chatMode.inputValue(), 'demo');
  assert.equal(await input.inputValue(), '还没有发送的草稿');
  await respondToDiscard(() => chatMode.selectOption('live'));
  assert.equal(await input.inputValue(), '');
  console.log('PASS new chat and mode changes protect unsaved content');
  await page.getByRole('textbox', { name: 'Chat access token' }).fill(token);
  await page.getByText('真实服务已配置。', { exact: false }).waitFor();
  await send('incremental');
  await page.getByText('第一段', { exact: true }).waitFor();
  await page.getByText('AI · 正在回复', { exact: true }).waitFor();
  assert.equal(await input.isDisabled(), true);
  await page.screenshot({ path: `${screenshots}/stream-desktop.png`, animations: 'disabled' });
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
    normalizedMessages(calls.at(-1).messages).map((item) => item.content),
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
  await respondToDiscard(() => newChat.click());
  mode = 'complete';
  await send('new-session');
  await page.getByText('完整新回复', { exact: true }).waitFor();
  old.release();
  await within(old.closed);
  assert.deepEqual(normalizedMessages(calls.at(-1).messages), [
    { role: 'user', content: 'new-session' },
  ]);
  assert.doesNotMatch(await page.locator('main').innerText(), /第一段|old-session|未完成/);
  console.log('PASS clear during stream and immediate fresh session');
  await page.setViewportSize({ width: 390, height: 844 });
  await respondToDiscard(() => chatMode.selectOption('demo'));
  await send('代码测试');
  await page.getByText('【本地模拟 · 固定示例】', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.screenshot({ path: `${screenshots}/stream-mobile.png`, animations: 'disabled' });
  await page.getByRole('button', {name: '会话历史', exact: true}).click();
  await page.getByText('尚未保存会话；聊天后点击“保存会话”。', {exact:true}).waitFor();
  await page.getByRole('button', {name: '会话历史', exact: true}).click();
  console.log('PASS history stays empty until the user explicitly saves');

  await page.getByRole('button', {name:'保存会话',exact:true}).click();
  await page.getByText('已保存到本浏览器；刷新后可从“会话历史”打开。',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  await page.locator('.history-open').filter({hasText:'代码测试'}).click();
  await page.getByText('【本地模拟 · 固定示例】',{exact:true}).waitFor();
  await send('继续记录');
  await page.getByRole('button',{name:'Send message',exact:true}).waitFor();
  await page.getByRole('button',{name:'更新保存',exact:true}).click();
  await page.getByText('已保存到本浏览器；刷新后可从“会话历史”打开。',{exact:true}).waitFor();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button',{name:'导出会话',exact:true}).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^personal-ai-chat-demo-\d+\.json$/);
  const exported = JSON.parse(await readFile(await download.path(),'utf8'));
  assert.equal(exported.mode,'demo');
  assert.equal(exported.messages.length,4);
  assert.doesNotMatch(JSON.stringify(exported),new RegExp(token));
  assert.equal(exported.messages.some(message=>'request' in message),false);
  console.log('PASS explicit save, page reload, complete history restore and JSON export');

  const second = await page.context().newPage();
  second.on('pageerror', (error) => errors.push(error.message));
  await second.goto(origin);
  await second.getByRole('button',{name:'会话历史',exact:true}).click();
  await second.locator('.history-open').filter({hasText:'代码测试'}).click();
  await second.getByRole('textbox',{name:'消息内容'}).fill('来自第二个标签页');
  await second.getByRole('button',{name:'Send message',exact:true}).click();
  await second.getByRole('button',{name:'更新保存',exact:true}).waitFor();
  await second.getByRole('button',{name:'更新保存',exact:true}).waitFor({state:'visible'});
  await second.waitForFunction(()=>!document.querySelector('textarea').disabled);
  await second.getByRole('button',{name:'更新保存',exact:true}).click();
  await second.getByText('已保存到本浏览器；刷新后可从“会话历史”打开。',{exact:true}).waitFor();
  await send('旧标签页的未保存修改');
  await page.waitForFunction(()=>!document.querySelector('textarea').disabled);
  await page.getByRole('button',{name:'更新保存',exact:true}).click();
  await page.getByText('这条会话已在其他页面更新，请重新打开后再保存。',{exact:true}).waitFor();
  await input.fill('保留尚未发送的草稿');
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  const originalHistory = page.locator('.history-open').filter({hasText:'代码测试'});
  await respondToDiscard(() => originalHistory.click(), 'dismiss');
  assert.equal(await input.inputValue(), '保留尚未发送的草稿');
  await page.getByText('旧标签页的未保存修改',{exact:true}).waitFor();
  await respondToDiscard(() => originalHistory.click());
  await page.getByText('来自第二个标签页',{exact:true}).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.doesNotMatch(await page.locator('main').innerText(),/旧标签页的未保存修改/);
  console.log('PASS history restore keeps changes and draft until discard is confirmed');
  await second.getByRole('button',{name:'会话历史',exact:true}).click();
  await second.locator('.history-open').filter({hasText:'代码测试'}).waitFor();
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  const deleteOriginal = page.getByRole('button',{name:'删除会话：代码测试',exact:true});
  await input.fill('删除前的草稿');
  await respondToDiscard(() => deleteOriginal.click(), 'dismiss');
  await originalHistory.waitFor();
  await page.getByText('来自第二个标签页',{exact:true}).waitFor();
  assert.equal(await input.inputValue(), '删除前的草稿');
  await respondToDiscard(() => deleteOriginal.click());
  await page.getByText('尚未保存会话；聊天后点击“保存会话”。',{exact:true}).waitFor();
  await second.getByText('尚未保存会话；聊天后点击“保存会话”。',{exact:true}).waitFor();
  assert.equal(await input.inputValue(), '');
  await second.close();
  console.log('PASS cross-tab revision conflict, reactive history and atomic deletion');

  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  await send('保存与新建隔离');
  await page.waitForFunction(()=>!document.querySelector('textarea').disabled);
  await respondToDiscard(() => page.evaluate(()=>{
    const buttons=Array.from(document.querySelectorAll('button'));
    buttons.find(button=>button.textContent.trim()==='保存会话').click();
    buttons.find(button=>button.textContent.trim()==='新建会话').click();
  }));
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  await page.locator('.history-open').filter({hasText:'保存与新建隔离'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'更新保存',exact:true}).count(),0);
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  await send('新会话独立保存');
  await page.waitForFunction(()=>!document.querySelector('textarea').disabled);
  await page.getByRole('button',{name:'保存会话',exact:true}).click();
  await page.getByText('已保存到本浏览器；刷新后可从“会话历史”打开。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  await page.getByRole('searchbox',{name:'搜索会话标题'}).fill('保存与新建');
  await page.waitForFunction(()=>document.querySelectorAll('.history-list li').length===1);
  await page.locator('.history-open').filter({hasText:'保存与新建隔离'}).waitFor();
  await page.getByRole('searchbox',{name:'搜索会话标题'}).fill('');
  await page.waitForFunction(()=>document.querySelectorAll('.history-list li').length===2);
  assert.equal(await page.evaluate(()=>{
    const bounds=document.querySelector('.input-wrapper').getBoundingClientRect();
    return bounds.top>=0 && bounds.bottom<=window.innerHeight;
  }),true,'history drawer must leave the composer within the mobile viewport');
  await page.screenshot({path:`${screenshots}/history-mobile.png`,animations:'disabled'});
  const savedHistory = page.locator('.history-open').filter({hasText:'保存与新建隔离'});
  await savedHistory.click();
  await page.locator('main').getByText('保存与新建隔离',{exact:true}).waitFor();
  console.log('PASS save/new-session race isolation, title search and switching without pending edits');

  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'新建会话',exact:true}).click();
  await page.getByRole('combobox',{name:'聊天模式'}).selectOption('live');
  await page.getByText('真实服务已配置。',{exact:false}).waitFor();
  mode='held';
  await send('在流式回复中打开历史');
  await page.getByText('AI · 正在回复',{exact:true}).waitFor();
  const switching=held;
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  await respondToDiscard(() => savedHistory.click(), 'dismiss');
  await page.getByText('AI · 正在回复',{exact:true}).waitFor();
  await respondToDiscard(() => savedHistory.click());
  await page.getByText('保存与新建隔离',{exact:true}).waitFor();
  await within(switching.closed);
  assert.equal(await page.getByRole('combobox',{name:'聊天模式'}).inputValue(),'demo');
  assert.doesNotMatch(await page.locator('main').innerText(),/在流式回复中打开历史|第一段/);
  console.log('PASS opening stored history aborts and isolates the active model stream');

  await page.getByRole('button',{name:'新建会话',exact:true}).click();
  await page.getByRole('combobox',{name:'聊天模式'}).selectOption('live');
  await page.getByText('真实服务已配置。',{exact:false}).waitFor();
  mode='complete';
  await send('保存真实会话');
  await page.getByText('完整新回复',{exact:true}).waitFor();
  await page.getByRole('button',{name:'保存会话',exact:true}).click();
  await page.getByText('已保存到本浏览器；刷新后可从“会话历史”打开。',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  await page.locator('.history-open').filter({hasText:'保存真实会话'}).click();
  await page.getByText('真实服务已配置。',{exact:false}).waitFor();
  await send('恢复后继续');
  await page.waitForFunction(()=>!document.querySelector('textarea').disabled);
  assert.deepEqual(normalizedMessages(calls.at(-1).messages).map(message=>message.content),['保存真实会话','完整新回复','恢复后继续']);
  console.log('PASS restored live conversation forwards only successful saved turns');

  await respondToDiscard(() => newChat.click());
  mode='markdown';
  const tracking=[];
  page.on('request',request=>{if(request.url().includes('tracker.invalid'))tracking.push(request.url());});
  await page.route('**/tracker.invalid/**',route=>route.abort());
  await send('展示 Markdown');
  await page.getByRole('heading',{name:'可运行示例',exact:true}).waitFor();
  await page.getByRole('table').waitFor();
  await page.locator('pre code').filter({hasText:'const answer'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'复制代码',exact:true}).isDisabled(),true);
  await page.screenshot({path:`${screenshots}/markdown-streaming.png`,animations:'disabled'});
  held.release();
  await page.waitForFunction(()=>!document.querySelector('textarea').disabled);
  await page.getByRole('button',{name:'复制代码',exact:true}).click();
  await page.locator('output').filter({hasText:'已复制'}).waitFor({state:'attached'});
  assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).trim(),'const answer = 42;');
  await page.waitForFunction(()=>document.querySelectorAll('pre code span[style]').length>0);
  assert.equal(await page.locator('.assistant-markdown img').count(),0);
  assert.equal(await page.locator('.assistant-markdown a[href^="javascript:"]').count(),0);
  assert.equal(await page.evaluate(()=>window.__unsafeMarkdown),undefined);
  assert.deepEqual(tracking,[]);
  const safeLink=page.getByRole('link',{name:'官方文档',exact:true});
  assert.match(await safeLink.getAttribute('rel'),/noopener/);
  await page.screenshot({path:`${screenshots}/markdown-desktop.png`,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:`${screenshots}/markdown-mobile.png`,animations:'disabled'});
  console.log('PASS streamed Markdown tables, highlighted code copy, safe links and blocked tracking images');

  await respondToDiscard(() => newChat.click());
  mode='split-unicode';
  const unicodePrompt='中'.repeat(79)+'🙂';
  await send(unicodePrompt);
  await page.getByText('中文🙂',{exact:true}).waitFor();
  await page.getByRole('button',{name:'保存会话',exact:true}).click();
  await page.getByText('已保存到本浏览器；刷新后可从“会话历史”打开。',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'会话历史',exact:true}).click();
  await page.locator('.history-open').filter({hasText:'中'.repeat(79)}).click();
  await page.getByText(unicodePrompt,{exact:true}).waitFor();
  await page.getByText('中文🙂',{exact:true}).waitFor();
  assert.equal(await page.locator('main').innerText().then(text=>text.includes(String.fromCharCode(0xfffd))),false);
  console.log('PASS split emoji, title boundary and complete Unicode reload');

  await page.getByRole('button',{name:'新建会话',exact:true}).click();
  await page.getByText('真实服务已配置。',{exact:false}).waitFor();
  const beforeInvalid=calls.length;
  await input.evaluate(element=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(element,'bad'+String.fromCharCode(0xd83d));
    element.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'输入包含不完整的字符，请重新输入。'}).waitFor();
  assert.equal(calls.length,beforeInvalid);
  assert.equal(await page.locator('.message.user').count(),0);
  mode='complete';
  await send('修复输入后🙂');
  await page.getByText('完整新回复',{exact:true}).waitFor();
  assert.equal(await page.getByRole('alert').filter({hasText:'输入包含不完整的字符，请重新输入。'}).count(),0);
  console.log('PASS invalid input remains editable without a model call and recovers after correction');

  const unavailable=await page.context().newPage();
  unavailable.on('pageerror', (error) => errors.push(error.message));
  await unavailable.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:undefined}));
  await unavailable.goto(origin);
  await unavailable.getByRole('textbox',{name:'消息内容'}).fill('无存储仍可聊天');
  await unavailable.getByRole('button',{name:'Send message',exact:true}).click();
  await unavailable.getByText('【本地模拟 · 固定示例】',{exact:true}).waitFor();
  await unavailable.getByRole('button',{name:'保存会话',exact:true}).click();
  await unavailable.getByText('浏览器未开放本机保存，当前聊天仍可继续。',{exact:true}).waitFor();
  await unavailable.getByRole('button',{name:'会话历史',exact:true}).click();
  await unavailable.getByText('浏览器暂时无法读取本机会话，当前聊天仍可使用。',{exact:true}).waitFor();
  await unavailable.close();
  console.log('PASS storage-unavailable fallback keeps chat functional');

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
