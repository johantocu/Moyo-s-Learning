// Classifies each sentence of a newly created story into one of the user's
// 10 "tonalidades de persuasión" using Gemini's free tier, so the reader can
// see which tone a line calls for while practicing. Non-critical: callers
// should treat any failure here as "no tags", not as a reason to fail story
// creation.

// Kept in sync by hand with tones.js (this file runs in a separate
// serverless runtime with no shared import).
const TONE_DESCRIPTIONS = {
  certainty: 'tono confiado y sin titubeos, afirma sin dudar ni suavizar la afirmación.',
  sincerity: 'tono genuino y cálido, sin presión de venta, genera confianza real.',
  reasonable: 'tono calmado, justo y lógico; honesto sobre límites sin sonar defensivo.',
  urgency: 'transmite que algo es limitado o de tiempo acotado, sin sonar agresivo.',
  money_aside: 'resta peso al tema del precio, lo trata como un detalle secundario.',
  question: 'convierte una afirmación en pregunta para involucrar más a la otra persona.',
  i_care: 'interés genuino por la situación de la otra persona, no solo cerrar el trato.',
  implied: 'da por sentado que algo es lógico y natural, como si fuera evidente.',
  curiosity: 'curiosidad auténtica por la respuesta, no solo llenar un formulario.',
  mystery: 'insinúa que hay más información valiosa sin revelarla toda, genera intriga.',
};
const VALID_CODES = new Set(Object.keys(TONE_DESCRIPTIONS));

const MODEL = 'gemini-2.0-flash';

function buildPrompt(sentences) {
  const catalog = Object.entries(TONE_DESCRIPTIONS)
    .map(([code, desc]) => `- ${code}: ${desc}`)
    .join('\n');
  const numbered = sentences.map((s, i) => `${i}. "${s}"`).join('\n');
  return `Eres un clasificador de tono de persuasión para guiones de llamadas de venta.

Tonalidades posibles (código: descripción):
${catalog}

Para cada una de las siguientes frases en inglés (numeradas desde 0), elige SIEMPRE el código de la tonalidad que más se acerque — incluso si la frase es logística o neutra, elige la que mejor calce o la más cercana; no hay opción de "ninguna".

Responde SOLO un array JSON de strings, del mismo largo y en el mismo orden que las frases — sin texto adicional. Ejemplo: ["certainty", "reasonable", "urgency"]

Frases:
${numbered}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY no está configurada en este proyecto.' });
    return;
  }

  const sentences = req.body && req.body.sentences;
  if (!Array.isArray(sentences) || !sentences.length) {
    res.status(400).json({ error: 'invalid sentences' });
    return;
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(sentences) }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned no text');

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== sentences.length) {
      throw new Error('Gemini returned a mismatched array');
    }

    // Every sentence must end up tagged — fall back to a safe, always-
    // applicable default rather than leaving gaps if the model ever
    // returns something outside the known codes.
    const tones = parsed.map((code) => (VALID_CODES.has(code) ? code : 'reasonable'));
    res.status(200).json({ tones });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
