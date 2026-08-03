// Stores the user-created "historias" (custom scripts) in the Redis database
// connected to this project (Storage tab in the Vercel dashboard), so every
// device that opens the app sees the same list. Connects with a plain Redis
// client over the REDIS_URL env var that the integration provides.
const { createClient } = require('redis');

const KEY = 'moyos-learning:custom-scripts:v1';

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('Redis client error', err));
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

module.exports = async function handler(req, res) {
  if (!process.env.REDIS_URL) {
    res.status(500).json({ error: 'REDIS_URL no está configurado en este proyecto (Storage → conecta una base de datos Redis en el dashboard de Vercel).' });
    return;
  }

  try {
    const client = await getClient();

    if (req.method === 'GET') {
      const raw = await client.get(KEY);
      res.status(200).json(raw ? JSON.parse(raw) : []);
      return;
    }

    if (req.method === 'POST') {
      const script = req.body;
      if (!script || !script.id) { res.status(400).json({ error: 'invalid script' }); return; }
      const raw = await client.get(KEY);
      const scripts = raw ? JSON.parse(raw) : [];
      const idx = scripts.findIndex(s => s.id === script.id);
      if (idx >= 0) scripts[idx] = script; else scripts.push(script);
      await client.set(KEY, JSON.stringify(scripts));
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) { res.status(400).json({ error: 'missing id' }); return; }
      const raw = await client.get(KEY);
      const scripts = raw ? JSON.parse(raw) : [];
      await client.set(KEY, JSON.stringify(scripts.filter(s => s.id !== id)));
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
