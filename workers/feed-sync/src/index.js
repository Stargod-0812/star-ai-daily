const UPSTREAM = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main';
const GITEE_OWNER = 'stargod0812';
const GITEE_REPO = 'star-ai-daily';

const RSS_SOURCES = [
  { name: '36氪', url: 'https://36kr.com/feed', lang: 'zh', needsFilter: true },
  { name: 'OpenAI', url: 'https://openai.com/blog/rss.xml', lang: 'en', needsFilter: false },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', lang: 'en', needsFilter: false },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', lang: 'en', needsFilter: false },
];

const AI_KEYWORDS = /\bAI\b|人工智能|大模型|LLM|Agent|智能体|GPT|Claude|Gemini|OpenAI|Anthropic|深度学习|神经网络|AIGC|Copilot|Sora|diffusion|transformer|\bRAG\b|embedding|微调|fine.?tun|Cursor|Replit|自动驾驶|\bGPU\b|算力|生成式|机器学习|Coding Agent|开源模型|智能编程|Skills市场/i;

// --- RSS parsing ---

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const desc = extractTag(block, 'description');
    const decoded = desc.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'");
    const plainDesc = decoded.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (title && link) items.push({ title, link, pubDate, description: plainDesc });
  }
  return items;
}

function extractTag(block, tag) {
  const cdataMatch = block.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (cdataMatch) return cdataMatch[1].trim();
  const plainMatch = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return plainMatch ? plainMatch[1].trim() : '';
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
  if (existing.ok) {
    const data = await existing.json();
    const res = await fetch(apiUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        content: encoded,
        message,
        sha: data.sha,
      }),
    });
    return res.ok;
  } else {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        content: encoded,
        message,
      }),
    });
    return res.ok;
  }
}

// --- Data fetching ---

async function fetchUpstreamFeeds() {
  const results = {};
  for (const file of ['feed-x.json', 'feed-podcasts.json']) {
    try {
      const res = await fetch(`${UPSTREAM}/${file}`);
      if (res.ok) results[file] = await res.json();
    } catch (e) { /* skip */ }
  }
  return results;
}

async function fetchRssArticles() {
  const articles = [];
  for (const source of RSS_SOURCES) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) continue;
      const xml = await res.text();
      let items = parseRssItems(xml);
      if (source.needsFilter) {
        items = items.filter(item =>
          AI_KEYWORDS.test(item.title) || AI_KEYWORDS.test(item.description)
        );
      }
      for (const item of items.slice(0, 5)) {
        articles.push({
          source: source.name,
          lang: source.lang,
          title: item.title,
          url: item.link,
          publishedAt: item.pubDate || null,
          summary: item.description,
        });
      }
    } catch (e) {
      console.error(`RSS error [${source.name}]:`, e.message);
    }
  }
  return articles;
}

const SIGNAL_TERMS = [
  'AI', 'LLM', 'GPT', 'Claude', 'Gemini', 'Cursor', 'Copilot', 'Replit',
  'agent', 'coding', 'reasoning', 'inference', 'training', 'fine-tuning',
  'open source', 'benchmark', 'multimodal', 'voice', 'RAG', 'MCP',
  'OpenAI', 'Anthropic', 'Google', 'Meta', 'Apple',
];

function findSharedTopics(builders) {
  const termByBuilder = {};
  for (const term of SIGNAL_TERMS) {
    const re = new RegExp(`\\b${term}\\b`, 'i');
    const mentionedBy = builders
      .filter(b => b.tweets.some(t => re.test(t.text)))
      .map(b => b.handle);
    if (mentionedBy.length >= 2) {
      termByBuilder[term] = mentionedBy;
    }
  }
  return termByBuilder;
}

function buildDailyFeed(upstream, rssArticles) {
  const feedX = upstream['feed-x.json'];
  const feedPodcasts = upstream['feed-podcasts.json'];
  const builders = feedX?.x || [];
  const podcasts = feedPodcasts?.podcasts || [];
  const cnArticles = rssArticles.filter(a => a.lang === 'zh');
  const enBlogs = rssArticles.filter(a => a.lang === 'en');

  const today = new Date().toISOString().slice(0, 10);
  return {
    edition: today,
    generatedAt: new Date().toISOString(),
    brand: 'Star AI 日报',

    builders: builders.map(b => ({
      name: b.name,
      handle: b.handle,
      bio: b.bio,
      tweets: b.tweets.map(t => {
        const score = (t.likes || 0) + (t.retweets || 0) * 3;
        return {
          text: t.text,
          url: t.url,
          createdAt: t.createdAt,
          likes: t.likes,
          retweets: t.retweets,
          _metrics: { engagementScore: score, isHighEngagement: score > 500 },
        };
      }),
    })),

    cnMedia: cnArticles.map(a => ({
      source: a.source,
      title: a.title,
      url: a.url,
      publishedAt: a.publishedAt,
      summary: a.summary,
    })),

    officialBlogs: enBlogs.map(a => ({
      source: a.source,
      title: a.title,
      url: a.url,
      publishedAt: a.publishedAt,
      summary: a.summary,
    })),

    podcasts: podcasts.map(p => ({
      name: p.name,
      title: p.title,
      url: p.url,
      publishedAt: p.publishedAt,
      transcript: p.transcript || '',
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
      podcasts: podcasts.length,
    },
  };
}

// --- Random delay: 0~50 minutes within the hour ---

function randomDelay() {
  return Math.floor(Math.random() * 50 * 60 * 1000);
}

// --- Archive ---

function buildArchiveFeed(dailyFeed) {
  return {
    ...dailyFeed,
    podcasts: dailyFeed.podcasts.map(p => ({
      name: p.name, title: p.title, url: p.url, publishedAt: p.publishedAt,
    })),
  };
}

// --- Entry ---

async function run(env) {
  const [upstream, rssArticles] = await Promise.all([
    fetchUpstreamFeeds(),
    fetchRssArticles(),
  ]);

  const dailyFeed = buildDailyFeed(upstream, rssArticles);
  const content = JSON.stringify(dailyFeed, null, 2);
  const ok = await pushToGitee(env.GITEE_TOKEN, 'feed-daily.json', content);

  const archivePath = `archive/feed-${dailyFeed.edition}.json`;
  const archiveContent = JSON.stringify(buildArchiveFeed(dailyFeed), null, 2);
  const archiveOk = await pushToGitee(env.GITEE_TOKEN, archivePath, archiveContent);

  const msg = `${dailyFeed.stats.builders} builders, ${dailyFeed.stats.cnArticles} cn, ${dailyFeed.stats.officialBlogs} blogs, ${dailyFeed.stats.podcasts} pods → daily:${ok ? 'OK' : 'FAIL'} archive:${archiveOk ? 'OK' : 'FAIL'}`;
  console.log(msg);
  return { ok, archiveOk, stats: dailyFeed.stats, message: msg };
}

export default {
  async scheduled(event, env, ctx) {
    const delay = randomDelay();
    console.log(`waiting ${Math.round(delay / 60000)}min before sync...`);
    await scheduler.wait(delay);
    await run(env);
  },

  async fetch(request, env) {
    const result = await run(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
