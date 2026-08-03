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

// AUDIT-016: diese vier sind auch gebraeuchliche deutsche Woerter/Abkuerzungen
// ("AG" = Amtsgericht, "SE"/"CO"/"SA" als Namens- bzw. Wortbestandteile) - sie werden
// deshalb nur entfernt, wenn sie am Ende des Namens stehen UND danach noch etwas
// Substanzielles (>= 3 Zeichen, selbst kein Rechtsform-Token) uebrig bleibt.
const AMBIGUOUS_SHORT_TOKENS = new Set(['se', 'sa', 'co', 'ag']);

function _stripLegalForm(normalized) {
  const tokens = normalized.split(' ').filter(Boolean);
  let end = tokens.length;

  // AUDIT-016: vorher wurden Rechtsform-Tokens an JEDER Position im Namen entfernt
  // ("AG Nuernberg" -> "nuernberg", "Co-Working Nord" -> "working nord") - das konnte
  // zwei unabhaengige Korrespondenten nach der Normalisierung identisch machen und sie
  // in Stufe 3 der Resolver-Kaskade ohne Judge und ohne Review-Queue automatisch
  // zusammenlegen. Jetzt wird nur noch ein zusammenhaengender Rechtsform-Block am ENDE
  // des Namens entfernt - echte Rechtsformen stehen dort ("Stadtwerke Musterstadt GmbH"),
  // die Kollisionsfaelle aus dem Audit stehen am Anfang oder mittendrin.
  while (end > 0) {
    // "e v" (z.B. aus "e.V.") als Bigramm am Ende
    if (end >= 2 && tokens[end - 2] === 'e' && tokens[end - 1] === 'v') {
      end -= 2;
      continue;
    }

    const last = tokens[end - 1];
    if (!LEGAL_FORM_TOKENS.has(last)) {
      break;
    }

    if (AMBIGUOUS_SHORT_TOKENS.has(last)) {
      const remaining = tokens.slice(0, end - 1);
      const hasSubstantialRemainder = remaining.some(
        t => t.length >= 3 && !LEGAL_FORM_TOKENS.has(t)
      );
      if (!hasSubstantialRemainder) {
        break;
      }
    }

    end -= 1;
  }

  const filtered = tokens.slice(0, end);

  // Ein Korrespondent, der ausschliesslich aus Rechtsform-Tokens besteht,
  // faellt auf die ungestrippte Form zurueck statt auf Leerstring zu kollabieren.
  return filtered.length > 0 ? filtered.join(' ') : normalized;
}

function normalizeForType(value, type) {
  const base = normalize(value);
  return type === 'correspondent' ? _stripLegalForm(base) : base;
}

module.exports = { normalize, normalizeForType, _stripLegalForm };
