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

// Star AI 日报的上游 feed 数据源
const FEED_BASE = 'https://raw.githubusercontent.com/Stargod-0812/star-ai-daily/main';
const FEED_X_URL = `${FEED_BASE}/feed-x.json`;
const FEED_PODCASTS_URL = `${FEED_BASE}/feed-podcasts.json`;

const PROMPTS_BASE = `${FEED_BASE}/prompts`;
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
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

  const [feedX, feedPodcasts] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL)
  ]);

  if (!feedX) errors.push('推文 feed 获取失败');
  if (!feedPodcasts) errors.push('播客 feed 获取失败');

  // 加载 prompt，优先级：用户自定义 > 本地(Star版) > 远程(兜底)
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

    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],

    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || null
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
