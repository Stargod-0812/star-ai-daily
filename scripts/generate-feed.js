#!/usr/bin/env node

// ============================================================================
// Star AI 日报 — 本地 Feed 生成器 (调试/手动用)
// ============================================================================
// 生产环境由 Cloudflare Worker (workers/feed-sync) 自动运行。
// 本脚本用于本地调试、手动生成、或应急补数据。
//
// 用法:
//   X_BEARER_TOKEN=xxx node generate-feed.js
//   X_BEARER_TOKEN=xxx node generate-feed.js --tweets-only
//   X_BEARER_TOKEN=xxx SUPADATA_API_KEY=xxx node generate-feed.js
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- 常量 -------------------------------------------------------------------

const X_API_BASE = 'https://api.x.com/2';
const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 5;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');
const FEED_DAILY_PATH = join(SCRIPT_DIR, '..', 'feed-daily.json');
const ARCHIVE_DIR = join(SCRIPT_DIR, '..', 'archive');

const RSS_SOURCES = [
  { name: '36氪', url: 'https://36kr.com/feed', lang: 'zh', needsFilter: true },
  { name: 'OpenAI', url: 'https://openai.com/blog/rss.xml', lang: 'en', needsFilter: false },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', lang: 'en', needsFilter: false },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', lang: 'en', needsFilter: false },
];

const AI_KEYWORDS = /\bAI\b|人工智能|大模型|LLM|Agent|智能体|GPT|Claude|Gemini|OpenAI|Anthropic|深度学习|神经网络|AIGC|Copilot|Sora|diffusion|transformer|\bRAG\b|embedding|微调|fine.?tun|Cursor|Replit|自动驾驶|\bGPU\b|算力|生成式|机器学习|Coding Agent|开源模型|智能编程|Skills市场/i;

// -- RSS 解析 ----------------------------------------------------------------

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function stripHtml(s) { return decodeEntities(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

function parseRssItems(xml) {
  const items = [];
  let match;
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  while ((match = itemRe.exec(xml)) !== null) {
    const b = match[1];
    const title = exTag(b, 'title'), link = exTag(b, 'link') || exHref(b);
    const pubDate = exTag(b, 'pubDate'), desc = stripHtml(exTag(b, 'description')).slice(0, 200);
    if (title && link) items.push({ title, link, pubDate, description: desc });
  }
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  while ((match = entryRe.exec(xml)) !== null) {
    const b = match[1];
    const title = exTag(b, 'title'), link = exHref(b) || exTag(b, 'link');
    const pubDate = exTag(b, 'published') || exTag(b, 'updated');
    const desc = stripHtml(exTag(b, 'summary') || exTag(b, 'content')).slice(0, 200);
    if (title && link) items.push({ title, link, pubDate, description: desc });
  }
  return items;
}

function exTag(block, tag) {
  const cd = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (cd) return cd[1].trim();
  const pl = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return pl ? pl[1].trim() : '';
}
function exHref(block) {
  const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/);
  return m ? m[1].trim() : '';
}

async function fetchRssArticles(errors) {
  const articles = [];
  for (const source of RSS_SOURCES) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) { errors.push(`RSS: ${source.name} HTTP ${res.status}`); continue; }
      const xml = await res.text();
      let items = parseRssItems(xml);
      if (source.needsFilter) items = items.filter(i => AI_KEYWORDS.test(i.title) || AI_KEYWORDS.test(i.description));
      for (const item of items.slice(0, 5)) {
        articles.push({ source: source.name, lang: source.lang, title: item.title, url: item.link, publishedAt: item.pubDate || null, summary: item.description });
      }
    } catch (e) { errors.push(`RSS: ${source.name} 错误: ${e.message}`); }
  }
  return articles;
}

// -- X API v2 Bearer Token ---------------------------------------------------

async function xFetch(endpoint, queryParams, bearerToken) {
  const qs = Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const fullUrl = qs ? `${X_API_BASE}${endpoint}?${qs}` : `${X_API_BASE}${endpoint}`;
  const res = await fetch(fullUrl, { headers: { 'Authorization': `Bearer ${bearerToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// -- State 管理 --------------------------------------------------------------

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenTweets: {}, seenVideos: {} };
  try { return JSON.parse(await readFile(STATE_PATH, 'utf-8')); }
  catch { return { seenTweets: {}, seenVideos: {} }; }
}

async function saveState(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) { if (ts < cutoff) delete state.seenTweets[id]; }
  for (const [id, ts] of Object.entries(state.seenVideos)) { if (ts < cutoff) delete state.seenVideos[id]; }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  return JSON.parse(await readFile(join(SCRIPT_DIR, '..', 'config', 'default-sources.json'), 'utf-8'));
}

// -- X/Twitter 获取 ----------------------------------------------------------

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  const handles = xAccounts.map(a => a.handle);
  const userMap = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const data = await xFetch('/users/by', { usernames: batch.join(','), 'user.fields': 'name,description' }, bearerToken);
      for (const user of (data.data || [])) userMap[user.username.toLowerCase()] = { id: user.id, name: user.name, description: user.description || '' };
      if (data.errors) for (const e of data.errors) errors.push(`X: 用户 ${e.value || e.resource_id} 未找到`);
    } catch (err) { errors.push(`X: 批量查询失败: ${err.message}`); }
  }

  console.error(`  已解析 ${Object.keys(userMap).length}/${handles.length} 个用户`);

  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) { errors.push(`X: @${account.handle} 未找到，跳过`); continue; }
    try {
      const data = await xFetch(`/users/${userData.id}/tweets`, {
        max_results: '10', 'tweet.fields': 'created_at,public_metrics,referenced_tweets,note_tweet',
        exclude: 'retweets,replies', start_time: cutoff.toISOString(),
      }, bearerToken);

      const newTweets = [];
      for (const t of (data.data || [])) {
        if (state.seenTweets[t.id]) continue;
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;
        newTweets.push({
          id: t.id, text: t.note_tweet?.text || t.text, createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0, retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null,
        });
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;
      results.push({ source: 'x', name: account.name, handle: account.handle, bio: userData.description, tweets: newTweets });
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      if (err.message.includes('429')) { errors.push('X: 限流，停止拉取'); break; }
      errors.push(`X: @${account.handle} 失败: ${err.message}`);
    }
  }
  return results;
}

// -- YouTube/播客获取 --------------------------------------------------------

async function fetchYouTubeContent(podcasts, apiKey, state, errors) {
  if (!apiKey) return [];
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    try {
      const videosUrl = podcast.type === 'youtube_playlist'
        ? `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`
        : `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      const videosRes = await fetch(videosUrl, { headers: { 'x-api-key': apiKey } });
      if (!videosRes.ok) continue;
      const videosData = await videosRes.json();
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      for (const videoId of videoIds.slice(0, 2)) {
        if (state.seenVideos[videoId]) continue;
        try {
          const metaRes = await fetch(`${SUPADATA_BASE}/youtube/video?id=${videoId}`, { headers: { 'x-api-key': apiKey } });
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          allCandidates.push({ podcast, videoId, title: meta.title || 'Untitled', publishedAt: meta.uploadDate || meta.publishedAt || meta.date || null });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) { errors.push(`YouTube: ${videoId} 元数据失败`); }
      }
    } catch (err) { errors.push(`YouTube: ${podcast.name} 失败: ${err.message}`); }
  }

  const withinWindow = allCandidates.filter(v => v.publishedAt && new Date(v.publishedAt) >= cutoff).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const selected = withinWindow[0];
  if (!selected) return [];

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${selected.videoId}`;
    const transcriptRes = await fetch(`${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`, { headers: { 'x-api-key': apiKey } });
    if (!transcriptRes.ok) return [];
    const transcriptData = await transcriptRes.json();
    state.seenVideos[selected.videoId] = Date.now();
    return [{ name: selected.podcast.name, title: selected.title, videoId: selected.videoId, url: `https://youtube.com/watch?v=${selected.videoId}`, publishedAt: selected.publishedAt, transcript: transcriptData.content || '' }];
  } catch (err) { errors.push(`YouTube: 字幕失败: ${err.message}`); return []; }
}

// -- 交叉信号分析 ------------------------------------------------------------

function findSharedTopics(builders) {
  const keywords = [
    'agent', 'agents', 'claude', 'gpt', 'gemini', 'cursor', 'copilot',
    'reasoning', 'scaling', 'inference', 'fine-tuning', 'rag', 'mcp',
    'open source', 'open-source', 'llm', 'multimodal', 'vision', 'voice',
    'code', 'coding', 'vibe coding', 'prompt', 'tool use', 'function calling',
    'training', 'benchmark', 'replit',
    'o1', 'o3', 'o4', 'grok', 'llama', 'mistral', 'deepseek',
    'anthropic', 'openai', 'google', 'meta', 'microsoft', 'apple',
    '大模型', '智能体', 'AIGC', '开源模型',
  ];
  const topicMap = {};
  for (const b of builders) {
    const allText = b.tweets.map(t => t.text).join(' ').toLowerCase();
    for (const kw of keywords) {
      if (allText.includes(kw)) {
        if (!topicMap[kw]) topicMap[kw] = [];
        if (!topicMap[kw].includes(b.handle)) topicMap[kw].push(b.handle);
      }
    }
  }
  const shared = {};
  for (const [topic, mentioners] of Object.entries(topicMap)) {
    if (mentioners.length >= 2) shared[topic] = mentioners;
  }
  return shared;
}

// -- 主流程 ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');

  const bearerToken = process.env.X_BEARER_TOKEN;
  const supadataKey = process.env.SUPADATA_API_KEY;

  if (!podcastsOnly && !bearerToken) {
    console.error('X_BEARER_TOKEN 未设置');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // 推文
  let builders = [];
  if (!podcastsOnly) {
    console.error('正在获取 X/Twitter 内容...');
    builders = await fetchXContent(sources.x_accounts, bearerToken, state, errors);
    console.error(`  ${builders.length} 位人物, ${builders.reduce((s, a) => s + a.tweets.length, 0)} 条推文`);
  }

  // RSS
  let rssArticles = [];
  if (!tweetsOnly) {
    console.error('正在获取 RSS...');
    rssArticles = await fetchRssArticles(errors);
    console.error(`  ${rssArticles.filter(a => a.lang === 'zh').length} 条中文, ${rssArticles.filter(a => a.lang === 'en').length} 条英文`);
  }

  // 播客
  let podcastEpisodes = [];
  if (!tweetsOnly) {
    if (supadataKey) {
      console.error('正在获取播客...');
      podcastEpisodes = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
      console.error(`  ${podcastEpisodes.length} 期节目`);
    } else {
      console.error('  SUPADATA_API_KEY 未设置，跳过播客');
    }
  }

  // 构建 feed
  const cnArticles = rssArticles.filter(a => a.lang === 'zh');
  const enBlogs = rssArticles.filter(a => a.lang === 'en');

  // 动态 engagement 阈值
  const allScores = builders.flatMap(b => b.tweets.map(t => (t.likes || 0) + (t.retweets || 0) * 3));
  const medianScore = allScores.length > 0 ? allScores.sort((a, b) => a - b)[Math.floor(allScores.length / 2)] : 0;
  const highEngagementThreshold = Math.max(medianScore * 3, 100);

  const crossSignals = findSharedTopics(builders);
  const totalTweets = builders.reduce((sum, a) => sum + a.tweets.length, 0);

  const feedDaily = {
    generatedAt: new Date().toISOString(),
    edition: new Date().toISOString().slice(0, 10),
    lookbackHours: TWEET_LOOKBACK_HOURS,
    builders: builders.map(b => ({
      ...b,
      tweets: b.tweets.map(t => {
        const score = (t.likes || 0) + (t.retweets || 0) * 3;
        return { ...t, _metrics: { engagementScore: score, isHighEngagement: score > highEngagementThreshold } };
      }),
    })),
    podcasts: podcastEpisodes,
    cnMedia: cnArticles.map(a => ({ source: a.source, title: a.title, url: a.url, publishedAt: a.publishedAt, summary: a.summary })),
    officialBlogs: enBlogs.map(a => ({ source: a.source, title: a.title, url: a.url, publishedAt: a.publishedAt, summary: a.summary })),
    _crossSignals: { sharedTopics: crossSignals, activeBuilders: builders.length },
    stats: { builders: builders.length, tweets: totalTweets, cnArticles: cnArticles.length, officialBlogs: enBlogs.length, podcasts: podcastEpisodes.length },
  };

  await writeFile(FEED_DAILY_PATH, JSON.stringify(feedDaily, null, 2));

  // archive
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const archiveFeed = { ...feedDaily, podcasts: feedDaily.podcasts.map(p => ({ name: p.name, title: p.title, url: p.url, publishedAt: p.publishedAt })) };
  await writeFile(join(ARCHIVE_DIR, `feed-${feedDaily.edition}.json`), JSON.stringify(archiveFeed, null, 2));

  console.error(`\n✅ feed-daily.json 已生成`);
  console.error(`   ${builders.length} 位人物 | ${totalTweets} 条推文 | ${cnArticles.length} 条中文资讯 | ${enBlogs.length} 条官方博客 | ${podcastEpisodes.length} 期播客`);

  if (errors.length > 0) {
    console.error(`\n⚠️ ${errors.length} 个非致命错误:`);
    for (const e of errors) console.error(`   - ${e}`);
  }

  await saveState(state);
}

main().catch(err => { console.error('Feed 生成失败:', err.message); process.exit(1); });
