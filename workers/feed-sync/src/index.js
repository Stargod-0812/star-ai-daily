// ============================================================================
// Star AI 日报 — Cloudflare Worker (feed-sync)
// ============================================================================
// 完整自主管线：X API + Supadata + RSS → feed-daily.json → Gitee
// 不依赖任何上游数据源
//
// 环境变量 (wrangler secret):
//   X_BEARER_TOKEN   — X API v2 Bearer Token
//   SUPADATA_API_KEY  — Supadata API Key (播客，可选)
//   GITEE_TOKEN       — Gitee Personal Access Token
// ============================================================================

const GITEE_OWNER = 'stargod0812';
const GITEE_REPO = 'star-ai-daily';
const SOURCES_URL = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/raw/master/config/default-sources.json`;

const X_API_BASE = 'https://api.x.com/2';
const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 5;

// --- RSS 源 ---

const RSS_SOURCES = [
  { name: '36氪', url: 'https://36kr.com/feed', lang: 'zh', needsFilter: true },
  { name: 'OpenAI', url: 'https://openai.com/blog/rss.xml', lang: 'en', needsFilter: false },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', lang: 'en', needsFilter: false },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', lang: 'en', needsFilter: false },
];

const AI_KEYWORDS = /\bAI\b|人工智能|大模型|LLM|Agent|智能体|GPT|Claude|Gemini|OpenAI|Anthropic|深度学习|神经网络|AIGC|Copilot|Sora|diffusion|transformer|\bRAG\b|embedding|微调|fine.?tun|Cursor|Replit|自动驾驶|\bGPU\b|算力|生成式|机器学习|Coding Agent|开源模型|智能编程|Skills市场/i;

// --- RSS / Atom parsing ---

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'");
}

function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractLinkHref(block);
    const pubDate = extractTag(block, 'pubDate');
    const desc = extractTag(block, 'description');
    const plainDesc = stripHtml(desc).slice(0, 200);
    if (title && link) items.push({ title, link, pubDate, description: plainDesc });
  }
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractLinkHref(block) || extractTag(block, 'link');
    const pubDate = extractTag(block, 'published') || extractTag(block, 'updated');
    const desc = extractTag(block, 'summary') || extractTag(block, 'content');
    const plainDesc = stripHtml(desc).slice(0, 200);
    if (title && link) items.push({ title, link, pubDate, description: plainDesc });
  }
  return items;
}

function extractTag(block, tag) {
  const cdataMatch = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (cdataMatch) return cdataMatch[1].trim();
  const plainMatch = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return plainMatch ? plainMatch[1].trim() : '';
}

function extractLinkHref(block) {
  const altMatch = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/);
  if (altMatch) return altMatch[1].trim();
  const hrefMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/);
  return hrefMatch ? hrefMatch[1].trim() : '';
}

// --- Gitee API ---

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function pushToGitee(token, filename, content) {
  const apiUrl = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/contents/${filename}`;
  const encoded = toBase64(content);
  const message = `update ${filename}`;

  const existing = await fetch(`${apiUrl}?access_token=${token}`);
  let existingSha = null;
  if (existing.ok) {
    const data = await existing.json();
    // Gitee 对不存在的文件可能返回 200 + []（父目录存在时），需检查 sha
    if (data && !Array.isArray(data) && data.sha) {
      existingSha = data.sha;
    }
  }
  const method = existingSha ? 'PUT' : 'POST';
  const body = { access_token: token, content: encoded, message, ...(existingSha && { sha: existingSha }) };
  const res = await fetch(apiUrl, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

// --- X API v2 (Bearer Token) ---

async function xFetch(endpoint, queryParams, bearerToken) {
  const qs = Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const fullUrl = qs ? `${X_API_BASE}${endpoint}?${qs}` : `${X_API_BASE}${endpoint}`;
  const res = await fetch(fullUrl, {
    headers: { 'Authorization': `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchXContent(bearerToken, errors) {
  // 从 Gitee 拉最新博主列表
  let xAccounts = [];
  try {
    const res = await fetch(SOURCES_URL);
    if (res.ok) {
      const sources = await res.json();
      xAccounts = sources.x_accounts || [];
    } else {
      errors.push('无法加载 default-sources.json');
      return [];
    }
  } catch (e) {
    errors.push(`加载 sources 失败: ${e.message}`);
    return [];
  }

  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  const handles = xAccounts.map(a => a.handle);
  const userMap = {};

  // 批量查用户
  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const data = await xFetch('/users/by', {
        usernames: batch.join(','),
        'user.fields': 'name,description',
      }, bearerToken);
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = { id: user.id, name: user.name, description: user.description || '' };
      }
      if (data.errors) {
        for (const e of data.errors) errors.push(`X: 用户 ${e.value || e.resource_id} 未找到`);
      }
    } catch (err) { errors.push(`X: 批量查询失败: ${err.message}`); }
  }

  console.log(`X: 已解析 ${Object.keys(userMap).length}/${handles.length} 个用户`);

  // 逐个拉时间线
  const builders = [];
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;
    try {
      const data = await xFetch(`/users/${userData.id}/tweets`, {
        max_results: '10',
        'tweet.fields': 'created_at,public_metrics,referenced_tweets,note_tweet',
        exclude: 'retweets,replies',
        start_time: cutoff.toISOString(),
      }, bearerToken);

      const tweets = [];
      for (const t of (data.data || [])) {
        if (tweets.length >= MAX_TWEETS_PER_USER) break;
        tweets.push({
          id: t.id,
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null,
        });
      }

      if (tweets.length > 0) {
        builders.push({
          name: account.name, handle: account.handle,
          bio: userData.description, tweets,
        });
      }
    } catch (err) {
      if (err.message.includes('429')) { errors.push('X: 限流，停止拉取'); break; }
      errors.push(`X: @${account.handle} 失败: ${err.message}`);
    }
  }
  return builders;
}

// --- YouTube/播客 ---

async function fetchPodcasts(supadataKey, errors) {
  if (!supadataKey) return [];
  let podcasts = [];
  try {
    const res = await fetch(SOURCES_URL);
    if (res.ok) {
      const sources = await res.json();
      podcasts = sources.podcasts || [];
    }
  } catch { return []; }

  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    try {
      const videosUrl = podcast.type === 'youtube_playlist'
        ? `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`
        : `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      const videosRes = await fetch(videosUrl, { headers: { 'x-api-key': supadataKey } });
      if (!videosRes.ok) continue;
      const videosData = await videosRes.json();
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      for (const videoId of videoIds.slice(0, 2)) {
        try {
          const metaRes = await fetch(`${SUPADATA_BASE}/youtube/video?id=${videoId}`, { headers: { 'x-api-key': supadataKey } });
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          allCandidates.push({
            podcast, videoId,
            title: meta.title || 'Untitled',
            publishedAt: meta.uploadDate || meta.publishedAt || meta.date || null,
          });
        } catch (err) { errors.push(`YouTube: ${videoId} 元数据失败`); }
      }
    } catch (err) { errors.push(`YouTube: ${podcast.name} 失败: ${err.message}`); }
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
      { headers: { 'x-api-key': supadataKey } },
    );
    if (!transcriptRes.ok) return [];
    const transcriptData = await transcriptRes.json();
    return [{
      name: selected.podcast.name, title: selected.title,
      videoId: selected.videoId, url: `https://youtube.com/watch?v=${selected.videoId}`,
      publishedAt: selected.publishedAt, transcript: transcriptData.content || '',
    }];
  } catch (err) { errors.push(`YouTube: 字幕失败: ${err.message}`); return []; }
}

// --- RSS ---

async function fetchRssArticles(errors) {
  const articles = [];
  for (const source of RSS_SOURCES) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) { errors.push(`RSS: ${source.name} HTTP ${res.status}`); continue; }
      const xml = await res.text();
      let items = parseRssItems(xml);
      if (source.needsFilter) {
        items = items.filter(item => AI_KEYWORDS.test(item.title) || AI_KEYWORDS.test(item.description));
      }
      for (const item of items.slice(0, 5)) {
        articles.push({
          source: source.name, lang: source.lang,
          title: item.title, url: item.link,
          publishedAt: item.pubDate || null, summary: item.description,
        });
      }
    } catch (e) { errors.push(`RSS: ${source.name} 错误: ${e.message}`); }
  }
  return articles;
}

// --- 交叉信号 ---

const SIGNAL_TERMS = [
  { term: 'AI', wordBoundary: true },
  { term: 'LLM', wordBoundary: true },
  { term: 'GPT', wordBoundary: true },
  { term: 'Claude', wordBoundary: true },
  { term: 'Gemini', wordBoundary: true },
  { term: 'Cursor', wordBoundary: true },
  { term: 'Copilot', wordBoundary: true },
  { term: 'Replit', wordBoundary: true },
  { term: 'agent', wordBoundary: false },
  { term: 'coding', wordBoundary: true },
  { term: 'reasoning', wordBoundary: true },
  { term: 'inference', wordBoundary: true },
  { term: 'training', wordBoundary: true },
  { term: 'fine-tuning', wordBoundary: false },
  { term: 'open source', wordBoundary: false },
  { term: 'benchmark', wordBoundary: true },
  { term: 'multimodal', wordBoundary: false },
  { term: 'voice', wordBoundary: true },
  { term: 'RAG', wordBoundary: true },
  { term: 'MCP', wordBoundary: true },
  { term: 'OpenAI', wordBoundary: false },
  { term: 'Anthropic', wordBoundary: false },
  { term: 'Google', wordBoundary: true },
  { term: 'Meta', wordBoundary: true },
  { term: 'Apple', wordBoundary: true },
  { term: '大模型', wordBoundary: false },
  { term: '智能体', wordBoundary: false },
  { term: 'AIGC', wordBoundary: true },
  { term: '开源模型', wordBoundary: false },
  { term: 'vibe coding', wordBoundary: false },
  { term: 'deepseek', wordBoundary: false },
  { term: 'scaling', wordBoundary: true },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSharedTopics(builders) {
  const termByBuilder = {};
  for (const { term, wordBoundary } of SIGNAL_TERMS) {
    const escaped = escapeRegExp(term);
    const pattern = wordBoundary ? `\\b${escaped}\\b` : escaped;
    const re = new RegExp(pattern, 'i');
    const mentionedBy = builders
      .filter(b => b.tweets.some(t => re.test(t.text)))
      .map(b => b.handle);
    if (mentionedBy.length >= 2) termByBuilder[term] = mentionedBy;
  }
  return termByBuilder;
}

// --- 构建 feed ---

function buildDailyFeed(builders, rssArticles, podcastEpisodes) {
  const cnArticles = rssArticles.filter(a => a.lang === 'zh');
  const enBlogs = rssArticles.filter(a => a.lang === 'en');

  // 动态 engagement 阈值
  const allScores = builders.flatMap(b => b.tweets.map(t => (t.likes || 0) + (t.retweets || 0) * 3));
  const medianScore = allScores.length > 0
    ? allScores.sort((a, b) => a - b)[Math.floor(allScores.length / 2)]
    : 0;
  const highEngagementThreshold = Math.max(medianScore * 3, 100);

  const today = new Date().toISOString().slice(0, 10);
  return {
    edition: today,
    generatedAt: new Date().toISOString(),
    lookbackHours: TWEET_LOOKBACK_HOURS,

    builders: builders.map(b => ({
      source: 'x', name: b.name, handle: b.handle, bio: b.bio,
      tweets: b.tweets.map(t => {
        const score = (t.likes || 0) + (t.retweets || 0) * 3;
        return {
          ...t,
          _metrics: { engagementScore: score, isHighEngagement: score > highEngagementThreshold },
        };
      }),
    })),

    cnMedia: cnArticles.map(a => ({
      source: a.source, title: a.title, url: a.url,
      publishedAt: a.publishedAt, summary: a.summary,
    })),

    officialBlogs: enBlogs.map(a => ({
      source: a.source, title: a.title, url: a.url,
      publishedAt: a.publishedAt, summary: a.summary,
    })),

    podcasts: podcastEpisodes.map(p => ({
      name: p.name, title: p.title, url: p.url,
      publishedAt: p.publishedAt, transcript: p.transcript || '',
    })),

    _crossSignals: {
      sharedTopics: findSharedTopics(builders),
      activeBuilders: builders.length,
    },

    stats: {
      builders: builders.length,
      tweets: builders.reduce((sum, b) => sum + b.tweets.length, 0),
      cnArticles: cnArticles.length,
      officialBlogs: enBlogs.length,
      podcasts: podcastEpisodes.length,
    },
  };
}

// --- Archive (去掉 transcript 节省空间) ---

function buildArchiveFeed(dailyFeed) {
  return {
    ...dailyFeed,
    podcasts: dailyFeed.podcasts.map(p => ({
      name: p.name, title: p.title, url: p.url, publishedAt: p.publishedAt,
    })),
  };
}

// --- 主流程 ---

async function run(env) {
  const errors = [];

  // 并行获取三大数据源
  const [builders, rssArticles, podcastEpisodes] = await Promise.all([
    env.X_BEARER_TOKEN ? fetchXContent(env.X_BEARER_TOKEN, errors) : Promise.resolve([]),
    fetchRssArticles(errors),
    fetchPodcasts(env.SUPADATA_API_KEY, errors),
  ]);

  if (!env.X_BEARER_TOKEN) errors.push('X_BEARER_TOKEN 未设置，跳过推文');

  const dailyFeed = buildDailyFeed(builders, rssArticles, podcastEpisodes);

  // 全部为空时不覆盖
  const totalContent = dailyFeed.stats.builders + dailyFeed.stats.cnArticles
    + dailyFeed.stats.officialBlogs + dailyFeed.stats.podcasts;
  if (totalContent === 0) {
    const msg = '所有数据源返回空 — 跳过推送，避免覆盖已有数据';
    console.log(msg);
    return { ok: false, archiveOk: false, stats: dailyFeed.stats, errors, message: msg };
  }

  // 并行推送 feed-daily.json 和 archive
  const content = JSON.stringify(dailyFeed, null, 2);
  const archivePath = `archive/feed-${dailyFeed.edition}.json`;
  const archiveContent = JSON.stringify(buildArchiveFeed(dailyFeed), null, 2);
  const [ok, archiveOk] = await Promise.all([
    pushToGitee(env.GITEE_TOKEN, 'feed-daily.json', content),
    pushToGitee(env.GITEE_TOKEN, archivePath, archiveContent),
  ]);

  const msg = `${dailyFeed.stats.builders} builders, ${dailyFeed.stats.tweets} tweets, ${dailyFeed.stats.cnArticles} cn, ${dailyFeed.stats.officialBlogs} blogs, ${dailyFeed.stats.podcasts} pods → daily:${ok ? 'OK' : 'FAIL'} archive:${archiveOk ? 'OK' : 'FAIL'}`;
  console.log(msg);
  if (errors.length > 0) console.log(`${errors.length} 个非致命错误:`, errors.join('; '));
  return { ok, archiveOk, stats: dailyFeed.stats, errors, message: msg };
}

export default {
  async scheduled(event, env, ctx) {
    await run(env);
  },

  async fetch(request, env) {
    const result = await run(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
