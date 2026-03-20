const UPSTREAM = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main';
const OWNER = 'Stargod-0812';
const REPO = 'star-ai-daily';
const UPSTREAM_FILES = ['feed-x.json', 'feed-podcasts.json'];

const CN_RSS_SOURCES = [
  { name: '36氪', url: 'https://36kr.com/feed' },
];

const AI_KEYWORDS = /AI|人工智能|大模型|LLM|Agent|智能体|GPT|Claude|Gemini|机器人|模型|OpenAI|Anthropic|深度学习|神经网络|AIGC|Copilot|Sora|扩散模型|transformer|token|RAG|向量|embedding|微调|fine.?tun|Cursor|Replit/i;

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || '';
    const link = block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1]?.trim() || '';
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';
    const desc = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() || '';
    const plainDesc = desc.replace(/<[^>]+>/g, '').slice(0, 300);
    items.push({ title, link, pubDate, description: plainDesc });
  }
  return items;
}

async function fetchCnArticles() {
  const allArticles = [];
  for (const source of CN_RSS_SOURCES) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRssItems(xml);
      const aiItems = items.filter(item =>
        AI_KEYWORDS.test(item.title) || AI_KEYWORDS.test(item.description)
      );
      for (const item of aiItems.slice(0, 10)) {
        allArticles.push({
          source: 'cn_media',
          name: source.name,
          title: item.title,
          url: item.link,
          publishedAt: item.pubDate,
          description: item.description,
        });
      }
    } catch (e) {
      console.error(`RSS fetch failed: ${source.name}`, e.message);
    }
  }
  return allArticles;
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

export default {
  async scheduled(event, env, ctx) {
    let synced = 0;

    for (const file of UPSTREAM_FILES) {
      const res = await fetch(`${UPSTREAM}/${file}`);
      if (!res.ok) continue;
      const ok = await pushFile(env.GITHUB_TOKEN, file, await res.text());
      if (ok) synced++;
    }

    const cnArticles = await fetchCnArticles();
    if (cnArticles.length > 0) {
      const cnFeed = {
        generatedAt: new Date().toISOString(),
        source: 'cn_media_rss',
        articles: cnArticles,
        stats: { totalArticles: cnArticles.length },
      };
      const ok = await pushFile(env.GITHUB_TOKEN, 'feed-cn.json', JSON.stringify(cnFeed, null, 2));
      if (ok) synced++;
    }

    console.log(`synced ${synced} files, cn articles: ${cnArticles.length}`);
  },
};
