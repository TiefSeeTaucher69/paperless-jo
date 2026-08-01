#!/usr/bin/env node
/**
 * Exportiert die Namenslisten aus Paperless-ngx nach data/eval/entities.json.
 *
 * Schreibt bewusst nach data/ (gitignored): die Namen koennen personenbezogene
 * Daten enthalten (Anschriften, Klarnamen) und duerfen nicht ins Repository.
 *
 * Aufruf:  node scripts/export-entity-fixture.js
 */
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');

require('dotenv').config({ path: path.join(process.cwd(), 'data', '.env') });

const OUT_DIR = path.join(process.cwd(), 'data', 'eval');
const OUT_FILE = path.join(OUT_DIR, 'entities.json');
const RESOURCES = ['tags', 'document_types', 'correspondents'];

async function fetchAll(client, resource) {
  const items = [];
  let url = `/api/${resource}/?page_size=100`;

  while (url) {
    const res = await client.get(url);
    items.push(...res.data.results.map(x => ({ id: x.id, name: x.name })));
    url = res.data.next
      ? res.data.next.replace(/^https?:\/\/[^/]+/, '')
      : null;
  }

  return items;
}

async function main() {
  const apiUrl = process.env.PAPERLESS_API_URL;
  const apiToken = process.env.PAPERLESS_API_TOKEN;

  if (!apiUrl || !apiToken) {
    console.error('[ERROR] PAPERLESS_API_URL oder PAPERLESS_API_TOKEN fehlt in data/.env');
    process.exit(1);
  }

  const client = axios.create({
    baseURL: apiUrl.replace(/\/+$/, ''),
    headers: { Authorization: `Token ${apiToken}` },
    timeout: 30000
  });

  const fixture = { exportedAt: new Date().toISOString() };

  for (const resource of RESOURCES) {
    fixture[resource] = await fetchAll(client, resource);
    console.log(`[DEBUG] ${resource.padEnd(15)} ${fixture[resource].length} Eintraege`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(fixture, null, 2), 'utf8');

  console.log(`\nGeschrieben nach data/eval/entities.json`);
  console.log('Diese Datei liegt unter data/ und wird von .gitignore erfasst.');
}

main().catch(err => {
  console.error('[ERROR]', err.response?.status ? `HTTP ${err.response.status}` : err.message);
  process.exit(1);
});
