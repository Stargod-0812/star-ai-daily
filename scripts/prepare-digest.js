#!/usr/bin/env node

// ============================================================================
// Star AI 日报 — 内容准备脚本
// ============================================================================

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.star-ai-daily');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const FEED_DAILY_URL = 'https://gitee.com/stargod0812/star-ai-daily/raw/master/feed-daily.json';

const FEED_BASE = 'https://raw.githubusercontent.com/Stargod-0812/star-ai-daily/main';
const PROMPTS_BASE = `${FEED_BASE}/prompts`;
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-cn-articles.md',
  'signal-guide.md',
  'digest-intro.md',
  'translate.md'
];

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

async function main() {
  const errors = [];

  let config = {
    language: 'zh',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`配置读取失败: ${err.message}`);
    }
  }

  const dailyFeed = await fetchJSON(FEED_DAILY_URL);
  if (!dailyFeed) errors.push('daily feed 获取失败');

  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
      continue;
    }

    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
    } else {
      errors.push(`Prompt 加载失败: ${filename}`);
    }
  }

  const output = {
    status: 'ok',
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
