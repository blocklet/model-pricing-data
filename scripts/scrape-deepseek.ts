#!/usr/bin/env npx tsx
/**
 * Scrape DeepSeek official pricing from api-docs.deepseek.com
 *
 * Usage:
 *   npx tsx scripts/scrape-deepseek.ts --json
 *
 * Returns ModelPricing[] via stdout (JSON).
 *
 * Key details:
 * - HTML table with "CACHE MISS" row (NOT "1M INPUT" which hits CACHE HIT first)
 * - Both models (deepseek-chat and deepseek-reasoner) share identical pricing
 *
 * Migrated from the scrapeDeepSeek() function in aigne-hub official-pricing-catalog.mjs
 */

import type { ModelPricing, CachingKey } from './lib/schema.js';
import { httpFetch } from './lib/http.js';
import { toPerToken } from './lib/pricing-core.js';

const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing';
const SOURCE_URL = PRICING_URL;

// ──────────────────────────────────────────────────────────────────────────────
// HTML stripping
// ──────────────────────────────────────────────────────────────────────────────

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?[\w]+;/g, '')
    .replace(/\s+/g, ' ');
}

// ──────────────────────────────────────────────────────────────────────────────
// Parse and convert
// ──────────────────────────────────────────────────────────────────────────────

export async function scrapeDeepSeek(): Promise<ModelPricing[]> {
  console.error('Fetching DeepSeek pricing...');
  const html = await httpFetch(PRICING_URL);
  const text = strip(html);

  const results: ModelPricing[] = [];

  // DeepSeek page has a single table with 2 models sharing the same pricing.
  // Format: "1M INPUT TOKENS (CACHE MISS) $X.XX" / "1M INPUT TOKENS (CACHE HIT) $X.XX" / "1M OUTPUT TOKENS $X.XX"
  const cacheMiss = text.match(/CACHE MISS[^$]*\$([\d.]+)/i);
  const cacheHit = text.match(/CACHE HIT[^$]*\$([\d.]+)/i);
  const outputMatch = text.match(/1M OUTPUT TOKENS[^$]*\$([\d.]+)/i);

  if (cacheMiss && outputMatch) {
    const inputPerMTok = parseFloat(cacheMiss[1]);
    const outputPerMTok = parseFloat(outputMatch[1]);
    const cacheReadPerMTok = cacheHit ? parseFloat(cacheHit[1]) : null;

    // Both models share identical pricing
    const modelDefs = [
      { id: 'deepseek-chat' },
      { id: 'deepseek-reasoner' },
    ];

    for (const { id } of modelDefs) {
      const entry: ModelPricing = {
        displayName: id,
        modelType: 'chatCompletion',
        pricingUnit: 'per-token',
        inputCostPerToken: toPerToken(inputPerMTok),
        outputCostPerToken: toPerToken(outputPerMTok),
        sourceUrl: SOURCE_URL,
        extractionMethod: 'regex',
      };

      // Caching
      if (cacheReadPerMTok != null) {
        const caching: Partial<Record<CachingKey, number>> = { read: toPerToken(cacheReadPerMTok) };
        entry.caching = caching;
      }

      results.push(entry);
    }
  }

  console.error(`  DeepSeek: ${results.length} models extracted`);
  if (results.length === 0) {
    console.error('  DeepSeek: Regex extracted 0 models');
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  (process.argv[1].endsWith('scrape-deepseek.ts') || process.argv[1].endsWith('scrape-deepseek.js'))
) {
  const pretty = process.argv.includes('--pretty');

  scrapeDeepSeek()
    .then((results) => {
      const json = pretty ? JSON.stringify(results, null, 2) : JSON.stringify(results);
      process.stdout.write(json + '\n');
    })
    .catch((err: Error) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
