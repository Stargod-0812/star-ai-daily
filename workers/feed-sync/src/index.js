const UPSTREAM = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main';
const OWNER = 'Stargod-0812';
const REPO = 'star-ai-daily';
const FILES = ['feed-x.json', 'feed-podcasts.json'];

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function syncFile(token, filename, content) {
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
    for (const file of FILES) {
      const res = await fetch(`${UPSTREAM}/${file}`);
      if (!res.ok) continue;
      const ok = await syncFile(env.GITHUB_TOKEN, file, await res.text());
      if (ok) synced++;
    }
    console.log(`synced ${synced}/${FILES.length} files`);
  },
};
