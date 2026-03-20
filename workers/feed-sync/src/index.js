const UPSTREAM = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main';
const OWNER = 'Stargod-0812';
const REPO = 'star-ai-daily';

const RSS_SOURCES = [
  { name: '36氪', url: 'https://36kr.com/feed', lang: 'zh', needsFilter: true },
  { name: '少数派', url: 'https://sspai.com/feed', lang: 'zh', needsFilter: true },
  { name: 'OpenAI', url: 'https://openai.com/blog/rss.xml', lang: 'en', needsFilter: false },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', lang: 'en', needsFilter: false },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', lang: 'en', needsFilter: false },
];

const AI_KEYWORDS = /AI|人工智能|大模型|LLM|Agent|智能体|GPT|Claude|Gemini|OpenAI|Anthropic|深度学习|神经网络|AIGC|Copilot|Sora|diffusion|transformer|token|RAG|向量|embedding|微调|fine.?tun|Cursor|Replit|机器人|自动驾驶|芯片|GPU|算力|训练|推理|生成式/i;

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
    const plainDesc = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
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

// --- GitHub API ---

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function pushFile(token, filename, content) {
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filename}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'feed-sync',
  };

  const existing = await fetch(apiUrl, { headers });
  const body = {
    message: `chore: sync feed ${new Date().toISOString().slice(0, 16)} [skip ci]`,
    content: toBase64(content),
  };
  if (existing.ok) {
    const data = await existing.json();
    body.sha = data.sha;
  }

  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

// --- Main logic ---

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
      tweets: b.tweets.map(t => ({
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
        likes: t.likes,
        retweets: t.retweets,
      })),
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

    stats: {
      builders: builders.length,
      tweets: builders.reduce((sum, b) => sum + b.tweets.length, 0),
      cnArticles: cnArticles.length,
      officialBlogs: enBlogs.length,
      podcasts: podcasts.length,
    },
  };
}

export default {
  async scheduled(event, env, ctx) {
    const [upstream, rssArticles] = await Promise.all([
      fetchUpstreamFeeds(),
      fetchRssArticles(),
    ]);

    const dailyFeed = buildDailyFeed(upstream, rssArticles);
    const content = JSON.stringify(dailyFeed, null, 2);
    const ok = await pushFile(env.GITHUB_TOKEN, 'feed-daily.json', content);

    console.log(`daily feed: ${dailyFeed.stats.builders} builders, ${dailyFeed.stats.cnArticles} cn, ${dailyFeed.stats.officialBlogs} blogs, ${dailyFeed.stats.podcasts} podcasts → push ${ok ? 'OK' : 'FAIL'}`);
  },
};
