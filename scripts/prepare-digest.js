#!/usr/bin/env node

/**
 * Star AI 日报 · 数据聚合器
 *
 * 从 Gitee 拉取 feed + prompt，合并用户配置，
 * 输出一份完整的 JSON payload 供 LLM 混编。
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ── 路径 ──────────────────────────────────────────
const APP_DIR  = join(homedir(), '.star-ai-daily');
const CFG_FILE = join(APP_DIR, 'config.json');
const REPO_ROOT = 'https://gitee.com/stargod0812/star-ai-daily/raw/master';

// 所有需要加载的 prompt，按功能分组
const PROMPTS = [
  'digest-intro.md',       // 排版 & 板块规则
  'summarize-tweets.md',   // X 人物摘要
  'summarize-podcast.md',  // 播客精炼
  'summarize-cn-articles.md', // 国内资讯
  'signal-guide.md',       // 信号判读
  'daily-diff.md',         // 变化洞察
  'translate.md',          // 中文翻译
];

// ── HTTP 工具 ─────────────────────────────────────
async function grab(url, mode = 'json') {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return mode === 'json' ? await r.json() : await r.text();
  } catch { return null; }
}

// ── Prompt 加载（三级回退） ───────────────────────
async function loadPrompts(scriptPath, warnings) {
  const builtinDir = join(dirname(scriptPath), '..', 'prompts');
  const customDir  = join(APP_DIR, 'prompts');
  const loaded = {};

  await Promise.all(PROMPTS.map(async (file) => {
    const slug = file.replace('.md', '').replace(/-/g, '_');
    const custom  = join(customDir, file);
    const builtin = join(builtinDir, file);

    // 1️⃣ 用户自定义覆盖
    try { loaded[slug] = await readFile(custom, 'utf-8'); return; } catch {}
    // 2️⃣ 本地内置
    try { loaded[slug] = await readFile(builtin, 'utf-8'); return; } catch {}
    // 3️⃣ 从 Gitee 远程拉取
    const txt = await grab(`${REPO_ROOT}/prompts/${file}`, 'text');
    if (txt) loaded[slug] = txt;
    else warnings.push(`Prompt 加载失败: ${file}`);
  }));

  return loaded;
}

// ── 内容精简（控制 JSON 体积，确保自动化场景一次读完）──
const MAX_TRANSCRIPT = 20000;  // 播客文字稿上限
const MAX_TWEETS_PER = 3;      // 每人保留推文数

function trimPayload(payload) {
  // 播客：截断 transcript
  if (payload.podcasts) {
    for (const p of payload.podcasts) {
      if (p.transcript && p.transcript.length > MAX_TRANSCRIPT) {
        p.transcript = p.transcript.slice(0, MAX_TRANSCRIPT) + '\n\n[… 文字稿已截断，完整内容见原节目链接]';
      }
    }
  }
  // 推文：每人只保留 engagement 最高的几条
  if (payload.x) {
    for (const person of payload.x) {
      if (person.tweets && person.tweets.length > MAX_TWEETS_PER) {
        person.tweets.sort((a, b) =>
          (b._metrics?.engagementScore || 0) - (a._metrics?.engagementScore || 0)
        );
        person.tweets = person.tweets.slice(0, MAX_TWEETS_PER);
      }
    }
  }
  return payload;
}

// ── 主流程 ────────────────────────────────────────
async function run() {
  const warnings = [];

  // 读用户配置（缺省值内联在这里，比单独写 defaultConfig 对象更紧凑）
  let cfg = { language: 'zh', frequency: 'daily', delivery: { method: 'stdout' } };
  try {
    const raw = JSON.parse(await readFile(CFG_FILE, 'utf-8'));
    cfg = { ...cfg, ...raw };
  } catch {
    // 文件不存在或解析出错，使用默认值
  }

  // 并行拉取：今日 feed + 昨日 feed + prompts（三者互不依赖）
  const todayUrl = `${REPO_ROOT}/feed-daily.json`;
  const yDate    = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const yUrl     = `${REPO_ROOT}/archive/feed-${yDate}.json`;
  const thisFile = fileURLToPath(import.meta.url);
  const [feed, prevFeed, prompts] = await Promise.all([
    grab(todayUrl),
    grab(yUrl),
    loadPrompts(thisFile, warnings),
  ]);

  if (!feed) warnings.push('feed-daily.json 拉取失败');

  // 组装输出
  const payload = {
    status: !feed ? 'error' : warnings.length ? 'degraded' : 'ok',
    ts: new Date().toISOString(),
    brand: 'Star AI 日报',

    cfg: {
      lang:     cfg.language  || 'zh',
      freq:     cfg.frequency || 'daily',
      delivery: cfg.delivery  || { method: 'stdout' },
    },

    // 内容
    x:             feed?.builders     || [],
    podcasts:      feed?.podcasts     || [],
    cnArticles:    feed?.cnMedia      || [],
    officialBlogs: feed?.officialBlogs || [],
    crossSignals:  feed?._crossSignals || null,

    // 昨日快照（用于变化洞察）
    prev: prevFeed ? {
      date:       prevFeed.edition,
      handles:    (prevFeed.builders     || []).map(b => b.handle),
      cnHeads:    (prevFeed.cnMedia      || []).map(a => a.title),
      blogHeads:  (prevFeed.officialBlogs || []).map(a => a.title),
    } : null,

    // 统计
    nums: {
      people:   feed?.stats?.builders    || 0,
      tweets:   feed?.stats?.tweets      || 0,
      cn:       feed?.stats?.cnArticles  || 0,
      blogs:    feed?.stats?.officialBlogs || 0,
      pods:     feed?.stats?.podcasts    || 0,
      feedTime: feed?.generatedAt        || null,
    },

    prompts: undefined, // prompts 由 agent 从 skill 目录直接读取，不再塞进 JSON
    warnings: warnings.length ? warnings : undefined,
  };

  process.stdout.write(JSON.stringify(trimPayload(payload), null, 2));
}

run().catch(e => {
  process.stderr.write(JSON.stringify({ status: 'error', msg: e.message }));
  process.exit(1);
});
