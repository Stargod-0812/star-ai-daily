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

  // 检测是否有管道输入，避免在终端交互时永远阻塞
  if (process.stdin.isTTY) {
    throw new Error('未提供日报内容。请通过 --message、--file 或管道输入提供。');
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

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
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
      let err;
      try { err = await res.json(); } catch { err = { description: `HTTP ${res.status}` }; }

      if (err.description && err.description.includes("can't parse")) {
        // Markdown 解析失败，降级为纯文本重试
        const retryRes = await fetch(
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
        if (!retryRes.ok) {
          let retryErr;
          try { retryErr = await retryRes.json(); } catch { retryErr = { description: `HTTP ${retryRes.status}` }; }
          throw new Error(`Telegram API 降级重试仍失败: ${retryErr.description}`);
        }
      } else {
        throw new Error(`Telegram API 错误: ${err.description}`);
      }
    }

    // 多片时在非最后一片后延迟，避免触发限流
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Email 投递 (Resend) -----------------------------------------------------

async function sendEmail(text, htmlContent, apiKey, toEmail) {
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
      text: text,
      html: htmlContent
    })
  });

  if (!res.ok) {
    let err;
    try { err = await res.json(); } catch { err = { message: `HTTP ${res.status}` }; }
    throw new Error(`Resend API 错误: ${err.message || JSON.stringify(err)}`);
  }
}

// -- Markdown → HTML 渲染 ----------------------------------------------------

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 将一行文本中的 markdown 内联语法转换为 HTML：
 * - **粗体** → <strong>
 * - [文字](url) → <a>
 * - *斜体* → <em>（仅单星号且非粗体）
 */
function inlineMarkdown(text) {
  let s = esc(text);
  // 行内链接 [text](url) — 先处理，避免被粗体匹配干扰
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a class="inline-link" href="$2" target="_blank" rel="noopener">$1</a>');
  // 纯文本链接 → https://... — 文字版日报使用完整 URL 格式
  s = s.replace(/→\s*(https?:\/\/\S+)/g,
    '→ <a class="inline-link" href="$1" target="_blank" rel="noopener">$1</a>');
  // 粗体 **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体 *text*（排除已被粗体消耗的）
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return s;
}

/**
 * 从日报文本中提取统计信息用于顶部统计条
 */
function extractStats(text) {
  const sections = {
    builders: 0,
    cnArticles: 0,
    blogs: 0,
    podcasts: 0
  };
  // 统计 ### 开头的建造者小标题数量
  const builderMatches = text.match(/^### .+/gm);
  if (builderMatches) sections.builders = builderMatches.length;
  // 检测板块存在
  if (/🇨🇳/.test(text)) {
    const cnSection = text.split(/🇨🇳[^\n]*/)[1]?.split(/\n(?=🌐|🎙)/)?.[0] || '';
    const cnParas = cnSection.split(/\n\n/).filter(p => p.trim() && !p.startsWith('🇨🇳'));
    sections.cnArticles = cnParas.length;
  }
  if (/🌐/.test(text)) {
    const blogSection = text.split(/🌐[^\n]*/)[1]?.split(/\n(?=🎙)/)?.[0] || '';
    const blogParas = blogSection.split(/\n\n/).filter(p => p.trim() && !p.startsWith('🌐'));
    sections.blogs = blogParas.length;
  }
  if (/🎙/.test(text)) sections.podcasts = 1;

  // 估算阅读时间（中文约 400 字/分钟）
  const charCount = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, '').length;
  const readMin = Math.max(2, Math.round(charCount / 400));

  return { ...sections, readMin };
}

function generateHtmlDigest(text) {
  const dateStr = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });
  const stats = extractStats(text);

  const lines = text.split('\n');
  let html = '';
  let inBlockquote = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 空行
    if (!trimmed) {
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      html += '<div class="spacer"></div>';
      continue;
    }

    // 关闭上一个引用块（如果当前行不是引用）
    if (inBlockquote && !trimmed.startsWith('>')) {
      html += '</blockquote>';
      inBlockquote = false;
    }

    // --- 分隔线
    if (/^---+$/.test(trimmed)) {
      html += '<hr class="divider">';
      continue;
    }

    // 主标题 ⭐ Star AI 日报
    if (trimmed.startsWith('⭐') || /^Star\s?AI/i.test(trimmed)) {
      html += `<h1 class="digest-title">${esc(trimmed.replace(/^⭐\s*/, ''))}</h1>`;
      continue;
    }

    // 引用块（> 开头）— 用于主线判断和播客原话
    if (trimmed.startsWith('>')) {
      const content = trimmed.replace(/^>\s*/, '');
      if (!inBlockquote) {
        html += '<blockquote class="quote">';
        inBlockquote = true;
      }
      html += `<p>${inlineMarkdown(content)}</p>`;
      continue;
    }

    // 板块标题（emoji 开头）
    if (/^(?:🐦|🎙|🔥|🇨🇳|🌐|💬|🏢)/.test(trimmed)) {
      html += `<h2 class="section-head">${esc(trimmed)}</h2>`;
      continue;
    }

    // 三级标题 ### 建造者名 · 身份
    if (trimmed.startsWith('### ')) {
      const titleText = trimmed.replace(/^###\s*/, '');
      const parts = titleText.split(/\s*·\s*/);
      if (parts.length >= 2) {
        html += `<h3 class="builder-name">${esc(parts[0])}<span class="builder-role"> · ${esc(parts[1])}</span></h3>`;
      } else {
        html += `<h3 class="builder-name">${esc(titleText)}</h3>`;
      }
      continue;
    }

    // 变化洞察（斜体行 *变化洞察：...*）
    if (/^\*变化洞察[：:]/.test(trimmed)) {
      const content = trimmed.replace(/^\*/, '').replace(/\*$/, '');
      html += `<p class="diff-insight"><em>${inlineMarkdown(content)}</em></p>`;
      continue;
    }

    // 普通段落
    html += `<p>${inlineMarkdown(trimmed)}</p>`;
  }

  if (inBlockquote) html += '</blockquote>';

  // 统计条文案
  const statParts = [];
  if (stats.builders > 0) statParts.push(`${stats.builders} 位建造者`);
  if (stats.cnArticles > 0) statParts.push(`${stats.cnArticles} 条国内资讯`);
  if (stats.blogs > 0) statParts.push(`${stats.blogs} 条官方博客`);
  if (stats.podcasts > 0) statParts.push(`${stats.podcasts} 期播客`);
  statParts.push(`约 ${stats.readMin} 分钟`);
  const statsLine = statParts.join(' · ');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Star AI 日报 — ${esc(dateStr)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⭐</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,'PingFang SC','Hiragino Sans GB',sans-serif;background:#0a0a0c;color:#e8e4df;line-height:1.8;-webkit-font-smoothing:antialiased}
::selection{background:#c8a44e;color:#0a0a0c}

.masthead{border-bottom:1px solid rgba(255,255,255,0.05);padding:16px 0;text-align:center}
.masthead-brand{font-family:'Playfair Display',serif;font-size:13px;font-weight:700;color:#c8a44e;letter-spacing:.18em;text-transform:uppercase}

.wrap{max-width:960px;margin:0 auto;padding:48px 32px 80px}

.stats-bar{font-family:'JetBrains Mono',monospace;font-size:11px;color:#6b6560;letter-spacing:.05em;text-align:center;margin-bottom:36px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04)}

.digest-title{font-family:'Playfair Display',serif;font-size:28px;font-weight:900;line-height:1.2;letter-spacing:-.02em;margin-bottom:12px;color:#f0ede8}

.quote{border-left:3px solid #c8a44e;padding:12px 16px;margin:16px 0;background:rgba(200,164,78,0.04);border-radius:0 8px 8px 0}
.quote p{color:#c8c0b4;font-size:15px;margin:4px 0}

.section-head{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;color:#c8a44e;letter-spacing:.14em;text-transform:uppercase;margin:40px 0 18px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.06)}

.builder-name{font-size:16px;font-weight:600;color:#f0ede8;margin:28px 0 8px;letter-spacing:-.01em}
.builder-role{font-weight:400;color:#8a8580;font-size:14px}

p{font-size:15px;line-height:1.85;color:#a8a29e;margin:6px 0 10px}
strong{color:#e8e4df;font-weight:600}

.inline-link{color:#7cb3e8;text-decoration:none;font-size:13px;font-weight:500;transition:color .15s}
.inline-link:hover{color:#a8d0f5;text-decoration:underline}

.diff-insight{padding:10px 14px;background:rgba(124,179,232,0.05);border-radius:6px;margin:12px 0 20px}
.diff-insight em{color:#8a9bae;font-size:14px}

.divider{border:none;border-top:1px solid rgba(255,255,255,0.06);margin:32px 0}

.spacer{height:10px}

.colophon{max-width:960px;margin:0 auto;padding:28px 32px;border-top:1px solid rgba(255,255,255,0.04);text-align:center}
.colophon-brand{font-family:'Playfair Display',serif;font-size:14px;font-weight:700;color:#c8a44e;margin-bottom:6px}
.colophon-note{font-size:11px;color:#5c5850;line-height:1.6}

@media(max-width:600px){
  .wrap{padding:32px 16px 60px}
  .digest-title{font-size:24px}
  .builder-name{font-size:15px}
}
</style></head>
<body>
<header class="masthead"><div class="masthead-brand">Star AI 日报</div></header>
<div class="wrap">
  <div class="stats-bar">${esc(dateStr)} · ${esc(statsLine)}</div>
  ${html}
</div>
<footer class="colophon">
  <div class="colophon-brand">Star AI 日报</div>
  <div class="colophon-note">追踪真正在做事的人，不追网红。信息源由 Star 统一精选维护。</div>
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
  return { latestPath, htmlContent };
}

async function main() {
  loadEnv({ path: ENV_PATH });

  const args = process.argv.slice(2);
  const htmlOnly = args.includes('--html-only');

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch {
      console.error('config.json 解析失败，使用默认配置');
    }
  }

  const delivery = config.delivery || { method: 'stdout' };
  const digestText = await getDigestText();

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: '日报内容为空' }));
    return;
  }

  // 始终生成 HTML 存档
  let htmlPath;
  let htmlContent;
  let htmlError;
  try {
    const result = await saveHtml(digestText);
    htmlPath = result.latestPath;
    htmlContent = result.htmlContent;
  } catch (err) {
    htmlError = err.message;
    console.error(`HTML 生成失败: ${err.message}`);
  }

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
        await sendEmail(digestText, htmlContent, apiKey, toEmail);
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

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
