const path = require('path');
const currentDir = decodeURIComponent(process.cwd());
const envPath = path.join(currentDir, 'data', '.env');
console.log('Loading .env from:', envPath); // Debug log
require('dotenv').config({ path: envPath });

// Helper function to parse boolean-like env vars
const parseEnvBoolean = (value, defaultValue = 'yes') => {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes' ? 'yes' : 'no';
};

// Helper function to parse numeric env vars with a fallback
const parseEnvNumber = (value, defaultValue) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

// Initialize limit functions with defaults
const limitFunctions = {
  activateTagging: parseEnvBoolean(process.env.ACTIVATE_TAGGING, 'yes'),
  activateCorrespondents: parseEnvBoolean(process.env.ACTIVATE_CORRESPONDENTS, 'yes'),
  activateDocumentType: parseEnvBoolean(process.env.ACTIVATE_DOCUMENT_TYPE, 'yes'),
  activateTitle: parseEnvBoolean(process.env.ACTIVATE_TITLE, 'yes'),
  activateCustomFields: parseEnvBoolean(process.env.ACTIVATE_CUSTOM_FIELDS, 'yes')
};

// Initialize AI restrictions with defaults
const aiRestrictions = {
  restrictToExistingTags: parseEnvBoolean(process.env.RESTRICT_TO_EXISTING_TAGS, 'no'),
  restrictToExistingCorrespondents: parseEnvBoolean(process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS, 'no'),
  restrictToExistingDocumentTypes: parseEnvBoolean(process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES, 'no')
};

console.log('Loaded restriction settings:', {
  RESTRICT_TO_EXISTING_TAGS: aiRestrictions.restrictToExistingTags,
  RESTRICT_TO_EXISTING_CORRESPONDENTS: aiRestrictions.restrictToExistingCorrespondents,
  RESTRICT_TO_EXISTING_DOCUMENT_TYPES: aiRestrictions.restrictToExistingDocumentTypes
});

// Initialize external API configuration
const externalApiConfig = {
  enabled: parseEnvBoolean(process.env.EXTERNAL_API_ENABLED, 'no'),
  url: process.env.EXTERNAL_API_URL || '',
  method: process.env.EXTERNAL_API_METHOD || 'GET',
  headers: process.env.EXTERNAL_API_HEADERS || '{}',
  body: process.env.EXTERNAL_API_BODY || '{}',
  timeout: parseInt(process.env.EXTERNAL_API_TIMEOUT || '5000', 10),
  transformationTemplate: process.env.EXTERNAL_API_TRANSFORM || ''
};

// Never log connection details from data/.env in clear text
const maskUrl = (url) => {
  if (!url) return '(not set)';
  try {
    return `${new URL(url).protocol}//***`;
  } catch {
    return '***';
  }
};

// Initialize entity resolver thresholds with [0,1] range clamping. Values outside
// that range would make the similarity cascade behave nonsensically (e.g. a
// threshold > 1 could never be reached, one < 0 would always be reached), so we
// clamp and warn rather than silently trusting whatever came from the env.
const clampThreshold = (value, label) => {
  if (value < 0 || value > 1) {
    const clamped = Math.min(1, Math.max(0, value));
    console.warn(`[WARNING] ${label}=${value} liegt ausserhalb des gueltigen Bereichs [0,1] und wird auf ${clamped} geklemmt`);
    return clamped;
  }
  return value;
};

// AUDIT-008: Ollama-Aufrufe bekommen ueber config.ollama.temperature/seed eine
// deterministische Sampling-Policy (Default temperature=0, seed=42) - OpenAI, Azure und
// Custom hatten stattdessen hartkodiert temperature=0.3 und gar keinen seed, obwohl die
// OpenAI-Chat-Completions-API seed unterstuetzt. Klassifikation ist eine Etikettieraufgabe,
// keine kreative - dieselbe Policy soll providerneutral gelten. Dieselben
// OLLAMA_TEMPERATURE/OLLAMA_SEED-Variablen werden wiederverwendet statt neuer, redundanter
// Env-Var-Namen fuer denselben Zweck einzufuehren.
const samplingTemperature = parseEnvNumber(process.env.OLLAMA_TEMPERATURE, 0);
const samplingSeed = parseEnvNumber(process.env.OLLAMA_SEED, 42);

const entityResolverAutoThreshold = clampThreshold(
  parseEnvNumber(process.env.ENTITY_RESOLVER_AUTO_THRESHOLD, 0.90),
  'ENTITY_RESOLVER_AUTO_THRESHOLD'
);
const entityResolverJudgeMin = clampThreshold(
  parseEnvNumber(process.env.ENTITY_RESOLVER_JUDGE_MIN, 0.65),
  'ENTITY_RESOLVER_JUDGE_MIN'
);

if (entityResolverJudgeMin > entityResolverAutoThreshold) {
  console.warn(`[WARNING] ENTITY_RESOLVER_JUDGE_MIN (${entityResolverJudgeMin}) > ENTITY_RESOLVER_AUTO_THRESHOLD (${entityResolverAutoThreshold}): Stufe 4c (LLM-Judge) ist damit unerreichbar`);
}

const embeddingAutoThreshold = clampThreshold(
  parseEnvNumber(process.env.EMBED_AUTO_THRESHOLD, 0.90),
  'EMBED_AUTO_THRESHOLD'
);
const embeddingJudgeMin = clampThreshold(
  parseEnvNumber(process.env.EMBED_JUDGE_MIN, 0.65),
  'EMBED_JUDGE_MIN'
);

// Manche Entitaetstypen (z.B. Tags) sind naturgemaess semantisch dichter geclustert als
// andere (Dokumentarten, Korrespondenten) - dieselbe Embedding-Schwelle erzeugt dort
// ueberwiegend thematische statt echte Duplikat-Nachbarschaften. Siehe Messung vom
// 2026-08-02 in der Phase-5-Roadmap.
const embeddingExcludedTypes = (process.env.EMBEDDING_EXCLUDED_TYPES || '')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

if (embeddingJudgeMin > embeddingAutoThreshold) {
  console.warn(`[WARNING] EMBED_JUDGE_MIN (${embeddingJudgeMin}) > EMBED_AUTO_THRESHOLD (${embeddingAutoThreshold}): die Embedding-Judge-Stufe ist damit unerreichbar`);
}

// Unmeasured placeholder (siehe Design-Doc "Offener Folgeschritt") - braucht eine eigene
// Tuning-Messung mit gelabelten Dokumentpaaren, bevor der Kanal produktiv scharf geschaltet wird.
const documentFingerprintSimilarityThreshold = clampThreshold(
  parseEnvNumber(process.env.FINGERPRINT_SIMILARITY_THRESHOLD, 0.90),
  'FINGERPRINT_SIMILARITY_THRESHOLD'
);

// Cross-origin browser access is opt-in. Unset = same-origin only, which is
// correct for the default self-hosted deployment; set a comma-separated list
// to let a specific origin's JavaScript read this API's responses. Note this
// does NOT enable credentialed/cookie-based cross-origin calls -- server.js's
// CORS options hardcode `credentials: false`, so an allow-listed origin still
// cannot send the `jwt` session cookie cross-origin. This is still useful for,
// e.g., a public read-only integration authenticating via the X-API-Key
// header instead, which isn't subject to that restriction.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

console.log('Loaded environment variables:', {
  PAPERLESS_API_URL: maskUrl(process.env.PAPERLESS_API_URL),
  PAPERLESS_API_TOKEN: '******',
  LIMIT_FUNCTIONS: limitFunctions,
  AI_RESTRICTIONS: aiRestrictions,
  EXTERNAL_API: externalApiConfig.enabled === 'yes' ? 'enabled' : 'disabled'
});

module.exports = {
  PAPERLESS_AI_VERSION: '3.0.9',
  // Exported for unit tests
  _parseEnvNumber: parseEnvNumber,
  _maskUrl: maskUrl,
  CONFIGURED: false,
  disableAutomaticProcessing: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
  predefinedMode: process.env.PROCESS_PREDEFINED_DOCUMENTS,
  tokenLimit: process.env.TOKEN_LIMIT || 128000,
  responseTokens: process.env.RESPONSE_TOKENS || 1000,
  addAIProcessedTag: process.env.ADD_AI_PROCESSED_TAG || 'no',
  addAIProcessedTags: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
  // AI restrictions config
  restrictToExistingTags: aiRestrictions.restrictToExistingTags,
  restrictToExistingCorrespondents: aiRestrictions.restrictToExistingCorrespondents,
  restrictToExistingDocumentTypes: aiRestrictions.restrictToExistingDocumentTypes,
  // External API config
  externalApiConfig: externalApiConfig,
  paperless: {
    apiUrl: process.env.PAPERLESS_API_URL,
    apiToken: process.env.PAPERLESS_API_TOKEN
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY
  },
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2',
    // Deterministic defaults: classification is a labelling task, not a
    // creative one. Same document must yield the same answer.
    temperature: samplingTemperature,
    seed: samplingSeed,
    numPredict: parseEnvNumber(process.env.OLLAMA_NUM_PREDICT, 512),
    numCtxMax: parseEnvNumber(process.env.OLLAMA_NUM_CTX_MAX, 8192)
  },
  // AUDIT-008: providerneutraler Spiegel von ollama.temperature/seed - siehe Kommentar oben
  // bei samplingTemperature/samplingSeed. openaiService.js/azureService.js/customService.js
  // lesen diesen Block statt eines hartkodierten temperature-Werts.
  sampling: {
    temperature: samplingTemperature,
    seed: samplingSeed
  },
  entityResolver: {
    enabled: parseEnvBoolean(process.env.ENTITY_RESOLVER_ENABLED, 'no') === 'yes',
    autoThreshold: entityResolverAutoThreshold,
    judgeMin: entityResolverJudgeMin,
    dbPath: process.env.ENTITY_RESOLVER_DB_PATH || path.join(process.cwd(), 'data', 'entities.db')
  },
  embedding: {
    enabled: parseEnvBoolean(process.env.EMBEDDING_SIMILARITY_ENABLED, 'no') === 'yes',
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.EMBEDDING_MODEL || 'bge-m3',
    autoThreshold: embeddingAutoThreshold,
    judgeMin: embeddingJudgeMin,
    excludedTypes: embeddingExcludedTypes
  },
  documentFingerprint: {
    enabled: parseEnvBoolean(process.env.DOCUMENT_FINGERPRINT_ENABLED, 'no') === 'yes',
    // NACHAUDIT-11 (Audit Abschnitt 18.6, Bedingung 5): 'observe' ist bewusst der Default, nicht
    // 'apply' - ein DOCUMENT_FINGERPRINT_ENABLED=yes ohne weitere Konfiguration protokolliert
    // Treffer nur, statt sie live auf Tags/Dokumentart anzuwenden. Ein unbekannter Wert (Tippfehler)
    // faellt auf den sicheren Default zurueck statt den Rest der Konfiguration zu verwerfen.
    mode: ['observe', 'apply'].includes(process.env.DOCUMENT_FINGERPRINT_MODE) ? process.env.DOCUMENT_FINGERPRINT_MODE : 'observe',
    similarityThreshold: documentFingerprintSimilarityThreshold
  },
  // AUDIT-018: full document text, correspondent names, and the LLM response
  // were unconditionally appended to logs/prompt.txt on every analysis.
  // Off by default -- an operator opts in only when they need to debug
  // prompt behaviour, not by default in normal operation.
  promptLogging: {
    enabled: parseEnvBoolean(process.env.PROMPT_LOGGING_ENABLED, 'no') === 'yes',
    // Ueberschreibbar in Tests (siehe test/promptLoggingResponseFile.test.js),
    // damit kein Testlauf die echte logs/-Datei anfasst. Im Betrieb immer './logs'.
    logDir: './logs'
  },
  security: {
    allowedOrigins
  },
  custom: {
    apiUrl: process.env.CUSTOM_BASE_URL || '',
    apiKey: process.env.CUSTOM_API_KEY || '',
    model: process.env.CUSTOM_MODEL || ''
  },
  azure: {
    apiKey: process.env.AZURE_API_KEY || '',
    endpoint: process.env.AZURE_ENDPOINT || '',
    deploymentName: process.env.AZURE_DEPLOYMENT_NAME || '',
    // AUDIT-008: seed (siehe config.sampling) wird erst ab 2023-12-01-preview unterstuetzt;
    // vorher lehnt Azure den Request mit HTTP 400 ab statt den Parameter zu ignorieren.
    apiVersion: process.env.AZURE_API_VERSION || '2024-02-01'
  },
  customFields: process.env.CUSTOM_FIELDS || '',
  aiProvider: process.env.AI_PROVIDER || 'openai',
  scanInterval: process.env.SCAN_INTERVAL || '*/30 * * * *',
  useExistingData: process.env.USE_EXISTING_DATA || 'no',
  // AUDIT-018: thumbnails used to be cached under public/images/, a directory
  // express.static serves to anyone without authentication. data/ is not
  // statically served, so the only way to fetch a thumbnail is the
  // authenticated GET /thumb/:documentId route (routes/setup.js).
  thumbnailCacheDir: path.join(process.cwd(), 'data', 'cache', 'thumbnails'),
  // Add limit functions to config
  limitFunctions: {
    activateTagging: limitFunctions.activateTagging,
    activateCorrespondents: limitFunctions.activateCorrespondents,
    activateDocumentType: limitFunctions.activateDocumentType,
    activateTitle: limitFunctions.activateTitle,
    activateCustomFields: limitFunctions.activateCustomFields
  },
  specialPromptPreDefinedTags: `You are a document analysis AI. You will analyze the document. 
  You take the main information to associate tags with the document. 
  You will also find the correspondent of the document (Sender not receiver). Also you find a meaningful and short title for the document.
  You are given a list of tags: ${process.env.PROMPT_TAGS}
  Only use the tags from the list and try to find the best fitting tags.
  You do not ask for additional information, you only use the information given in the document.
  
  Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:
  {
    "title": "xxxxx",
    "correspondent": "xxxxxxxx",
    "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
    "document_date": "YYYY-MM-DD",
    "language": "en/de/es/..."
  }`,
  mustHavePrompt: `  Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
  IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
  Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.
  {
    "title": "xxxxx",
    "correspondent": "xxxxxxxx",
    "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
    "document_type": "Invoice/Contract/...",
    "document_date": "YYYY-MM-DD",
    "language": "en/de/es/...",
    %CUSTOMFIELDS%
  }`,
};
