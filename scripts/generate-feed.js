#!/usr/bin/env node

// ============================================================================
// Star AI 日报 — 中心化 Feed 生成器
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const X_API_BASE = 'https://api.x.com/2';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

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

async function fetchYouTubeContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];
  for (const podcast of podcasts) {
    try {
      let videosUrl = podcast.type === 'youtube_playlist'
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
          allCandidates.push({ podcast, videoId, title: meta.title || 'Untitled', publishedAt: meta.uploadDate || meta.publishedAt || meta.date || null });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) { errors.push(`YouTube: ${videoId} 元数据获取失败: ${err.message}`); }
      }
    } catch (err) { errors.push(`YouTube: ${podcast.name} 处理出错: ${err.message}`); }
  }
  const withinWindow = allCandidates.filter(v => v.publishedAt && new Date(v.publishedAt) >= cutoff).sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  const selected = withinWindow[0];
  if (!selected) return [];
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${selected.videoId}`;
    const transcriptRes = await fetch(`${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`, { headers: { 'x-api-key': apiKey } });
    if (!transcriptRes.ok) { errors.push(`YouTube: ${selected.videoId} 字幕获取失败`); return []; }
    const transcriptData = await transcriptRes.json();
    state.seenVideos[selected.videoId] = Date.now();
    return [{ source: 'podcast', name: selected.podcast.name, title: selected.title, videoId: selected.videoId, url: `https://youtube.com/watch?v=${selected.videoId}`, publishedAt: selected.publishedAt, transcript: transcriptData.content || '' }];
  } catch (err) { errors.push(`YouTube: ${selected.videoId} 字幕获取出错: ${err.message}`); return []; }
}

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  const handles = xAccounts.map(a => a.handle);
  let userMap = {};
  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(`${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`, { headers: { 'Authorization': `Bearer ${bearerToken}` } });
      if (!res.ok) { errors.push(`X API: 用户查询失败: HTTP ${res.status}`); continue; }
      const data = await res.json();
      for (const user of (data.data || [])) { userMap[user.username.toLowerCase()] = { id: user.id, name: user.name, description: user.description || '' }; }
    } catch (err) { errors.push(`X API: 用户查询出错: ${err.message}`); }
  }
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;
    try {
      const res = await fetch(`${X_API_BASE}/users/${userData.id}/tweets?max_results=5&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet&exclude=retweets,replies&start_time=${cutoff.toISOString()}`, { headers: { 'Authorization': `Bearer ${bearerToken}` } });
      if (!res.ok) { if (res.status === 429) { errors.push(`X API: 触发限流`); break; } errors.push(`X API: @${account.handle} 获取失败`); continue; }
      const data = await res.json();
      const newTweets = [];
      for (const t of (data.data || [])) {
        if (state.seenTweets[t.id]) continue;
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;
        newTweets.push({ id: t.id, text: t.note_tweet?.text || t.text, createdAt: t.created_at, url: `https://x.com/${account.handle}/status/${t.id}`, likes: t.public_metrics?.like_count || 0, retweets: t.public_metrics?.retweet_count || 0, replies: t.public_metrics?.reply_count || 0, isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false, quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null });
        state.seenTweets[t.id] = Date.now();
      }
      if (newTweets.length === 0) continue;
      results.push({ source: 'x', name: account.name, handle: account.handle, bio: userData.description, tweets: newTweets });
      await new Promise(r => setTimeout(r, 200));
    } catch (err) { errors.push(`X API: @${account.handle} 获取出错: ${err.message}`); }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');
  const xBearerToken = process.env.X_BEARER_TOKEN;
  const supadataKey = process.env.SUPADATA_API_KEY;
  if (!tweetsOnly && !supadataKey) { console.error('SUPADATA_API_KEY 未设置'); process.exit(1); }
  if (!podcastsOnly && !xBearerToken) { console.error('X_BEARER_TOKEN 未设置'); process.exit(1); }
  const sources = await loadSources();
  const state = await loadState();
  const errors = [];
  let xContent = [];
  if (!podcastsOnly) {
    console.error('正在获取 X/Twitter 内容...');
    xContent = await fetchXContent(sources.x_accounts, xBearerToken, state, errors);
    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xFeed = { generatedAt: new Date().toISOString(), lookbackHours: TWEET_LOOKBACK_HOURS, x: xContent, stats: { xBuilders: xContent.length, totalTweets } };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json: ${xContent.length} 位建造者, ${totalTweets} 条推文`);
  }
  let podcasts = [];
  if (!tweetsOnly) {
    console.error('正在获取 YouTube 内容...');
    podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
    const podcastFeed = { generatedAt: new Date().toISOString(), lookbackHours: PODCAST_LOOKBACK_HOURS, podcasts, stats: { podcastEpisodes: podcasts.length } };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));
    console.error(`  feed-podcasts.json: ${podcasts.length} 期节目`);
  }
  await saveState(state);
  if (errors.length > 0) console.error(`  ${errors.length} 个非致命错误`);
}

main().catch(err => { console.error('Feed 生成失败:', err.message); process.exit(1); });
