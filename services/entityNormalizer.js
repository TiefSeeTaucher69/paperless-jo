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

module.exports = { normalize };
