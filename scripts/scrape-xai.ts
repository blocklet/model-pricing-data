#!/usr/bin/env npx tsx
/**
 * Scrape xAI official pricing from docs.x.ai
 *
 * Usage:
 *   npx tsx scripts/scrape-xai.ts --json
 *
 * Returns ModelPricing[] via stdout (JSON).
 *
 * Key details:
 * - Pricing embedded in Next.js RSC JSON as LanguageModel entries
 * - Values use "$nXXXXX" format with double-escaped quotes
 * - All $n values share the same base unit:
 *   - Language models: divide by 1e4 to get $/MTok, then by 1e6 for $/token
 *   - Image/video models: divide by 1e10 directly for $/image or $/second
 *
 * Migrated from the scrapeXAI() function in aigne-hub official-pricing-catalog.mjs
 */

import type { ModelPricing, CachingKey, ContextTier } from './lib/schema.js';
import { httpFetch } from './lib/http.js';
import { toPerToken } from './lib/pricing-core.js';

const PRICING_URL = 'https://docs.x.ai/developers/models';
const SOURCE_URL = PRICING_URL;

// ──────────────────────────────────────────────────────────────────────────────
// Internal raw model types
// ──────────────────────────────────────────────────────────────────────────────

interface RawXAIModel {
  id: string;
  name: string;
  type?: 'language' | 'imageGeneration' | 'video';
  inputPerMTok?: number | null;
  outputPerMTok?: number | null;
  cacheRead?: number | null;
  longContextInput?: number | null;
  longContextOutput?: number | null;
  longContextThreshold?: string;
  maxContext?: number;
  costPerImage?: number;
  costPerSecond?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Parse xAI RSC data
// ──────────────────────────────────────────────────────────────────────────────

function parseXAIHtml(html: string): RawXAIModel[] {
  const models: RawXAIModel[] = [];
  const seen = new Set<string>();

  // ── Language models ──
  // xAI uses Next.js RSC format with LanguageModel entries in escaped JSON.
  // Prices use "$nXXXXX" format where value = XXXXX / 10000 gives $/MTok.
  const marker = '\\"auth_mgmt.LanguageModel\\"';
  const parts = html.split(marker);

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const nameMatch = p.match(/\\"name\\":\\"([^\\]+)\\"/);
    const name = nameMatch?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const $n = (field: string): number | null => {
      const m = p.match(new RegExp(`\\\\"${field}\\\\":\\\\"\\\$n(\\d+)\\\\"`));
      return m ? parseInt(m[1]) / 10000 : null;
    };

    const inputPerMTok = $n('promptTextTokenPrice');
    const outputPerMTok = $n('completionTextTokenPrice');
    if (inputPerMTok == null && outputPerMTok == null) continue;

    const cachedPerMTok = $n('cachedPromptTokenPrice');
    const longCtxIn = $n('promptTextTokenPriceLongContext');
    const longCtxOut = $n('completionTokenPriceLongContext');
    const maxPromptMatch = p.match(/\\"maxPromptLength\\":(\d+)/);
    const maxPrompt = maxPromptMatch?.[1];
    const aliasesRawMatch = p.match(/\\"aliases\\":\[([^\]]*)\]/);
    const aliasesRaw = aliasesRawMatch?.[1];
    const aliases = aliasesRaw
      ? aliasesRaw
          .replace(/\\"/g, '')
          .split(',')
          .filter(Boolean)
      : [];

    const entry: RawXAIModel = { id: name, name, type: 'language', inputPerMTok, outputPerMTok };
    if (cachedPerMTok) entry.cacheRead = cachedPerMTok;
    if (longCtxIn) {
      entry.longContextInput = longCtxIn;
      entry.longContextThreshold = '>128K';
    }
    if (longCtxOut) entry.longContextOutput = longCtxOut;
    if (maxPrompt) entry.maxContext = parseInt(maxPrompt);

    // Register main model + aliases
    models.push(entry);
    for (const alias of aliases) {
      if (!seen.has(alias)) {
        seen.add(alias);
        models.push({ ...entry, id: alias, name: alias });
      }
    }
  }

  // ── Image generation models ──
  const imgMarker = '\\"auth_mgmt.ImageGenerationModel\\"';
  const imgParts = html.split(imgMarker);
  for (let i = 1; i < imgParts.length; i++) {
    const p = imgParts[i];
    const nameMatch = p.match(/\\"name\\":\\"([^\\]+)\\"/);
    const name = nameMatch?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const priceRawMatch = p.match(/\\"pricePerImage\\":\\"\$n(\d+)\\"/);
    const priceRaw = priceRawMatch?.[1];
    if (priceRaw) {
      // xAI RSC stores all prices in the same base unit (divide by 1e10 for $).
      // Language models use /1e4 ($/MTok) then /1e6 ($/token) = /1e10 total.
      // Image prices are per-image, so divide by 1e10 directly.
      models.push({ id: name, name, type: 'imageGeneration', costPerImage: parseInt(priceRaw) / 1e10 });
    }
  }

  // ── Video generation models ──
  const vidMarker = '\\"auth_mgmt.VideoGenerationModel\\"';
  const vidParts = html.split(vidMarker);
  for (let i = 1; i < vidParts.length; i++) {
    const p = vidParts[i];
    const nameMatch = p.match(/\\"name\\":\\"([^\\]+)\\"/);
    const name = nameMatch?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const priceRawMatch = p.match(/\\"pricePerSecond\\":\\"\$n(\d+)\\"/);
    const priceRaw = priceRawMatch?.[1];
    if (priceRaw) {
      // Same base unit as image models -- divide by 1e10 for $/second.
      models.push({ id: name, name, type: 'video', costPerSecond: parseInt(priceRaw) / 1e10 });
    }
  }

  console.error(`  xAI: ${models.length} models extracted`);
  return models;
}

// ──────────────────────────────────────────────────────────────────────────────
// Convert to ModelPricing[]
// ──────────────────────────────────────────────────────────────────────────────

function convertToModelPricing(rawModels: RawXAIModel[]): ModelPricing[] {
  const results: ModelPricing[] = [];

  for (const m of rawModels) {
    if (m.type === 'imageGeneration') {
      const entry: ModelPricing = {
        displayName: m.name,
        modelType: 'imageGeneration',
        pricingUnit: 'per-image',
        sourceUrl: SOURCE_URL,
        extractionMethod: 'regex',
      };
      if (m.costPerImage != null) entry.costPerImage = m.costPerImage;
      results.push(entry);
      continue;
    }

    if (m.type === 'video') {
      const entry: ModelPricing = {
        displayName: m.name,
        modelType: 'video',
        pricingUnit: 'per-second',
        sourceUrl: SOURCE_URL,
        extractionMethod: 'regex',
      };
      if (m.costPerSecond != null) entry.costPerSecond = m.costPerSecond;
      results.push(entry);
      continue;
    }

    // Language models
    const entry: ModelPricing = {
      displayName: m.name,
      modelType: 'chatCompletion',
      pricingUnit: 'per-token',
      sourceUrl: SOURCE_URL,
      extractionMethod: 'regex',
    };

    if (m.inputPerMTok != null) entry.inputCostPerToken = toPerToken(m.inputPerMTok);
    if (m.outputPerMTok != null) entry.outputCostPerToken = toPerToken(m.outputPerMTok);

    // Caching
    if (m.cacheRead != null) {
      const caching: Partial<Record<CachingKey, number>> = { read: toPerToken(m.cacheRead) };
      entry.caching = caching;
    }

    // Long context tiers
    if (m.longContextInput != null || m.longContextOutput != null) {
      const tier: ContextTier = { threshold: m.longContextThreshold || '>128K' };
      if (m.longContextInput != null) tier.inputCostPerToken = toPerToken(m.longContextInput);
      if (m.longContextOutput != null) tier.outputCostPerToken = toPerToken(m.longContextOutput);
      entry.contextTiers = [tier];
    }

    results.push(entry);
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

export async function scrapeXAI(): Promise<ModelPricing[]> {
  console.error('Fetching xAI pricing...');

  let html: string;
  try {
    html = await httpFetch(PRICING_URL);
  } catch (err: unknown) {
    // xAI has intermittent TLS issues — try Python as fallback
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  xAI: Node fetch failed: ${message}, trying Python fallback...`);
    try {
      const { execFileSync } = await import('child_process');
      html = execFileSync(
        'python3',
        [
          '-c',
          `import urllib.request;r=urllib.request.urlopen(urllib.request.Request('${PRICING_URL}',headers={'User-Agent':'Mozilla/5.0 (compatible; ModelPricingData/1.0)'}),timeout=20);print(r.read().decode())`,
        ],
        { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      ).toString();
    } catch (e2: unknown) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      console.error(`  xAI: Python fallback also failed: ${msg2}`);
      return [];
    }
  }

  const rawModels = parseXAIHtml(html);
  if (rawModels.length === 0) {
    console.error('  xAI: No models extracted');
    return [];
  }

  return convertToModelPricing(rawModels);
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && (process.argv[1].endsWith('scrape-xai.ts') || process.argv[1].endsWith('scrape-xai.js'))) {
  const pretty = process.argv.includes('--pretty');

  scrapeXAI()
    .then((results) => {
      const json = pretty ? JSON.stringify(results, null, 2) : JSON.stringify(results);
      process.stdout.write(json + '\n');
    })
    .catch((err: Error) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
