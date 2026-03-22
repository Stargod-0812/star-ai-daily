#!/usr/bin/env node

// ============================================================================
// Star AI 日报 — 中心化 Feed 生成器
// ============================================================================
// 使用 X API v2 (Bearer Token) 获取推文，Supadata 获取播客
// 输出合并的 feed-daily.json，直接供 prepare-digest.js 使用
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
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

// -- X API v2 Bearer Token 请求 ---------------------------------------------

async function xFetch(endpoint, queryParams, bearerToken) {
  const baseUrl = `${X_API_BASE}${endpoint}`;
  const qs = Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const fullUrl = qs ? `${baseUrl}?${qs}` : baseUrl;

  const res = await fetch(fullUrl, {
    headers: { 'Authorization': `Bearer ${bearerToken}` }
  });

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

  // 批量查用户（每批最多 100 个）
  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const data = await xFetch('/users/by', {
        usernames: batch.join(','),
        'user.fields': 'name,description'
      }, bearerToken);
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = { id: user.id, name: user.name, description: user.description || '' };
      }
      if (data.errors) {
        for (const e of data.errors) {
          errors.push(`X API: 用户 ${e.value || e.resource_id} 未找到`);
        }
      }
    } catch (err) { errors.push(`X API: 用户批量查询失败: ${err.message}`); }
  }

  console.error(`  已解析 ${Object.keys(userMap).length}/${handles.length} 个用户`);

  // 逐个拉时间线
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) { errors.push(`X API: @${account.handle} 未找到，跳过`); continue; }
    try {
      const data = await xFetch(`/users/${userData.id}/tweets`, {
        max_results: '10',
        'tweet.fields': 'created_at,public_metrics,referenced_tweets,note_tweet',
        exclude: 'retweets,replies',
        start_time: cutoff.toISOString()
      }, bearerToken);

      const newTweets = [];
      for (const t of (data.data || [])) {
        if (state.seenTweets[t.id]) continue;
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        const engagementScore = (t.public_metrics?.like_count || 0) + (t.public_metrics?.retweet_count || 0) * 3;

        newTweets.push({
          id: t.id,
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null,
          _metrics: { engagementScore, isHighEngagement: engagementScore > 500 }
        });
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;
      results.push({
        source: 'x', name: account.name, handle: account.handle,
        bio: userData.description, tweets: newTweets
      });

      // 限流保护：每个用户间隔 200ms
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      if (err.message.includes('429')) { errors.push('X API: 触发限流，停止拉取'); break; }
      errors.push(`X API: @${account.handle} 获取失败: ${err.message}`);
    }
  }
  return results;
}

// -- 交叉信号分析 ------------------------------------------------------------

function analyzeCrossSignals(builders) {
  const topicMap = {};
  const keywords = [
    'agent', 'agents', 'claude', 'gpt', 'gemini', 'cursor', 'copilot',
    'reasoning', 'scaling', 'inference', 'fine-tuning', 'rag', 'mcp',
    'open source', 'open-source', 'llm', 'multimodal', 'vision',
    'code', 'coding', 'vibe coding', 'prompt', 'tool use', 'function calling',
    'o1', 'o3', 'o4', 'grok', 'llama', 'mistral', 'deepseek',
    'anthropic', 'openai', 'google', 'meta', 'microsoft'
  ];

  for (const b of builders) {
    const allText = b.tweets.map(t => t.text).join(' ').toLowerCase();
    for (const kw of keywords) {
      if (allText.includes(kw)) {
        if (!topicMap[kw]) topicMap[kw] = [];
        if (!topicMap[kw].includes(b.handle)) topicMap[kw].push(b.handle);
      }
    }
  }

  const sharedTopics = {};
  for (const [topic, mentioners] of Object.entries(topicMap)) {
    if (mentioners.length >= 2) sharedTopics[topic] = mentioners;
  }

  return { sharedTopics, activeBuilders: builders.length };
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
      if (!videosRes.ok) { errors.push(`YouTube: ${podcast.name} 获取失败: HTTP ${videosRes.status}`); continue; }
      const videosData = await videosRes.json();
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      for (const videoId of videoIds.slice(0, 2)) {
        if (state.seenVideos[videoId]) continue;
        try {
          const metaRes = await fetch(`${SUPADATA_BASE}/youtube/video?id=${videoId}`, { headers: { 'x-api-key': apiKey } });
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          allCandidates.push({
            podcast, videoId,
            title: meta.title || 'Untitled',
            publishedAt: meta.uploadDate || meta.publishedAt || meta.date || null
          });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) { errors.push(`YouTube: ${videoId} 元数据获取失败: ${err.message}`); }
      }
    } catch (err) { errors.push(`YouTube: ${podcast.name} 处理出错: ${err.message}`); }
  }

  const withinWindow = allCandidates
    .filter(v => v.publishedAt && new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const selected = withinWindow[0];
  if (!selected) return [];

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${selected.videoId}`;
    const transcriptRes = await fetch(
      `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': apiKey } }
    );
    if (!transcriptRes.ok) { errors.push(`YouTube: ${selected.videoId} 字幕获取失败`); return []; }
    const transcriptData = await transcriptRes.json();
    state.seenVideos[selected.videoId] = Date.now();
    return [{
      source: 'podcast', name: selected.podcast.name, title: selected.title,
      videoId: selected.videoId, url: `https://youtube.com/watch?v=${selected.videoId}`,
      publishedAt: selected.publishedAt, transcript: transcriptData.content || ''
    }];
  } catch (err) { errors.push(`YouTube: ${selected.videoId} 字幕获取出错: ${err.message}`); return []; }
}

// -- 主流程 ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');

  // X API Bearer Token
  const bearerToken = process.env.X_BEARER_TOKEN;
  const supadataKey = process.env.SUPADATA_API_KEY;

  if (!podcastsOnly && !bearerToken) {
    console.error('X API Bearer Token 未设置 (X_BEARER_TOKEN)');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // -- 获取推文 --
  let builders = [];
  if (!podcastsOnly) {
    console.error('正在获取 X/Twitter 内容...');
    builders = await fetchXContent(sources.x_accounts, bearerToken, state, errors);
    const totalTweets = builders.reduce((sum, a) => sum + a.tweets.length, 0);
    console.error(`  ${builders.length} 位建造者, ${totalTweets} 条推文`);
  }

  // -- 获取播客 --
  let podcasts = [];
  if (!tweetsOnly) {
    if (supadataKey) {
      console.error('正在获取 YouTube 内容...');
      podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
      console.error(`  ${podcasts.length} 期节目`);
    } else {
      console.error('  SUPADATA_API_KEY 未设置，跳过播客');
    }
  }

  // -- 交叉信号 --
  const crossSignals = analyzeCrossSignals(builders);

  // -- 计算统计 --
  const totalTweets = builders.reduce((sum, a) => sum + a.tweets.length, 0);

  // -- 输出合并的 feed-daily.json --
  const feedDaily = {
    generatedAt: new Date().toISOString(),
    edition: new Date().toISOString().slice(0, 10),
    lookbackHours: TWEET_LOOKBACK_HOURS,

    builders,
    podcasts,
    cnMedia: [],        // 暂空，后续可接入中文媒体 RSS
    officialBlogs: [],  // 暂空，后续可接入官方博客 RSS

    _crossSignals: crossSignals,

    stats: {
      builders: builders.length,
      tweets: totalTweets,
      cnArticles: 0,
      officialBlogs: 0,
      podcasts: podcasts.length
    }
  };

  await writeFile(FEED_DAILY_PATH, JSON.stringify(feedDaily, null, 2));
  console.error(`\n✅ feed-daily.json 已生成`);
  console.error(`   ${builders.length} 位建造者 | ${totalTweets} 条推文 | ${podcasts.length} 期播客`);

  if (errors.length > 0) {
    console.error(`\n⚠️ ${errors.length} 个非致命错误:`);
    for (const e of errors) console.error(`   - ${e}`);
  }

  await saveState(state);
}

main().catch(err => { console.error('Feed 生成失败:', err.message); process.exit(1); });
