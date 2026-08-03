// The 10 "tonalidades de persuasión" the user practices with — each
// sentence in a script can be tagged with one of these codes so the
// player can show a small colored badge while reading it out loud.
// Kept in sync by hand with the copy of this list inside api/tone-tag.js
// (that one lives in a separate serverless runtime with no shared import).
const TONES = {
  certainty: { es: 'Certeza', tip: 'Sin dudar, afirma con confianza.', color: '#1E7A4C' },
  sincerity: { es: 'Sinceridad', tip: 'Cálido y genuino, sin presión de venta.', color: '#2E6F9E' },
  reasonable: { es: 'El hombre razonable', tip: 'Calmado, justo, sin sonar defensivo.', color: '#6B6F76' },
  urgency: { es: 'Escasez / Urgencia', tip: 'Un dato objetivo, no agresivo.', color: '#C4571F' },
  money_aside: { es: 'Dejar el dinero de lado', tip: 'Trátalo como un detalle secundario.', color: '#8A8763' },
  question: { es: 'Pregunta vs afirmación', tip: 'Suaviza convirtiéndolo en pregunta.', color: '#7A4FA0' },
  i_care: { es: 'Me importa', tip: 'Interés genuino por la otra persona.', color: '#C13A6B' },
  implied: { es: 'Obviedad implícita', tip: 'Dalo por sentado, como algo evidente.', color: '#0E7E8C' },
  curiosity: { es: 'Realmente quiero saber', tip: 'Curiosidad auténtica, no de formulario.', color: '#C79A1E' },
  mystery: { es: 'Misterio / Intriga', tip: 'Insinúa que hay más sin revelarlo todo.', color: '#3B3F4A' },
};

const TONE_ORDER = ['certainty', 'sincerity', 'reasonable', 'urgency', 'money_aside', 'question', 'i_care', 'implied', 'curiosity', 'mystery'];
