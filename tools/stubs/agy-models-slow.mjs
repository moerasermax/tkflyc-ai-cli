#!/usr/bin/env node
/**
 * 只列錄下的模型輸出，不連 vendor。預設慢 2 秒，trace 用來證明逾時真的殺掉程序。
 * 事件帶 `t`（Date.now）：光看 started 存不存在，證明不了它是在逾時門檻**觸發前**
 * 啟動的——trace 是事後一次讀的，而子程序可能在門檻觸發後才真正跑起來。
 */
import { appendFileSync } from 'node:fs';
const trace = (event) => {
  if (process.env.AGY_STUB_TRACE_PATH) {
    appendFileSync(process.env.AGY_STUB_TRACE_PATH,
      `${JSON.stringify({ event, t: Date.now(), pid: process.pid, args: process.argv.slice(2) })}\n`);
  }
};
trace('started');
setTimeout(() => {
  trace('completed');
  console.log('Fetching available models...');
  if (process.env.AGY_STUB_EMPTY !== 'true') {
    console.log('gemini-3.8-flash-high\tGemini 3.8 Flash (High)');
    console.log('gemini-3.1-pro-high\tGemini 3.1 Pro (High)');
    console.log('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)');
    console.log('gpt-oss-120b-medium\tGPT-OSS 120B (Medium)');
  }
}, Number(process.env.AGY_STUB_DELAY_MS ?? 2000));
