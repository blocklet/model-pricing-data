#!/usr/bin/env npx tsx
/**
 * Scrape Google (Gemini) official pricing from ai.google.dev
 *
 * Usage:
 *   npx tsx scripts/scrape-google.ts --json
 *
 * Returns ModelPricing[] via stdout (JSON).
 *
 * Migrated from the scrapeGoogle() function in aigne-hub official-pricing-catalog.mjs
 */

import type { ModelPricing, CachingKey, ContextTier } from './lib/schema.js';
import { httpFetch } from './lib/http.js';
import { toPerToken } from './lib/pricing-core.js';

const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing.md.txt';
const SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

interface TableRow {
  label: string;
  paid: string;
}

function parseTableRows(text: string): TableRow[] {
  const rows: TableRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length >= 4 && cols[1]) {
      rows.push({ label: cols[1], paid: cols[3] || '' });
    }
  }
  return rows;
}

function firstPrice(text: string): number | null {
  if (!text || text === 'Not available') return null;
  const m = text.match(/\$([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function allPrices(text: string): number[] {
  if (!text || text === 'Not available') return [];
  const prices: number[] = [];
  const re = /\$([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) prices.push(parseFloat(m[1]));
  return prices;
}

function findRow(rows: TableRow[], pattern: RegExp): TableRow | undefined {
  return rows.find((r) => pattern.test(r.label));
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal raw model type (intermediate)
// ──────────────────────────────────────────────────────────────────────────────

interface RawGoogleModel {
  name: string;
  id: string;
  type?: string;
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheRead?: number;
  costPerImage?: number;
  costPerSecond?: number;
  note?: string;
  deprecated?: boolean;
  longContextInput?: number;
  longContextOutput?: number;
  batchInput?: number;
  batchOutput?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main scraping
// ──────────────────────────────────────────────────────────────────────────────

async function parseGooglePricing(): Promise<RawGoogleModel[]> {
  console.error('Fetching Google pricing (Markdown)...');
  let md = await httpFetch(PRICING_URL);

  // Strip markdown links: [text](url) -> text
  md = md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  const models: RawGoogleModel[] = [];

  // Split into sections by ## headers
  const sections = md.split(/^## /m).slice(1);

  for (const rawSection of sections) {
    const lines = rawSection.split('\n');
    const title = lines[0].trim().replace(/\s*🍌\s*$/, '');

    // Extract model IDs from *`model-id`* pattern
    const headerArea = lines.slice(0, 5).join('\n');
    const idLineMatch = headerArea.match(/\*`[^*]+`\*/);
    if (!idLineMatch) continue;
    const allIds: string[] = [];
    const idRegex = /`([^`]+)`/g;
    let idM: RegExpExecArray | null;
    while ((idM = idRegex.exec(idLineMatch[0])) !== null) allIds.push(idM[1]);
    if (allIds.length === 0) continue;

    const primaryId = allIds[0];
    const deprecated = /deprecated/i.test(rawSection.substring(0, 500));
    const hasTable = /\|\s*(Input|Output|image|[Vv]ideo)\s*price/i.test(rawSection);
    if (deprecated && !hasTable) continue;

    // Imagen (per-image, multiple variants)
    if (primaryId.startsWith('imagen-')) {
      const rows = parseTableRows(rawSection);
      for (const row of rows) {
        if (!row.label.toLowerCase().includes('image price')) continue;
        const price = firstPrice(row.paid);
        if (!price) continue;
        const label = row.label.toLowerCase();
        let modelId: string | undefined;
        let modelName: string;
        if (label.includes('fast')) {
          modelId = allIds.find((id) => id.includes('fast'));
          modelName = 'Imagen 4 Fast';
        } else if (label.includes('ultra')) {
          modelId = allIds.find((id) => id.includes('ultra'));
          modelName = 'Imagen 4 Ultra';
        } else {
          modelId = allIds.find((id) => !id.includes('fast') && !id.includes('ultra'));
          modelName = 'Imagen 4';
        }
        if (modelId) {
          models.push({ name: modelName, id: modelId, type: 'image', costPerImage: price, note: `$${price}/image` });
        }
      }
      continue;
    }

    // Veo (per-second, Standard/Fast variants)
    if (primaryId.startsWith('veo-')) {
      const rows = parseTableRows(rawSection);
      if (allIds.length === 1) {
        const row = rows.find((r) => /video|price/i.test(r.label) && !r.label.includes('Used'));
        if (row) {
          const price = firstPrice(row.paid);
          if (price)
            models.push({
              name: title,
              id: allIds[0],
              type: 'video',
              costPerSecond: price,
              note: `$${price}/s`,
            });
        }
      } else {
        const stdId = allIds.find((id) => !id.includes('fast'));
        const fastId = allIds.find((id) => id.includes('fast'));
        const stdRow = rows.find((r) => r.label.includes('Standard'));
        const fastRow = rows.find((r) => r.label.includes('Fast'));
        if (stdRow && stdId) {
          const p = firstPrice(stdRow.paid);
          if (p) models.push({ name: title, id: stdId, type: 'video', costPerSecond: p, note: `$${p}/s` });
        }
        if (fastRow && fastId) {
          const p = firstPrice(fastRow.paid);
          if (p)
            models.push({ name: `${title} Fast`, id: fastId, type: 'video', costPerSecond: p, note: `$${p}/s` });
        }
      }
      continue;
    }

    // Gemma (free only) — skip
    if (title.startsWith('Gemma')) continue;
    // Pricing sections (tools/agents) — skip
    if (title.startsWith('Pricing')) continue;

    // Parse Standard / Batch tables
    const standardIdx = rawSection.indexOf('### Standard');
    const batchIdx = rawSection.indexOf('### Batch');
    let standardText: string;
    let batchText: string;
    if (standardIdx >= 0 && batchIdx >= 0) {
      standardText = rawSection.substring(standardIdx, batchIdx);
      batchText = rawSection.substring(batchIdx);
    } else if (standardIdx >= 0) {
      standardText = rawSection.substring(standardIdx);
      batchText = '';
    } else {
      standardText = rawSection;
      batchText = '';
    }

    const stdRows = parseTableRows(standardText);
    const batchRows = parseTableRows(batchText);
    const inputRow = findRow(stdRows, /^Input price/i) || findRow(stdRows, /^Text input price/i);
    const outputRow = findRow(stdRows, /^Output price/i);
    const cacheRow = findRow(stdRows, /[Cc]aching price/i);
    const batchInputRow = findRow(batchRows, /^Input price/i) || findRow(batchRows, /^Text input price/i);
    const batchOutputRow = findRow(batchRows, /^Output price/i);

    // Embedding models
    if (primaryId.includes('embedding')) {
      const price = inputRow ? firstPrice(inputRow.paid) : null;
      if (price) models.push({ name: title, id: primaryId, type: 'embedding', inputPerMTok: price });
      continue;
    }

    // Audio / TTS models
    if (primaryId.includes('audio') || primaryId.includes('tts')) {
      const inp = inputRow ? firstPrice(inputRow.paid) : null;
      const out = outputRow ? firstPrice(outputRow.paid) : null;
      if (inp || out) {
        const entry: RawGoogleModel = { name: title, id: primaryId, type: 'audio' };
        if (inp) entry.inputPerMTok = inp;
        if (out) entry.outputPerMTok = out;
        models.push(entry);
      }
      continue;
    }

    // Image generation models (Gemini with image output)
    if (primaryId.includes('-image') && !primaryId.startsWith('imagen-')) {
      const entry: RawGoogleModel = { name: title, id: primaryId, type: 'imageGeneration' };
      if (inputRow) {
        const inp = firstPrice(inputRow.paid);
        if (inp) entry.inputPerMTok = inp;
      }
      if (outputRow && outputRow.paid) {
        const paid = outputRow.paid;
        const textMatch = paid.match(/\$([\d.]+)\s*\(text/i);
        if (textMatch) entry.outputPerMTok = parseFloat(textMatch[1]);
        const perImageMatch = paid.match(/\$([\d.]+)\s*per\s+(?:[\d.]+K(?:\/[\d.]+K)?\s+)?image/i);
        if (perImageMatch) {
          entry.costPerImage = parseFloat(perImageMatch[1]);
          entry.note = `$${perImageMatch[1]}/image`;
        } else {
          const imgMTokMatch = paid.match(/\$([\d.]+)\s*\(images?\)/i);
          if (imgMTokMatch) {
            const perMTok = parseFloat(imgMTokMatch[1]);
            entry.costPerImage = Math.round(((perMTok * 1290) / 1e6) * 1000) / 1000;
            entry.note = `~$${entry.costPerImage}/image ($${perMTok}/MTok)`;
          }
        }
      }
      models.push(entry);
      continue;
    }

    // Text / ChatCompletion models (default)
    if (!inputRow || !outputRow) continue;
    const inputPrice = firstPrice(inputRow.paid);
    const outputPrice = firstPrice(outputRow.paid);
    if (!inputPrice || !outputPrice) continue;

    const entry: RawGoogleModel = {
      name: title,
      id: primaryId,
      inputPerMTok: inputPrice,
      outputPerMTok: outputPrice,
      deprecated: !!deprecated,
    };

    // Cache pricing
    if (cacheRow) {
      const cp = firstPrice(cacheRow.paid);
      if (cp) entry.cacheRead = cp;
    }

    // Context tiers (>200K)
    if (inputRow.paid.includes('>')) {
      const prices = allPrices(inputRow.paid);
      if (prices.length >= 2) entry.longContextInput = prices[1];
    }
    if (outputRow.paid.includes('>')) {
      const prices = allPrices(outputRow.paid);
      if (prices.length >= 2) entry.longContextOutput = prices[1];
    }

    // Batch pricing
    if (batchInputRow) {
      const bp = firstPrice(batchInputRow.paid);
      if (bp) entry.batchInput = bp;
    }
    if (batchOutputRow) {
      const bp = firstPrice(batchOutputRow.paid);
      if (bp) entry.batchOutput = bp;
    }

    models.push(entry);
  }

  console.error(`  Google: ${models.length} models extracted`);
  return models;
}

// ──────────────────────────────────────────────────────────────────────────────
// Convert raw models to ModelPricing[]
// ──────────────────────────────────────────────────────────────────────────────

function convertToModelPricing(rawModels: RawGoogleModel[]): ModelPricing[] {
  const results: ModelPricing[] = [];

  for (const m of rawModels) {
    const entry: ModelPricing = {
      displayName: m.name,
      sourceUrl: SOURCE_URL,
      extractionMethod: 'regex',
      pricingUnit: 'per-token',
    };

    // Determine model type and pricing unit
    if (m.type === 'image') {
      entry.modelType = 'imageGeneration';
      entry.pricingUnit = 'per-image';
      if (m.costPerImage != null) entry.costPerImage = m.costPerImage;
      results.push(entry);
      continue;
    }

    if (m.type === 'video') {
      entry.modelType = 'video';
      entry.pricingUnit = 'per-second';
      if (m.costPerSecond != null) entry.costPerSecond = m.costPerSecond;
      results.push(entry);
      continue;
    }

    if (m.type === 'embedding') {
      entry.modelType = 'embedding';
      if (m.inputPerMTok != null) entry.inputCostPerToken = toPerToken(m.inputPerMTok);
      results.push(entry);
      continue;
    }

    if (m.type === 'audio') {
      entry.modelType = 'audio';
      if (m.inputPerMTok != null) entry.inputCostPerToken = toPerToken(m.inputPerMTok);
      if (m.outputPerMTok != null) entry.outputCostPerToken = toPerToken(m.outputPerMTok);
      results.push(entry);
      continue;
    }

    if (m.type === 'imageGeneration') {
      entry.modelType = 'imageGeneration';
      entry.pricingUnit = 'per-image';
      if (m.inputPerMTok != null) entry.inputCostPerToken = toPerToken(m.inputPerMTok);
      if (m.outputPerMTok != null) entry.outputCostPerToken = toPerToken(m.outputPerMTok);
      if (m.costPerImage != null) entry.costPerImage = m.costPerImage;
      results.push(entry);
      continue;
    }

    // Default: chatCompletion
    entry.modelType = 'chatCompletion';
    if (m.inputPerMTok != null) entry.inputCostPerToken = toPerToken(m.inputPerMTok);
    if (m.outputPerMTok != null) entry.outputCostPerToken = toPerToken(m.outputPerMTok);

    // Caching
    if (m.cacheRead != null) {
      const caching: Partial<Record<CachingKey, number>> = { read: toPerToken(m.cacheRead) };
      entry.caching = caching;
    }

    // Context tiers
    if (m.longContextInput != null || m.longContextOutput != null) {
      const tier: ContextTier = { threshold: '>200K' };
      if (m.longContextInput != null) tier.inputCostPerToken = toPerToken(m.longContextInput);
      if (m.longContextOutput != null) tier.outputCostPerToken = toPerToken(m.longContextOutput);
      entry.contextTiers = [tier];
    }

    // Batch pricing
    if (m.batchInput != null && m.batchOutput != null) {
      entry.batchPricing = {
        inputCostPerToken: toPerToken(m.batchInput),
        outputCostPerToken: toPerToken(m.batchOutput),
      };
    }

    // Deprecated flag
    if (m.deprecated) entry.deprecated = true;

    results.push(entry);
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

export async function scrapeGoogle(): Promise<ModelPricing[]> {
  const rawModels = await parseGooglePricing();
  return convertToModelPricing(rawModels);
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  (process.argv[1].endsWith('scrape-google.ts') || process.argv[1].endsWith('scrape-google.js'))
) {
  const pretty = process.argv.includes('--pretty');

  scrapeGoogle()
    .then((results) => {
      const json = pretty ? JSON.stringify(results, null, 2) : JSON.stringify(results);
      process.stdout.write(json + '\n');
    })
    .catch((err: Error) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
