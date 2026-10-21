#!/usr/bin/env node
/** Pre-deploy sanity checks for `npm run cf:deploy`. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const wrangler = readFileSync(resolve(ROOT, 'wrangler.jsonc'), 'utf8');
const dbId = /"database_id"\s*:\s*"([^"]*)"/.exec(wrangler)?.[1] ?? '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dbId) || /^[0-]+$/.test(dbId)) {
  problems.push(`wrangler.jsonc: database_id "${dbId}" is not your D1 database id — find it with: npx wrangler d1 list`);
}
if (wrangler.includes('z.example.com')) problems.push('wrangler.jsonc: replace z.example.com with your domain (routes, RP_ID, ORIGINS)');

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('✓ wrangler.jsonc looks ready');
