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

// Grosszuegig genug fuer jeden real vorkommenden Entitaetsnamen (Paperless-Korrespondenten/
// Tags/Dokumentarten liegen in der Praxis weit darunter), aber klein genug, dass System- +
// User-Prompt sicher innerhalb von num_ctx=1024 bleiben (AUDIT-028).
const MAX_NAME_LENGTH = 300;

// Ein einzelner Retry faengt genau den Fall ab, der ohne ihn eine Welle von Queue-Eintraegen
// erzeugt: eine kurzzeitig ueberlastete Ollama-Instanz (Timeout/5xx), nicht ein dauerhaft nicht
// erreichbarer Host - dafuer bleibt der zweite Fehlschlag ein normaler Wurf, den der Aufrufer
// (entityResolver._askJudge) unveraendert als 'unsure' behandelt (AUDIT-028).
const RETRY_DELAY_MS = 300;

function truncateName(name) {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// AUDIT-028 Review-Fix: nur transiente Fehler rechtfertigen einen Retry. Ein axios-Fehler ohne
// .response ist ein Netzwerk-/Timeout-Fehler (kann beim zweiten Versuch verschwinden); ein 5xx
// ist ein serverseitiger Fehler, moeglicherweise voruebergehend. 429 (Rate Limit) und 408
// (Request Timeout) sind ebenfalls transient, auch wenn sie technisch 4xx sind - ein
// vorgelagerter Reverse-Proxy vor Ollama kann beides senden. Andere 4xx bedeuten dagegen, dass
// die Anfrage selbst abgelehnt wurde - das aendert sich beim identischen zweiten Versuch nicht,
// ein Retry wuerde nur unnoetig 300ms plus einen zweiten Timeout kosten.
function isTransientError(error) {
  if (!error.response) return true;
  const status = error.response.status;
  return status >= 500 || status === 429 || status === 408;
}

class EntityJudge {
  constructor() {
    this.client = axios.create({ timeout: config.entityJudge.timeoutMs });
  }

  async judge(entityType, nameA, nameB) {
    const truncatedA = truncateName(nameA);
    const truncatedB = truncateName(nameB);
    if (truncatedA !== nameA || truncatedB !== nameB) {
      console.warn(`[WARNING] entityJudge: Name(n) fuer ${entityType} ueberschreiten ${MAX_NAME_LENGTH} Zeichen und wurden vor dem Judge-Call gekuerzt`);
    }

    const system = 'Du beurteilst, ob zwei Namen desselben Entity-Typs dieselbe reale Sache '
      + 'bezeichnen (z.B. Synonym, Abkuerzung, Schreibvariante) oder tatsaechlich verschieden '
      + 'sind. Du kennst nur die beiden Namen, kein Dokument. Antworte ausschliesslich ueber '
      + 'das vorgegebene JSON-Schema.';

    const prompt = `Typ: ${entityType}\nName A: ${truncatedA}\nName B: ${truncatedB}\n\n`
      + 'Bezeichnen A und B dieselbe Sache? "same", "different" oder "unsure", falls unklar.'
      + '\nBegruendung: hoechstens 8 Woerter.';

    const requestBody = {
      model: config.ollama.model,
      prompt,
      system,
      stream: false,
      format: JUDGE_SCHEMA,
      options: {
        temperature: 0, // bewusst fest, unabhaengig von config.ollama.temperature
        seed: config.ollama.seed, // AUDIT-028: Determinismus wie bei den anderen Ollama-Aufrufen (AUDIT-008)
        num_ctx: 1024,
        num_predict: 60
      }
    };

    let response;
    try {
      response = await this.client.post(`${config.ollama.apiUrl}/api/generate`, requestBody);
    } catch (firstError) {
      if (!isTransientError(firstError)) {
        throw firstError;
      }
      console.warn(`[WARNING] entityJudge: erster Versuch fehlgeschlagen (${firstError.message}), ein Retry folgt`);
      await delay(RETRY_DELAY_MS);
      response = await this.client.post(`${config.ollama.apiUrl}/api/generate`, requestBody);
    }

    const raw = response.data.response;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    return { verdict: parsed.verdict, reason: parsed.reason };
  }
}

module.exports = new EntityJudge();
