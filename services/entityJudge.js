const axios = require('axios');
const config = require('../config/config');

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['same', 'different', 'unsure'] },
    reason: { type: 'string' }
  },
  required: ['verdict', 'reason']
};

class EntityJudge {
  constructor() {
    this.client = axios.create({ timeout: 15000 });
  }

  async judge(entityType, nameA, nameB) {
    const system = 'Du beurteilst, ob zwei Namen desselben Entity-Typs dieselbe reale Sache '
      + 'bezeichnen (z.B. Synonym, Abkuerzung, Schreibvariante) oder tatsaechlich verschieden '
      + 'sind. Du kennst nur die beiden Namen, kein Dokument. Antworte ausschliesslich ueber '
      + 'das vorgegebene JSON-Schema.';

    const prompt = `Typ: ${entityType}\nName A: ${nameA}\nName B: ${nameB}\n\n`
      + 'Bezeichnen A und B dieselbe Sache? "same", "different" oder "unsure", falls unklar.';

    const response = await this.client.post(`${config.ollama.apiUrl}/api/generate`, {
      model: config.ollama.model,
      prompt,
      system,
      stream: false,
      format: JUDGE_SCHEMA,
      options: {
        temperature: 0, // bewusst fest, unabhaengig von config.ollama.temperature
        num_ctx: 1024,
        num_predict: 200
      }
    });

    const raw = response.data.response;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    return { verdict: parsed.verdict, reason: parsed.reason };
  }
}

module.exports = new EntityJudge();
