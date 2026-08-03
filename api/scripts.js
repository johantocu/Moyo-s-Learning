// Stores the user-created "historias" (custom scripts) in Vercel KV so every
// device that opens the app sees the same list. Talks to the KV REST API
// directly (no @vercel/kv dependency / build step needed) — env vars are
// injected automatically once a KV store is connected from the Vercel
// dashboard's Storage tab.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'moyos-learning:custom-scripts:v1';

async function kvGet() {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(KEY)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) throw new Error(`KV get failed: ${r.status}`);
  const { result } = await r.json();
  return result ? JSON.parse(result) : [];
}

async function kvSet(scripts) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: JSON.stringify(scripts),
  });
  if (!r.ok) throw new Error(`KV set failed: ${r.status}`);
}

module.exports = async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV no está conectado a este proyecto todavía (Storage → Create Database en el dashboard de Vercel).' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const scripts = await kvGet();
      res.status(200).json(scripts);
      return;
    }

    if (req.method === 'POST') {
      const script = req.body;
      if (!script || !script.id) { res.status(400).json({ error: 'invalid script' }); return; }
      const scripts = await kvGet();
      const idx = scripts.findIndex(s => s.id === script.id);
      if (idx >= 0) scripts[idx] = script; else scripts.push(script);
      await kvSet(scripts);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) { res.status(400).json({ error: 'missing id' }); return; }
      const scripts = await kvGet();
      await kvSet(scripts.filter(s => s.id !== id));
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
