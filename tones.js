// The 10 "tonalidades de persuasión" the user practices with — each
// sentence in a script can be tagged with one of these codes so the
// player can show a small colored badge while reading it out loud.
// Kept in sync by hand with the copy of this list inside api/tone-tag.js
// (that one lives in a separate serverless runtime with no shared import).
// Colors chosen from color psychology — the emotion each one evokes, not
// just "looks distinct": blue=trust/confidence, green=honesty/authenticity,
// gray=neutral/logical, red=urgency, brown=grounded/unflashy,
// purple=creative/inviting, pink=compassion, teal=clarity, gold=curiosity,
// deep indigo=mystery.
const TONES = {
  certainty: { es: 'Certeza', tip: 'Sin dudar, afirma con confianza.', color: '#1D5DA6', emoji: '💪' },
  sincerity: { es: 'Sinceridad', tip: 'Cálido y genuino, sin presión de venta.', color: '#1E8A5E', emoji: '🤝' },
  reasonable: { es: 'El hombre razonable', tip: 'Calmado, justo, sin sonar defensivo.', color: '#6B6F76', emoji: '⚖️' },
  urgency: { es: 'Escasez / Urgencia', tip: 'Un dato objetivo, no agresivo.', color: '#C62828', emoji: '⏳' },
  money_aside: { es: 'Dejar el dinero de lado', tip: 'Trátalo como un detalle secundario.', color: '#8A6A3D', emoji: '🙈' },
  question: { es: 'Pregunta vs afirmación', tip: 'Suaviza convirtiéndolo en pregunta.', color: '#7A4FA0', emoji: '❓' },
  i_care: { es: 'Me importa', tip: 'Interés genuino por la otra persona.', color: '#C13A6B', emoji: '💛' },
  implied: { es: 'Obviedad implícita', tip: 'Dalo por sentado, como algo evidente.', color: '#0E7E8C', emoji: '👍' },
  curiosity: { es: 'Realmente quiero saber', tip: 'Curiosidad auténtica, no de formulario.', color: '#C79A1E', emoji: '🧐' },
  mystery: { es: 'Misterio / Intriga', tip: 'Insinúa que hay más sin revelarlo todo.', color: '#3B2A5C', emoji: '🕵️' },
};

const TONE_ORDER = ['certainty', 'sincerity', 'reasonable', 'urgency', 'money_aside', 'question', 'i_care', 'implied', 'curiosity', 'mystery'];
