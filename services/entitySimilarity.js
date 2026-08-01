function _trigrams(value) {
  const s = ` ${value} `;
  const grams = new Set();
  for (let i = 0; i < s.length - 2; i++) {
    grams.add(s.slice(i, i + 3));
  }
  return grams;
}

function diceCoefficient(a, b) {
  if (a === b) {
    return a.length > 0 ? 1 : 0;
  }
  if (!a || !b) {
    return 0;
  }

  const gramsA = _trigrams(a);
  const gramsB = _trigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection++;
  }

  return (2 * intersection) / (gramsA.size + gramsB.size);
}

module.exports = { diceCoefficient, _trigrams };
