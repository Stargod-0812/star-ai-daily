#!/usr/bin/env node

/**
 * Star AI 日报 · 投递引擎
 *
 * 负责把混编好的日报文本送达用户。
 * 渠道：Telegram Bot / Resend Email / stdout
 * 额外：自动渲染 HTML 精排版存档到 ~/.star-ai-daily/web/
 *
 * 输入方式（三选一）：
 *   --file <path>       从文件读取
 *   --message "<text>"  命令行直传
 *   stdin 管道          echo "..." | node deliver.js
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// ── 路径 ──────────────────────────────────────────
const DATA_HOME  = join(homedir(), '.star-ai-daily');
const PREFS_PATH = join(DATA_HOME, 'config.json');
const SECRETS    = join(DATA_HOME, '.env');

// ── 读取日报文本 ─────────────────────────────────
// 支持 --file / --message / stdin 三种方式，按优先级依次检测

async function readDigestInput() {
  const argv = process.argv.slice(2);

  // 方式一：从文件读取
  const fp = flagValue(argv, '--file');
  if (fp) return readFile(fp, 'utf-8');

  // 方式二：命令行直传
  const inline = flagValue(argv, '--message');
  if (inline) return inline;

  // 方式三：stdin 管道
  if (process.stdin.isTTY) {
    throw new Error('缺少日报内容。用 --file / --message 或管道传入。');
  }
  const parts = [];
  for await (const buf of process.stdin) parts.push(buf);
  return Buffer.concat(parts).toString('utf-8');
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return (i !== -1 && argv[i + 1]) ? argv[i + 1] : null;
}

// ── Telegram 推送 ────────────────────────────────
// 自动拆长文为 ≤4000 字符的片段，优先在换行处断开。
// Markdown 解析失败时自动降级为纯文本重发。

async function pushToTelegram(content, token, chat) {
  const LIMIT = 4000;
  const segments = splitByLength(content, LIMIT);

  for (let idx = 0; idx < segments.length; idx++) {
    const ok = await tgSend(token, chat, segments[idx], 'Markdown');
    if (!ok) {
      // Markdown 降级重试
      const retry = await tgSend(token, chat, segments[idx], null);
      if (!retry) throw new Error('Telegram 推送失败（降级重试仍报错）');
    }
    // 多段之间加延迟，防限流
    if (idx < segments.length - 1) await sleep(500);
  }
}

async function tgSend(token, chat, text, parseMode) {
  const payload = { chat_id: chat, text, disable_web_page_preview: true };
  if (parseMode) payload.parse_mode = parseMode;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r.ok) return true;
  const body = await r.json().catch(() => ({}));
  if (parseMode && body.description?.includes("can't parse")) return false;
  throw new Error(`Telegram API: ${body.description || r.status}`);
}

function splitByLength(str, max) {
  const out = [];
  let rest = str;
  while (rest.length > 0) {
    if (rest.length <= max) { out.push(rest); break; }
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Email 推送 (Resend) ──────────────────────────
// 同时发送纯文本 + HTML 两个版本，邮件客户端自动择优显示

async function pushToEmail(plainText, richHtml, apiKey, recipient) {
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'Star AI 日报 <digest@resend.dev>',
      to: [recipient],
      subject: `⭐ Star AI 日报 — ${today}`,
      text: plainText,
      html: richHtml,
    }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ message: `HTTP ${r.status}` }));
    throw new Error(`Resend: ${body.message || JSON.stringify(body)}`);
  }
}

// ── Markdown → HTML 渲染器 ───────────────────────

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
  // 统计 ### 开头的人物小标题数量
  const builderMatches = text.match(/^### .+/gm);
  if (builderMatches) sections.builders = builderMatches.length;
  // 检测板块存在
  if (/🇨🇳/.test(text)) {
    const cnSection = text.split(/🇨🇳[^\n]*/)[1]?.split(/\n(?=🌐|🎙|---)/)?.[0] || '';
    const cnParas = cnSection.split(/\n\n/).filter(p => p.trim() && !p.startsWith('🇨🇳'));
    sections.cnArticles = cnParas.length;
  }
  if (/🌐/.test(text)) {
    const blogSection = text.split(/🌐[^\n]*/)[1]?.split(/\n(?=🎙|---)/)?.[0] || '';
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
  const dateShort = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const stats = extractStats(text);

  // 提取标题和主线
  let titleLine = 'Star AI 日报';
  let mainThesis = '';
  const lines = text.split('\n');

  // 提取板块导航信息
  const navItems = [];
  const sectionMap = { '🔥': 'north-america', '🇨🇳': 'china', '🌐': 'global', '🎙': 'podcast' };
  const sectionLabels = { '🔥': '北美 AI 大事', '🇨🇳': '国内 AI 大事', '🌐': 'AI 大厂动态', '🎙': 'AI 超一线播客' };

  // 提取人物列表用于导航
  const personNames = [];

  let html = '';
  let inBlockquote = false;
  let currentSection = '';
  let personCount = 0;
  let inPersonCard = false;
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      html += '<div class="spacer"></div>';
      continue;
    }

    if (inBlockquote && !trimmed.startsWith('>')) {
      html += '</blockquote>';
      inBlockquote = false;
    }

    // --- 分隔线
    if (/^---+$/.test(trimmed)) {
      if (inPersonCard) { html += '</div>'; inPersonCard = false; }
      if (inSection) { html += '</section>'; inSection = false; }
      html += '<div class="divider"></div>';
      continue;
    }

    // 主标题 ⭐ Star AI 日报
    if (trimmed.startsWith('⭐') || /^Star\s?AI/i.test(trimmed)) {
      titleLine = trimmed.replace(/^⭐\s*/, '');
      // 分离题眼：Star AI 日报 | 题眼
      const titleParts = titleLine.split(/\s*\|\s*/);
      if (titleParts.length >= 2) {
        html += `<header class="hero">
  <div class="hero-eyebrow">STAR AI 日报 · ${esc(dateShort)}</div>
  <h1>${esc(titleParts[1])}</h1>`;
      } else {
        html += `<header class="hero">
  <div class="hero-eyebrow">STAR AI 日报 · ${esc(dateShort)}</div>
  <h1>${esc(titleLine)}</h1>`;
      }
      continue;
    }

    // 日期行（纯日期如 2026年3月23日）
    if (/^\d{4}年\d{1,2}月\d{1,2}日/.test(trimmed)) {
      continue; // 已在 hero-eyebrow 中用 dateShort 表示
    }

    // 引用块（> 开头）— 主线判断
    if (trimmed.startsWith('>')) {
      const content = trimmed.replace(/^>\s*/, '');
      if (content.startsWith('今日主线')) {
        mainThesis = content.replace(/^今日主线[：:]\s*/, '');
        html += `<p class="hero-subtitle">${inlineMarkdown(mainThesis)}</p>
  <div class="hero-meta">
    <span>starrliao</span>
    <span>${esc(dateShort)}</span>
    <span>约 ${stats.readMin} 分钟</span>
  </div>
</header>`;
        continue;
      }
      // 其他引用（播客原话等）
      if (!inBlockquote) {
        html += '<blockquote class="callout">';
        inBlockquote = true;
      }
      html += `<p>${inlineMarkdown(content)}</p>`;
      continue;
    }

    // 如果 hero 还没关闭（没有主线判断的情况）
    if (html.includes('<header class="hero">') && !html.includes('</header>')) {
      html += `<div class="hero-meta">
    <span>starrliao</span>
    <span>${esc(dateShort)}</span>
    <span>约 ${stats.readMin} 分钟</span>
  </div>
</header>`;
    }

    // 板块标题（emoji 开头）
    if (/^(?:🔥|🏢|🇨🇳|🌐|🎙)/.test(trimmed)) {
      // 关闭之前打开的 person-card 和 section
      if (inPersonCard) { html += '</div>'; inPersonCard = false; }
      if (inSection) { html += '</section>'; inSection = false; }
      const emoji = trimmed.match(/^(🔥|🏢|🇨🇳|🌐|🎙)/)?.[1] || '';
      const sectionId = sectionMap[emoji] || `section-${navItems.length}`;
      currentSection = sectionId;
      const label = sectionLabels[emoji] || trimmed;
      navItems.push({ id: sectionId, label });
      html += `<section class="section" id="${sectionId}">
  <div class="section-num">Section ${String(navItems.length).padStart(2, '0')}</div>
  <h2>${esc(trimmed)}</h2>`;
      inSection = true;
      continue;
    }

    // 三级标题 ### 人物名 · 身份
    if (trimmed.startsWith('### ')) {
      // 关闭之前打开的 person-card
      if (inPersonCard) { html += '</div>'; inPersonCard = false; }
      personCount++;
      const titleText = trimmed.replace(/^###\s*/, '');
      const parts = titleText.split(/\s*·\s*/);
      const personId = `person-${personCount}`;
      const name = parts[0];
      personNames.push({ id: personId, name });
      if (parts.length >= 2) {
        html += `<div class="person-card" id="${personId}">
  <h3 class="person-name">${esc(parts[0])}<span class="person-role"> · ${esc(parts[1])}</span></h3>`;
      } else {
        html += `<div class="person-card" id="${personId}">
  <h3 class="person-name">${esc(titleText)}</h3>`;
      }
      inPersonCard = true;
      continue;
    }

    // 变化洞察（斜体行 *变化洞察：...*）
    if (/^\*变化洞察[：:]/.test(trimmed)) {
      const content = trimmed.replace(/^\*/, '').replace(/\*$/, '');
      html += `<div class="callout blue"><p><em>${inlineMarkdown(content)}</em></p></div>`;
      continue;
    }

    // 普通段落
    html += `<p>${inlineMarkdown(trimmed)}</p>`;
  }

  if (inBlockquote) html += '</blockquote>';
  if (inPersonCard) html += '</div>';
  if (inSection) html += '</section>';

  // 构建侧边栏导航
  let navHtml = '';
  navItems.forEach(item => {
    navHtml += `<a href="#${item.id}">${esc(item.label)}</a>\n`;
  });

  let personNavHtml = '';
  if (personNames.length > 0) {
    personNavHtml = '<div class="nav-group">人物</div>\n';
    personNames.forEach(p => {
      personNavHtml += `<a href="#${p.id}">${esc(p.name)}</a>\n`;
    });
  }

  // 统计条
  const statParts = [];
  if (stats.builders > 0) statParts.push(`${stats.builders} 位人物`);
  if (stats.cnArticles > 0) statParts.push(`${stats.cnArticles} 条国内资讯`);
  if (stats.blogs > 0) statParts.push(`${stats.blogs} 条官方博客`);
  if (stats.podcasts > 0) statParts.push(`${stats.podcasts} 期播客`);
  statParts.push(`约 ${stats.readMin} 分钟`);

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Star AI 日报 — ${esc(dateStr)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⭐</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Noto+Serif+SC:wght@400;600;700&family=Noto+Sans+SC:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#fafaf9;--surface:#ffffff;--text-primary:#1a1a19;--text-secondary:#57534e;--text-tertiary:#a8a29e;--accent:#dc2626;--accent-soft:#fef2f2;--accent-mid:#f87171;--border:#e7e5e4;--border-light:#f5f5f4;--blue:#2563eb;--blue-soft:#eff6ff;--green:#16a34a;--green-soft:#f0fdf4;--sidebar-w:240px}
*{margin:0;padding:0;box-sizing:border-box}
html{font-size:16px;scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
body{font-family:'Noto Sans SC','Inter',-apple-system,sans-serif;background:var(--bg);color:var(--text-primary);line-height:1.8}
::selection{background:var(--accent);color:#fff}

.scroll-progress{position:fixed;top:0;left:var(--sidebar-w);right:0;height:2px;background:var(--accent);transform-origin:left;transform:scaleX(0);z-index:200;transition:transform .1s linear}

.sidebar{position:fixed;top:0;left:0;width:var(--sidebar-w);height:100vh;background:var(--surface);border-right:1px solid var(--border);padding:32px 20px;overflow-y:auto;z-index:100}
.sidebar-brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.sidebar-brand .logo{width:28px;height:28px;background:var(--accent);border-radius:7px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;font-family:'Inter',sans-serif}
.sidebar-brand span{font-size:12px;font-weight:600;color:var(--text-primary);letter-spacing:.5px}
.sidebar-meta{font-size:10px;color:var(--text-tertiary);margin-bottom:28px;padding-left:38px}
.sidebar nav a{display:block;padding:5px 10px;margin:1px 0;font-size:12px;color:var(--text-secondary);text-decoration:none;border-radius:5px;transition:all .15s;line-height:1.6}
.sidebar nav a:hover{background:var(--border-light);color:var(--text-primary)}
.sidebar nav a.active{background:var(--accent-soft);color:var(--accent);font-weight:500}
.sidebar nav .nav-group{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-tertiary);padding:16px 10px 4px}

.main{margin-left:var(--sidebar-w);max-width:740px;padding:48px 56px 100px 72px}

.hero{margin-bottom:48px;padding-bottom:36px;border-bottom:1px solid var(--border)}
.hero-eyebrow{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--accent);margin-bottom:16px}
.hero h1{font-family:'Noto Serif SC',serif;font-size:32px;font-weight:700;line-height:1.35;color:var(--text-primary);margin-bottom:16px;letter-spacing:-.5px}
.hero-subtitle{font-size:15px;color:var(--text-secondary);line-height:1.8;max-width:580px;font-weight:300;margin-bottom:0}
.hero-meta{display:flex;gap:20px;margin-top:20px;font-size:11px;color:var(--text-tertiary)}

.section{margin-bottom:48px}
.section-num{font-family:'Inter',sans-serif;font-size:10px;font-weight:600;color:var(--accent);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px}
h2{font-family:'Noto Serif SC',serif;font-size:22px;font-weight:700;line-height:1.4;margin-bottom:20px;color:var(--text-primary);letter-spacing:-.3px}

.person-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px 24px;margin:16px 0;transition:box-shadow .2s}
.person-card:hover{box-shadow:0 4px 20px rgba(0,0,0,.04)}
.person-name{font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:10px}
.person-role{font-weight:400;color:var(--text-tertiary);font-size:13px}

p{margin-bottom:12px;color:var(--text-secondary);font-size:14.5px;line-height:1.9}
strong{color:var(--text-primary);font-weight:600}

.callout{background:var(--border-light);border-left:3px solid var(--accent);padding:16px 20px;margin:16px 0;border-radius:0 8px 8px 0}
.callout p{margin:0;font-size:14px;color:var(--text-primary);font-weight:500;line-height:1.8}
.callout.blue{background:var(--blue-soft);border-left-color:var(--blue)}

.inline-link{color:var(--blue);text-decoration:none;font-size:12px;font-weight:500;background:var(--blue-soft);padding:1px 8px;border-radius:100px;transition:all .15s;white-space:nowrap}
.inline-link:hover{background:var(--blue);color:#fff}

.divider{height:1px;background:var(--border);margin:36px 0}
.spacer{height:8px}

.colophon{max-width:740px;margin:0 auto;margin-left:var(--sidebar-w);padding:20px 56px 40px 72px;border-top:1px solid var(--border);text-align:center}
.colophon-brand{font-size:12px;font-weight:600;color:var(--accent);margin-bottom:4px;letter-spacing:.5px}
.colophon-note{font-size:10px;color:var(--text-tertiary);line-height:1.6}

@media(max-width:768px){
  .sidebar{transform:translateX(-100%)}
  .main{margin-left:0;padding:32px 20px 60px}
  .scroll-progress{left:0}
  .colophon{margin-left:0;padding:20px}
  .hero h1{font-size:26px}
}
</style></head>
<body>

<div class="scroll-progress" id="scrollProgress"></div>

<aside class="sidebar">
  <div class="sidebar-brand">
    <div class="logo">S</div>
    <span>STAR · AI DAILY</span>
  </div>
  <div class="sidebar-meta">by starrliao · ${esc(dateShort)}</div>
  <nav>
    <div class="nav-group">板块</div>
    ${navHtml}
    ${personNavHtml}
  </nav>
</aside>

<main class="main">
  ${html}
</main>

<footer class="colophon">
  <div class="colophon-brand">Star AI 日报 · by starrliao</div>
  <div class="colophon-note">横跨 X · YouTube · AI 大厂博客 · 国内媒体 — 关注世界最前沿 AI 阵地，不只 FOMO 跟风</div>
</footer>

<script>
window.addEventListener('scroll',()=>{const h=document.documentElement;const p=h.scrollTop/(h.scrollHeight-h.clientHeight);document.getElementById('scrollProgress').style.transform='scaleX('+p+')'});
const sects=document.querySelectorAll('.section');const lnks=document.querySelectorAll('.sidebar nav a');
const obs=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){lnks.forEach(l=>l.classList.remove('active'));const id=e.target.id;if(id){const l=document.querySelector('.sidebar nav a[href="#'+id+'"]');if(l)l.classList.add('active')}}})},{rootMargin:'-20% 0px -60% 0px'});
sects.forEach(s=>{if(s.id)obs.observe(s)});
document.querySelectorAll('.person-card').forEach(c=>{if(c.id)obs.observe(c)});
</script>
</body></html>`;
}

// ── 主流程 ──────────────────────────────────────

async function buildArchive(text) {
  const webDir = join(DATA_HOME, 'web');
  await mkdir(webDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const archivePath = join(webDir, `digest-${stamp}.html`);
  const latestPath  = join(webDir, 'latest.html');
  const rendered = generateHtmlDigest(text);
  await writeFile(archivePath, rendered);
  await writeFile(latestPath, rendered);
  return { latestPath, rendered };
}

async function main() {
  loadEnv({ path: SECRETS });

  const argv = process.argv.slice(2);
  const archiveOnly = argv.includes('--html-only');

  // 读用户偏好
  let prefs = {};
  if (existsSync(PREFS_PATH)) {
    try { prefs = JSON.parse(await readFile(PREFS_PATH, 'utf-8')); }
    catch { process.stderr.write('config.json 解析失败，使用默认\n'); }
  }

  const channel = prefs.delivery || { method: 'stdout' };
  const body = await readDigestInput();

  if (!body?.trim()) {
    emit({ status: 'skip', reason: '日报内容为空' });
    return;
  }

  // 始终生成 HTML 存档
  let archiveMeta = null;
  try { archiveMeta = await buildArchive(body); }
  catch (e) { process.stderr.write(`HTML 存档失败: ${e.message}\n`); }

  if (archiveOnly) {
    emit({ status: 'ok', channel: 'html-only', note: '网页版日报已生成', html: archiveMeta?.latestPath });
    return;
  }

  // 按渠道投递
  try {
    if (channel.method === 'telegram') {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chat  = channel.chatId;
      if (!token) throw new Error('.env 缺少 TELEGRAM_BOT_TOKEN');
      if (!chat)  throw new Error('config 缺少 delivery.chatId');
      await pushToTelegram(body, token, chat);
      emit({ status: 'ok', channel: 'telegram', note: 'Star AI 日报已推送至 Telegram', html: archiveMeta?.latestPath });

    } else if (channel.method === 'email') {
      const key   = process.env.RESEND_API_KEY;
      const addr  = channel.email;
      if (!key)  throw new Error('.env 缺少 RESEND_API_KEY');
      if (!addr) throw new Error('config 缺少 delivery.email');
      await pushToEmail(body, archiveMeta?.rendered, key, addr);
      emit({ status: 'ok', channel: 'email', note: `Star AI 日报已发送至 ${addr}`, html: archiveMeta?.latestPath });

    } else {
      // stdout：只输出存档结果
      emit({ status: 'ok', channel: 'stdout', note: '网页版日报已生成', html: archiveMeta?.latestPath });
    }
  } catch (e) {
    emit({ status: 'error', channel: channel.method, note: e.message });
    process.exit(1);
  }
}

function emit(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

main().catch(e => {
  process.stderr.write(JSON.stringify({ status: 'error', note: e.message }) + '\n');
  process.exit(1);
});
