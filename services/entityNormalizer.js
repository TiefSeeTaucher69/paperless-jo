function normalize(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let s = value.toLowerCase();

  // Deutsche Faltung MUSS vor NFKD passieren, sonst zerlegt NFKD "ä" in
  // "a" + Kombinationszeichen und die explizite ae/oe/ue/ss-Regel greift nie.
  s = s
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');

  // Restliche Diakritika (z.B. franzoesische Korrespondentennamen) neutral entfernen
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  // Interpunktion zu Leerzeichen, dann kollabieren
  s = s.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

  return s;
}

const LEGAL_FORM_TOKENS = new Set([
  'gmbh', 'ag', 'kg', 'ohg', 'gbr', 'mbh', 'ug', 'se', 'co', 'kgaa',
  'ltd', 'inc', 'bv', 'sa'
]);

function _stripLegalForm(normalized) {
  const tokens = normalized.split(' ').filter(Boolean);
  const withoutBigram = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'e' && tokens[i + 1] === 'v') {
      i++; // "e v" als Rechtsform-Bigramm ueberspringen
      continue;
    }
    withoutBigram.push(tokens[i]);
  }

  const filtered = withoutBigram.filter(t => !LEGAL_FORM_TOKENS.has(t));

  // Ein Korrespondent, der ausschliesslich aus Rechtsform-Tokens besteht,
  // faellt auf die ungestrippte Form zurueck statt auf Leerstring zu kollabieren.
  return filtered.length > 0 ? filtered.join(' ') : normalized;
}

function normalizeForType(value, type) {
  const base = normalize(value);
  return type === 'correspondent' ? _stripLegalForm(base) : base;
}

module.exports = { normalize, normalizeForType, _stripLegalForm };
