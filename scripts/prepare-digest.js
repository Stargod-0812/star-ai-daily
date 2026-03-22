#!/usr/bin/env node

// ============================================================================
// Star AI 日报 — 内容准备脚本
// ============================================================================

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.star-ai-daily');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const FEED_BASE = 'https://gitee.com/stargod0812/star-ai-daily/raw/master';
const FEED_DAILY_URL = `${FEED_BASE}/feed-daily.json`;
const PROMPTS_BASE = `${FEED_BASE}/prompts`;
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-cn-articles.md',
  'signal-guide.md',
  'daily-diff.md',
  'digest-intro.md',
  'translate.md'
];

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fetchText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function main() {
  const errors = [];

  // 配置：合并而非覆盖，确保部分配置也能工作
  const defaultConfig = {
    language: 'zh',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  let config = { ...defaultConfig };
  if (existsSync(CONFIG_PATH)) {
    try {
      const userConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
      config = { ...defaultConfig, ...userConfig };
    } catch (err) {
      errors.push(`配置读取失败: ${err.message}`);
    }
  }

  const dailyFeed = await fetchJSON(FEED_DAILY_URL);
  if (!dailyFeed) errors.push('daily feed 获取失败');

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yesterdayURL = `https://gitee.com/stargod0812/star-ai-daily/raw/master/archive/feed-${yesterday}.json`;
  const feedYesterday = await fetchJSON(yesterdayURL);

  const prompts = {};
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  // 并行加载所有 prompt（优先级：用户自定义 > 本地 > 远程）
  await Promise.all(PROMPT_FILES.map(async (filename) => {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      return;
    }
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
      return;
    }
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
    } else {
      errors.push(`Prompt 加载失败: ${filename}`);
    }
  }));

  const feedFailed = !dailyFeed;

  const output = {
    status: feedFailed ? 'error' : (errors.length > 0 ? 'degraded' : 'ok'),
    generatedAt: new Date().toISOString(),
    brand: 'Star AI 日报',

    config: {
      language: config.language || 'zh',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    x: dailyFeed?.builders || [],
    podcasts: dailyFeed?.podcasts || [],
    cnArticles: dailyFeed?.cnMedia || [],
    officialBlogs: dailyFeed?.officialBlogs || [],
    _crossSignals: dailyFeed?._crossSignals || null,

    yesterday: feedYesterday ? {
      edition: feedYesterday.edition,
      builders: (feedYesterday.builders || []).map(b => b.handle),
      cnTitles: (feedYesterday.cnMedia || []).map(a => a.title),
      blogTitles: (feedYesterday.officialBlogs || []).map(a => a.title),
    } : null,

    stats: {
      xBuilders: dailyFeed?.stats?.builders || 0,
      totalTweets: dailyFeed?.stats?.tweets || 0,
      cnArticles: dailyFeed?.stats?.cnArticles || 0,
      officialBlogs: dailyFeed?.stats?.officialBlogs || 0,
      podcastEpisodes: dailyFeed?.stats?.podcasts || 0,
      feedGeneratedAt: dailyFeed?.generatedAt || null
    },

    prompts,

    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
