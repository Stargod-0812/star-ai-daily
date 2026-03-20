#!/usr/bin/env node

// ============================================================================
// Star AI 日报 — 投递脚本
// ============================================================================
// 通过用户选择的方式投递日报。
// 支持：Telegram 机器人、Email (Resend)、stdout（默认）。
//
// 用法：
//   echo "日报文本" | node deliver.js
//   node deliver.js --message "日报文本"
//   node deliver.js --file /path/to/digest.txt
//
// 从 ~/.star-ai-daily/config.json 读取投递配置
// 从 ~/.star-ai-daily/.env 读取 API 密钥
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// -- 常量 -------------------------------------------------------------------

const USER_DIR = join(homedir(), '.star-ai-daily');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

// -- 读取输入 ----------------------------------------------------------------

async function getDigestText() {
  const args = process.argv.slice(2);

  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return args[msgIdx + 1];
  }

  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return await readFile(args[fileIdx + 1], 'utf-8');
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Telegram 投递 -----------------------------------------------------------

async function sendTelegram(text, botToken, chatId) {
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      if (err.description && err.description.includes("can't parse")) {
        await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
      } else {
        throw new Error(`Telegram API 错误: ${err.description}`);
      }
    }

    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Email 投递 (Resend) -----------------------------------------------------

async function sendEmail(text, apiKey, toEmail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'Star AI 日报 <digest@resend.dev>',
      to: [toEmail],
      subject: `⭐ Star AI 日报 — ${new Date().toLocaleDateString('zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
      })}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API 错误: ${err.message || JSON.stringify(err)}`);
  }
}

// -- HTML 日报生成 -----------------------------------------------------------

function generateHtmlDigest(text) {
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const lines = text.split('\n');
  let html = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { html += '<div class="spacer"></div>'; continue; }
    const urlMatch = trimmed.match(/^(https?:\/\/\S+)$/);
    if (urlMatch) {
      html += `<a class="link" href="${esc(urlMatch[1])}" target="_blank" rel="noopener">${esc(urlMatch[1])}</a>`;
    } else if (trimmed.startsWith('⭐') || trimmed.match(/^Star\s?AI/i)) {
      html += `<h1 class="digest-title">${esc(trimmed.replace(/^⭐\s*/, ''))}</h1>`;
    } else if (trimmed.startsWith('🐦') || trimmed.startsWith('🎙') || trimmed.match(/^(X\s*\/|TWITTER|播客)/i)) {
      html += `<h2 class="section-head">${esc(trimmed)}</h2>`;
    } else {
      html += `<p>${esc(trimmed)}</p>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>StarrLiao AI 日报 — ${dateStr}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Inter:wght@300;400;500&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,sans-serif;background:#0c0c0e;color:#f0ede8;line-height:1.8;-webkit-font-smoothing:antialiased}
::selection{background:#c8a44e;color:#0c0c0e}
.masthead{border-bottom:1px solid rgba(255,255,255,0.06);padding:18px 0;text-align:center}
.masthead span{font-family:'Playfair Display',serif;font-size:13px;font-weight:600;color:#c8a44e;letter-spacing:.15em;text-transform:uppercase}
.masthead .dot{color:#5c5850;font-size:10px;margin:0 12px}
.wrap{max-width:640px;margin:0 auto;padding:56px 24px 72px}
.date{font-family:'JetBrains Mono',monospace;font-size:11px;color:#5c5850;letter-spacing:.12em;text-transform:uppercase;text-align:center;margin-bottom:32px}
.digest-title{font-family:'Playfair Display',serif;font-size:28px;font-weight:900;line-height:1.15;letter-spacing:-.02em;margin-bottom:8px;color:#f0ede8}
.section-head{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;color:#c8a44e;letter-spacing:.12em;text-transform:uppercase;margin:36px 0 16px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.08)}
p{font-size:15px;line-height:1.85;color:#a09b93;margin:6px 0}
.link{display:block;font-family:'JetBrains Mono',monospace;font-size:12px;color:#8ab4f8;text-decoration:none;word-break:break-all;margin:4px 0 12px;transition:opacity .2s}
.link:hover{opacity:.7}
.spacer{height:12px}
.colophon{max-width:640px;margin:0 auto;padding:32px 24px;border-top:1px solid rgba(255,255,255,0.06);text-align:center}
.colophon-brand{font-family:'Playfair Display',serif;font-size:15px;font-weight:600;color:#c8a44e;margin-bottom:6px}
.colophon-note{font-size:11px;color:#5c5850;line-height:1.6}
@media(max-width:600px){.wrap{padding:36px 18px 56px}.digest-title{font-size:24px}}
</style></head>
<body>
<header class="masthead"><span>StarrLiao</span><span class="dot">·</span><span>AI Daily Brief</span></header>
<div class="wrap">
  <div class="date">${dateStr}</div>
  ${html}
</div>
<footer class="colophon">
  <div class="colophon-brand">StarrLiao AI Daily Brief</div>
  <div class="colophon-note">信息源由 StarrLiao 统一精选维护，每日自动更新。</div>
</footer>
</body></html>`;
}

// -- 主流程 ------------------------------------------------------------------

async function saveHtml(digestText) {
  const htmlDir = join(USER_DIR, 'web');
  await mkdir(htmlDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const htmlPath = join(htmlDir, `digest-${today}.html`);
  const latestPath = join(htmlDir, 'latest.html');
  const htmlContent = generateHtmlDigest(digestText);
  await writeFile(htmlPath, htmlContent);
  await writeFile(latestPath, htmlContent);
  return latestPath;
}

async function main() {
  loadEnv({ path: ENV_PATH });

  const args = process.argv.slice(2);
  const htmlOnly = args.includes('--html-only');

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = config.delivery || { method: 'stdout' };
  const digestText = await getDigestText();

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: '日报内容为空' }));
    return;
  }

  // 始终生成 HTML 存档
  let htmlPath;
  try {
    htmlPath = await saveHtml(digestText);
  } catch {}

  // --html-only 模式：只生成 HTML，不投递
  if (htmlOnly) {
    console.log(JSON.stringify({
      status: 'ok',
      method: 'html-only',
      message: '网页版日报已生成',
      html: htmlPath
    }));
    return;
  }

  try {
    switch (delivery.method) {
      case 'telegram': {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = delivery.chatId;
        if (!botToken) throw new Error('.env 中未找到 TELEGRAM_BOT_TOKEN');
        if (!chatId) throw new Error('config.json 中未找到 delivery.chatId');
        await sendTelegram(digestText, botToken, chatId);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'telegram',
          message: 'Star AI 日报已推送至 Telegram',
          html: htmlPath
        }));
        break;
      }

      case 'email': {
        const apiKey = process.env.RESEND_API_KEY;
        const toEmail = delivery.email;
        if (!apiKey) throw new Error('.env 中未找到 RESEND_API_KEY');
        if (!toEmail) throw new Error('config.json 中未找到 delivery.email');
        await sendEmail(digestText, apiKey, toEmail);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'email',
          message: `Star AI 日报已发送至 ${toEmail}`,
          html: htmlPath
        }));
        break;
      }

      case 'stdout':
      default:
        // stdout 模式下不打印日报文本（LLM 自己会输出给用户）
        // 只输出状态信息供 LLM 确认 HTML 已生成
        console.log(JSON.stringify({
          status: 'ok',
          method: 'stdout',
          message: '网页版日报已生成',
          html: htmlPath
        }));
        break;
    }
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      method: delivery.method,
      message: err.message
    }));
    process.exit(1);
  }
}

main();
