#!/usr/bin/env npx tsx
/**
 * Scrape Anthropic official pricing from platform.claude.com
 *
 * Usage:
 *   npx tsx scripts/scrape-anthropic.ts --json
 *   npx tsx scripts/scrape-anthropic.ts --json --no-llm
 *
 * Returns ModelPricing[] via stdout (JSON).
 *
 * Migrated from aigne-hub scrape-anthropic-pricing.mjs
 */

import type { ModelPricing, CachingKey } from './lib/schema.js';
import { httpFetch } from './lib/http.js';
import { callLlmFallback } from './lib/llm-fallback.js';
import { toPerToken } from './lib/pricing-core.js';

const URLS = [
  'https://docs.anthropic.com/en/docs/about-claude/pricing',
  'https://platform.claude.com/docs/en/docs/about-claude/pricing',
];

// ──────────────────────────────────────────────────────────────────────────────
// HTML stripping
// ──────────────────────────────────────────────────────────────────────────────

function strip(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#?[\w]+;/g, '')
    .replace(/\s+/g, ' ');
}

// ──────────────────────────────────────────────────────────────────────────────
// Model definitions — display name patterns -> canonical DB IDs
// ──────────────────────────────────────────────────────────────────────────────

interface ModelDef {
  regex: RegExp;
  name: string;
  id: string;
  deprecated?: boolean;
}

const MODEL_DEFS: ModelDef[] = [
  { regex: /Claude Opus 4\.6/i, name: 'Claude Opus 4.6', id: 'claude-opus-4-6' },
  { regex: /Claude Opus 4\.5/i, name: 'Claude Opus 4.5', id: 'claude-opus-4-5' },
  { regex: /Claude Opus 4\.1/i, name: 'Claude Opus 4.1', id: 'claude-opus-4-1' },
  { regex: /Claude Opus 4(?![.\d])/i, name: 'Claude Opus 4', id: 'claude-opus-4' },
  { regex: /Claude Sonnet 4\.6/i, name: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6' },
  { regex: /Claude Sonnet 4\.5/i, name: 'Claude Sonnet 4.5', id: 'claude-sonnet-4-5' },
  { regex: /Claude Sonnet 4(?![.\d])/i, name: 'Claude Sonnet 4', id: 'claude-sonnet-4' },
  { regex: /Claude Sonnet 3\.7/i, name: 'Claude Sonnet 3.7', id: 'claude-sonnet-3-7', deprecated: true },
  { regex: /Claude Haiku 4\.5/i, name: 'Claude Haiku 4.5', id: 'claude-haiku-4-5' },
  { regex: /Claude Haiku 3\.5/i, name: 'Claude Haiku 3.5', id: 'claude-haiku-3-5' },
  { regex: /Claude Opus 3(?![.\d])/i, name: 'Claude Opus 3', id: 'claude-opus-3', deprecated: true },
  { regex: /Claude Haiku 3(?![.\d])/i, name: 'Claude Haiku 3', id: 'claude-haiku-3' },
];

// ──────────────────────────────────────────────────────────────────────────────
// Section parsers
// ──────────────────────────────────────────────────────────────────────────────

interface ModelPricingRaw {
  name: string;
  inputPerMTok: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  outputPerMTok: number;
  deprecated?: boolean;
}

function parseModelPricing(text: string): Record<string, ModelPricingRaw> {
  const result: Record<string, ModelPricingRaw> = {};

  for (const { regex, name, id, deprecated } of MODEL_DEFS) {
    let searchFrom = 0;
    let found = false;

    while (!found) {
      const match = text.substring(searchFrom).match(regex);
      if (!match || match.index === undefined) break;

      const startIdx = searchFrom + match.index;
      const window = text.substring(startIdx, startIdx + 400);
      const priceRegex = /\$([\d]+(?:\.[\d]+)?)\s*\/\s*MTok/g;
      const prices: number[] = [];
      let pm: RegExpExecArray | null;
      while ((pm = priceRegex.exec(window)) !== null && prices.length < 5) {
        prices.push(parseFloat(pm[1]));
      }

      if (prices.length === 5) {
        const entry: ModelPricingRaw = {
          name,
          inputPerMTok: prices[0],
          cacheWrite5m: prices[1],
          cacheWrite1h: prices[2],
          cacheRead: prices[3],
          outputPerMTok: prices[4],
        };
        if (deprecated) entry.deprecated = true;
        result[id] = entry;
        found = true;
      }

      searchFrom = startIdx + match[0].length;
    }
  }

  return result;
}

interface BatchPricingRaw {
  batchInput: number;
  batchOutput: number;
}

function parseBatchPricing(text: string): Record<string, BatchPricingRaw> {
  const headerIdx = text.search(/Batch input\s+Batch output/i);
  if (headerIdx === -1) return {};

  const batchText = text.substring(headerIdx);
  const result: Record<string, BatchPricingRaw> = {};

  for (const { regex, id } of MODEL_DEFS) {
    const match = batchText.match(regex);
    if (!match || match.index === undefined) continue;

    const window = batchText.substring(match.index, match.index + 200);
    const priceRegex = /\$([\d]+(?:\.[\d]+)?)\s*\/\s*MTok/g;
    const prices: number[] = [];
    let pm: RegExpExecArray | null;
    while ((pm = priceRegex.exec(window)) !== null && prices.length < 2) {
      prices.push(parseFloat(pm[1]));
    }

    if (prices.length === 2) {
      result[id] = { batchInput: prices[0], batchOutput: prices[1] };
    }
  }

  return result;
}

interface LongContextRaw {
  standardInput: number;
  longContextInput: number;
  standardOutput: number;
  longContextOutput: number;
}

function parseLongContextPricing(text: string): Record<string, LongContextRaw> {
  const lcIdx = text.search(/Long context pricing\s+When using/i);
  if (lcIdx === -1) return {};

  const lcText = text.substring(lcIdx, lcIdx + 2000);
  const result: Record<string, LongContextRaw> = {};

  const priceRegex = /(?:Input|Output):\s*\$([\d.]+)\s*\/\s*MTok/g;

  // Opus 4.6
  let opusSearchFrom = 0;
  while (true) {
    const opusIdx = lcText.indexOf('Claude Opus 4.6', opusSearchFrom);
    if (opusIdx === -1) break;
    const opusWindow = lcText.substring(opusIdx, opusIdx + 400);
    if (!/Input:\s*\$/.test(opusWindow)) {
      opusSearchFrom = opusIdx + 16;
      continue;
    }
    const prices: number[] = [];
    let pm: RegExpExecArray | null;
    priceRegex.lastIndex = 0;
    while ((pm = priceRegex.exec(opusWindow)) !== null && prices.length < 4) {
      prices.push(parseFloat(pm[1]));
    }
    if (prices.length === 4) {
      result['claude-opus-4-6'] = {
        standardInput: prices[0],
        longContextInput: prices[1],
        standardOutput: prices[2],
        longContextOutput: prices[3],
      };
    }
    break;
  }

  // Sonnet 4.6 / 4.5 / 4
  const sonnetIdx = lcText.search(/Claude Sonnet 4\.6/i);
  if (sonnetIdx !== -1) {
    const sonnetWindow = lcText.substring(sonnetIdx, sonnetIdx + 400);
    const prices: number[] = [];
    let pm: RegExpExecArray | null;
    priceRegex.lastIndex = 0;
    while ((pm = priceRegex.exec(sonnetWindow)) !== null && prices.length < 4) {
      prices.push(parseFloat(pm[1]));
    }
    if (prices.length === 4) {
      const lc: LongContextRaw = {
        standardInput: prices[0],
        longContextInput: prices[1],
        standardOutput: prices[2],
        longContextOutput: prices[3],
      };
      for (const sid of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4']) {
        result[sid] = { ...lc };
      }
    }
  }

  return result;
}

interface FastModeRaw {
  fastModeInput: number;
  fastModeOutput: number;
  multiplier: string;
}

function parseFastModePricing(text: string): Record<string, FastModeRaw> {
  const fmIdx = text.search(/Fast mode pricing\s+Fast mode for/i);
  if (fmIdx === -1) return {};

  const fmText = text.substring(fmIdx, fmIdx + 800);
  const result: Record<string, FastModeRaw> = {};

  const priceRegex = /\$([\d.]+)\s*\/\s*MTok/g;
  const prices: number[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = priceRegex.exec(fmText)) !== null && prices.length < 2) {
    prices.push(parseFloat(pm[1]));
  }

  if (prices.length === 2) {
    result['claude-opus-4-6'] = {
      fastModeInput: prices[0],
      fastModeOutput: prices[1],
      multiplier: '6x standard rates',
    };
  }

  return result;
}

interface DataResidencyInfo {
  usOnlyMultiplier: number;
  applies: string;
  note: string;
}

function parseDataResidencyPricing(text: string): DataResidencyInfo | null {
  const drIdx = text.search(/Data residency pricing/i);
  if (drIdx === -1) return null;

  const drText = text.substring(drIdx, drIdx + 500);
  const match = drText.match(/([\d.]+)x\s*multiplier/i);
  if (!match) return null;

  return {
    usOnlyMultiplier: parseFloat(match[1]),
    applies: 'Claude Opus 4.6 and newer models',
    note: 'US-only inference via inference_geo parameter',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// LLM fallback section expectations
// ──────────────────────────────────────────────────────────────────────────────

const SECTION_EXPECTATIONS: Record<string, { minEntries: number; requiredKeys: string[] }> = {
  modelPricing: { minEntries: 10, requiredKeys: ['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'] },
  batchPricing: { minEntries: 10, requiredKeys: ['claude-opus-4-6', 'claude-sonnet-4-5'] },
  longContextPricing: { minEntries: 2, requiredKeys: ['claude-opus-4-6'] },
  fastModePricing: { minEntries: 1, requiredKeys: ['claude-opus-4-6'] },
};

function isSectionSuspicious(sectionName: string, result: Record<string, unknown>): boolean {
  const expect = SECTION_EXPECTATIONS[sectionName];
  if (!expect) return false;

  const keys = Object.keys(result ?? {});
  if (keys.length === 0) return true;
  if (keys.length < expect.minEntries) return true;
  for (const k of expect.requiredKeys) {
    if (!keys.includes(k)) return true;
  }
  return false;
}

const SECTION_ANCHORS: Record<string, { start: string; end: string[] }> = {
  modelPricing: { start: 'Model pricing', end: ['Batch input', 'Batch processing', 'Long context'] },
  batchPricing: { start: 'Batch input Batch output', end: ['Long context pricing', 'Fast mode'] },
  longContextPricing: { start: 'Long context pricing', end: ['Fast mode pricing'] },
  fastModePricing: { start: 'Fast mode pricing', end: ['Batch processing', 'Data residency'] },
};

const SECTION_PROMPTS: Record<string, { schema: string; example: string; instructions: string }> = {
  modelPricing: {
    schema:
      '{ "model-id": { "name": string, "inputPerMTok": number, "cacheWrite5m": number, "cacheWrite1h": number, "cacheRead": number, "outputPerMTok": number } }',
    example:
      '{ "claude-opus-4-6": { "name": "Claude Opus 4.6", "inputPerMTok": 5, "cacheWrite5m": 6.25, "cacheWrite1h": 10, "cacheRead": 0.5, "outputPerMTok": 25 } }',
    instructions:
      'Extract ALL Claude model pricing. Each model has 5 prices in $/MTok: Input, 5-minute Cache Write, 1-hour Cache Write, Cache Hit (Read), Output. Use slug IDs like "claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-3-5" etc.',
  },
  batchPricing: {
    schema: '{ "model-id": { "batchInput": number, "batchOutput": number } }',
    example: '{ "claude-opus-4-6": { "batchInput": 2.5, "batchOutput": 12.5 } }',
    instructions:
      'Extract batch processing prices for ALL Claude models. Each has Batch Input and Batch Output in $/MTok (50% of standard). Use slug IDs like "claude-opus-4-6".',
  },
  longContextPricing: {
    schema:
      '{ "model-id": { "standardInput": number, "longContextInput": number, "standardOutput": number, "longContextOutput": number } }',
    example:
      '{ "claude-opus-4-6": { "standardInput": 5, "longContextInput": 10, "standardOutput": 25, "longContextOutput": 37.5 } }',
    instructions:
      'Extract long context pricing (>200K input tokens). Each model row has 4 values: standard input, long context input, standard output, long context output in $/MTok. For rows like "Sonnet 4.6 / 4.5 / 4", create separate entries for each model.',
  },
  fastModePricing: {
    schema: '{ "model-id": { "fastModeInput": number, "fastModeOutput": number, "multiplier": string } }',
    example:
      '{ "claude-opus-4-6": { "fastModeInput": 30, "fastModeOutput": 150, "multiplier": "6x standard rates" } }',
    instructions: 'Extract fast mode pricing. Currently only for Opus 4.6. Input and Output in $/MTok.',
  },
};

function findSectionEnd(text: string, start: number, candidates: string[], fallbackLen = 3000): number {
  let best = -1;
  for (const c of candidates) {
    const idx = text.indexOf(c, start + 20);
    if (idx > start && (best === -1 || idx < best)) best = idx;
  }
  return best > start ? best : start + fallbackLen;
}

function extractSectionText(text: string, sectionName: string): string {
  const anchors = SECTION_ANCHORS[sectionName];
  if (!anchors) return '';
  const startIdx = text.indexOf(anchors.start);
  if (startIdx === -1) return '';
  const endIdx = findSectionEnd(text, startIdx, anchors.end);
  return text.substring(startIdx, endIdx);
}

async function tryLlmFallback<T extends Record<string, unknown>>(
  sectionName: string,
  regexResult: T,
  text: string,
  extractionMethod: Record<string, string>,
  noLLM: boolean,
): Promise<T> {
  extractionMethod[sectionName] = 'regex';
  if (isSectionSuspicious(sectionName, regexResult) && !noLLM) {
    console.error(
      `  ${sectionName} suspicious (${Object.keys(regexResult ?? {}).length} entries), trying LLM fallback...`,
    );
    const prompt = SECTION_PROMPTS[sectionName];
    if (prompt) {
      const systemPrompt = [
        'You are a pricing data extractor. Extract structured pricing data from the given text.',
        `Output ONLY valid JSON matching this schema: ${prompt.schema}`,
        `Example output: ${prompt.example}`,
        prompt.instructions,
        'All prices must be numbers (not strings). Use null for missing values.',
        'Do NOT include any text outside the JSON object.',
      ].join('\n');

      const sectionText = extractSectionText(text, sectionName);
      const llmResult = await callLlmFallback({
        provider: `anthropic-${sectionName}`,
        prompt: systemPrompt,
        htmlContent: sectionText,
      });
      if (llmResult) {
        try {
          const parsed = JSON.parse(llmResult.content) as T;
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            if (!isSectionSuspicious(sectionName, parsed as Record<string, unknown>)) {
              extractionMethod[sectionName] = 'llm';
              return parsed;
            }
          }
        } catch {
          // JSON parse failed
        }
        extractionMethod[sectionName] = 'regex+llm-failed';
      } else {
        extractionMethod[sectionName] = 'regex+llm-skipped';
      }
    }
  }
  return regexResult;
}

// ──────────────────────────────────────────────────────────────────────────────
// Convert to ModelPricing[]
// ──────────────────────────────────────────────────────────────────────────────

function convertToModelPricing(
  modelPricing: Record<string, ModelPricingRaw>,
  batchPricing: Record<string, BatchPricingRaw>,
  longContextPricing: Record<string, LongContextRaw>,
  fastModePricing: Record<string, FastModeRaw>,
  sourceUrl: string,
  extractionMethod: Record<string, string>,
): ModelPricing[] {
  const results: ModelPricing[] = [];

  // Merge all sections per model
  const allIds = new Set([
    ...Object.keys(modelPricing),
    ...Object.keys(batchPricing),
    ...Object.keys(longContextPricing),
    ...Object.keys(fastModePricing),
  ]);

  for (const modelId of allIds) {
    const mp = modelPricing[modelId];
    if (!mp) continue; // Only create entries for models with base pricing

    const entry: ModelPricing = {
      displayName: mp.name,
      modelType: 'chatCompletion',
      pricingUnit: 'per-token',
      sourceUrl,
      extractionMethod: extractionMethod.modelPricing,
    };

    // Base token pricing
    entry.inputCostPerToken = toPerToken(mp.inputPerMTok);
    entry.outputCostPerToken = toPerToken(mp.outputPerMTok);

    // Caching with enum keys
    const caching: Partial<Record<CachingKey, number>> = {};
    if (mp.cacheWrite5m != null) caching['write-5min'] = toPerToken(mp.cacheWrite5m);
    if (mp.cacheWrite1h != null) caching['write-1h'] = toPerToken(mp.cacheWrite1h);
    if (mp.cacheRead != null) caching.read = toPerToken(mp.cacheRead);
    if (Object.keys(caching).length > 0) entry.caching = caching;

    // Batch pricing
    const batch = batchPricing[modelId];
    if (batch) {
      entry.batchPricing = {
        inputCostPerToken: toPerToken(batch.batchInput),
        outputCostPerToken: toPerToken(batch.batchOutput),
        discountNote: '50% of standard',
      };
    }

    // Long context (context tiers)
    const lc = longContextPricing[modelId];
    if (lc) {
      entry.contextTiers = [
        {
          threshold: '>200K',
          inputCostPerToken: toPerToken(lc.longContextInput),
          outputCostPerToken: toPerToken(lc.longContextOutput),
        },
      ];
    }

    // Fast mode (special modes)
    const fm = fastModePricing[modelId];
    if (fm) {
      entry.specialModes = [
        {
          mode: 'fast-mode',
          inputCostPerToken: toPerToken(fm.fastModeInput),
          outputCostPerToken: toPerToken(fm.fastModeOutput),
          multiplierNote: fm.multiplier,
        },
      ];
    }

    // Deprecated flag
    if (mp.deprecated) {
      entry.deprecated = true;
    }

    results.push(entry);
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

export async function scrapeAnthropic(options: { noLlm?: boolean } = {}): Promise<ModelPricing[]> {
  const noLLM = options.noLlm ?? false;

  if (noLLM) console.error('LLM fallback disabled (--no-llm)');

  // Try fetching from URLs in order
  let html: string | undefined;
  let sourceUrl = '';
  for (const url of URLS) {
    try {
      console.error(`Fetching ${url} ...`);
      html = await httpFetch(url);
      sourceUrl = url;
      console.error(`  Success (${Math.round(html.length / 1024)}KB)`);
      break;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Failed: ${message}`);
    }
  }

  if (!html) {
    console.error('ERROR: Could not fetch Anthropic pricing page from any URL');
    return [];
  }

  const text = strip(html);
  console.error(`  Stripped text: ${text.length} chars`);

  const extractionMethod: Record<string, string> = {};

  // Parse each section with LLM fallback
  const modelPricingResult = await tryLlmFallback(
    'modelPricing',
    parseModelPricing(text),
    text,
    extractionMethod,
    noLLM,
  );
  console.error(
    `  Model pricing: ${Object.keys(modelPricingResult).length} models [${extractionMethod.modelPricing}]`,
  );

  const batchPricingResult = await tryLlmFallback(
    'batchPricing',
    parseBatchPricing(text) as Record<string, unknown>,
    text,
    extractionMethod,
    noLLM,
  ) as Record<string, BatchPricingRaw>;
  console.error(
    `  Batch pricing: ${Object.keys(batchPricingResult).length} models [${extractionMethod.batchPricing}]`,
  );

  const longContextResult = await tryLlmFallback(
    'longContextPricing',
    parseLongContextPricing(text) as Record<string, unknown>,
    text,
    extractionMethod,
    noLLM,
  ) as Record<string, LongContextRaw>;
  console.error(
    `  Long context pricing: ${Object.keys(longContextResult).length} models [${extractionMethod.longContextPricing}]`,
  );

  const fastModeResult = await tryLlmFallback(
    'fastModePricing',
    parseFastModePricing(text) as Record<string, unknown>,
    text,
    extractionMethod,
    noLLM,
  ) as Record<string, FastModeRaw>;
  console.error(
    `  Fast mode pricing: ${Object.keys(fastModeResult).length} models [${extractionMethod.fastModePricing}]`,
  );

  const dataResidency = parseDataResidencyPricing(text);
  console.error(`  Data residency: ${dataResidency ? 'found' : 'not found'}`);

  const results = convertToModelPricing(
    modelPricingResult,
    batchPricingResult,
    longContextResult,
    fastModeResult,
    sourceUrl,
    extractionMethod,
  );

  console.error(`  Total ModelPricing entries: ${results.length}`);
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  (process.argv[1].endsWith('scrape-anthropic.ts') || process.argv[1].endsWith('scrape-anthropic.js'))
) {
  const noLlm = process.argv.includes('--no-llm');
  const pretty = process.argv.includes('--pretty');

  scrapeAnthropic({ noLlm })
    .then((results) => {
      const json = pretty ? JSON.stringify(results, null, 2) : JSON.stringify(results);
      process.stdout.write(json + '\n');
    })
    .catch((err: Error) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
