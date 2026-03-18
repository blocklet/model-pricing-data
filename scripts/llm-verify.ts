#!/usr/bin/env npx tsx
/**
 * LLM Verification Module
 *
 * When regex scraper results diverge significantly from previous data,
 * trigger LLM re-extraction to cross-check.
 *
 * Thresholds:
 *   - OpenAI: >10% change in model count
 *   - Others: >3 model count difference
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ModelPricing, PricingData } from './lib/schema.js';
import { httpFetch, postJson } from './lib/http.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VerifyResult {
  provider: string;
  regexCount: number;
  previousCount: number;
  llmCount: number;
  action: 'keep-regex' | 'use-llm' | 'skip';
  reason: string;
  llmModels?: ModelPricing[];
}

interface AnthropicResponse {
  content?: Array<{ text?: string; type?: string }>;
}

// ─── Thresholds ─────────────────────────────────────────────────────────────

function needsVerification(provider: string, regexCount: number, previousCount: number): boolean {
  if (previousCount === 0) return false; // first run, no previous data

  const diff = Math.abs(regexCount - previousCount);

  if (provider === 'openai') {
    // OpenAI: >10% change
    return diff > previousCount * 0.1;
  }
  // Others: >3 model difference
  return diff > 3;
}

// ─── Load Previous Data ─────────────────────────────────────────────────────

function loadPreviousCounts(): Record<string, number> {
  try {
    const filePath = path.resolve(import.meta.dirname!, '..', 'data', 'pricing.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const prev = JSON.parse(raw) as PricingData;
    const counts: Record<string, number> = {};
    for (const [provider, models] of Object.entries(prev.providers)) {
      counts[provider] = Object.keys(models).filter(k => !k.includes('::')).length;
    }
    return counts;
  } catch {
    return {};
  }
}

// ─── Provider-specific LLM extraction ───────────────────────────────────────

const PROVIDER_URLS: Record<string, string> = {
  openai: 'https://developers.openai.com/api/docs/pricing?latest-pricing=standard',
  anthropic: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
};

const LLM_SYSTEM_PROMPT = `You are a pricing data extractor. Extract ALL AI models and their pricing from the provided text.

Output ONLY valid JSON:
{
  "models": [
    {
      "modelId": "model-name",
      "modelType": "chatCompletion",
      "inputPerMTok": 2.0,
      "outputPerMTok": 8.0,
      "cachedInputPerMTok": 0.5
    }
  ]
}

Rules:
- Extract EVERY model with pricing info. Do NOT skip any.
- modelId: lowercase with hyphens
- modelType: one of chatCompletion, audio, video, fineTuning, imageGeneration, embedding, transcription
- Prices in $/MTok for token models
- For image models: use costPerImage. For video: costPerSecond.
- Set null for fields not found.
- Do NOT hallucinate prices.`;

async function callLlmForProvider(provider: string): Promise<ModelPricing[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(`  [verify] No ANTHROPIC_API_KEY, skipping LLM verify for ${provider}`);
    return null;
  }

  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  const url = PROVIDER_URLS[provider];
  if (!url) {
    console.error(`  [verify] No URL configured for ${provider}`);
    return null;
  }

  try {
    // Fetch page
    const html = await httpFetch(url);

    // Prepare content based on provider
    let content: string;
    if (provider === 'openai') {
      content = prepareOpenAIContent(html);
    } else {
      // Generic: clean HTML to text
      content = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#?\w+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40000);
    }

    console.error(`  [verify] Calling ${model} for ${provider} (${content.length} chars)...`);

    const resp = await postJson<AnthropicResponse>(
      `${baseUrl}/v1/messages`,
      {
        model,
        max_tokens: 16384,
        thinking: { type: 'disabled' },
        system: LLM_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      },
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      { timeoutMs: 180000 },
    );

    const text = resp.content?.find(c => c.type === 'text')?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const data = JSON.parse(jsonMatch[0]);
    const models = data.models as ModelPricing[];
    return models;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [verify] LLM error for ${provider}: ${msg}`);
    return null;
  }
}

/**
 * OpenAI: extract Astro Island props + other sections as readable text
 */
function prepareOpenAIContent(html: string): string {
  // 1. Extract Standard tier from Astro Island props
  const propsRegex = /props="([^"]{200,})"/g;
  let m: RegExpExecArray | null;
  let tableText = '## Text Token Models (Standard Tier)\nModel | Input($/MTok) | CachedInput | Output\n';

  while ((m = propsRegex.exec(html)) !== null) {
    const decoded = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    try {
      const data = JSON.parse(decoded);
      if (data.tier?.[1] !== 'standard' || !data.rows) continue;
      for (const row of data.rows[1]) {
        if (row[0] !== 1) continue;
        const cells = row[1];
        if (!cells || cells.length < 4) continue;
        tableText += `${String(cells[0][1])}|${cells[1][1] ?? '-'}|${cells[2][1] ?? '-'}|${cells[3][1] ?? '-'}\n`;
      }
    } catch { /* skip */ }
  }

  // 2. Other sections from clean text
  const cleanText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sections = ['Image tokens', 'Audio tokens', 'Video Prices', 'Transcription',
    'Fine-tuning', 'Image generation', 'Embedding', 'Legacy models'];
  let otherText = '';
  for (let i = 0; i < sections.length; i++) {
    const start = cleanText.indexOf(sections[i]);
    if (start < 0) continue;
    const nextStart = i + 1 < sections.length ? cleanText.indexOf(sections[i + 1], start) : -1;
    const end = nextStart > 0 ? nextStart : start + 3000;
    otherText += `\n## ${sections[i]}\n${cleanText.slice(start, Math.min(end, start + 3000))}\n`;
  }

  return tableText + '\n' + otherText;
}

// ─── Main Verify Function ───────────────────────────────────────────────────

export async function verifyScraperResults(
  scraperResults: Array<{ provider: string; entries: ModelPricing[] }>,
): Promise<VerifyResult[]> {
  const previousCounts = loadPreviousCounts();
  const results: VerifyResult[] = [];

  for (const { provider, entries } of scraperResults) {
    // Count unique base models (same logic as merge: dedupe by displayName)
    const uniqueModels = new Set(entries.map(e => (e.displayName || '').toLowerCase().replace(/\s+/g, '-')));
    const regexCount = uniqueModels.size;
    const previousCount = previousCounts[provider] ?? 0;

    if (!needsVerification(provider, regexCount, previousCount)) {
      continue; // within threshold, no verify needed
    }

    const diff = regexCount - previousCount;
    const pct = previousCount > 0 ? ((diff / previousCount) * 100).toFixed(1) : '∞';
    console.error(`  [verify] ${provider}: count changed ${previousCount} → ${regexCount} (${diff > 0 ? '+' : ''}${diff}, ${pct}%), triggering LLM check...`);

    const llmModels = await callLlmForProvider(provider);

    if (!llmModels) {
      results.push({
        provider, regexCount, previousCount, llmCount: 0,
        action: 'keep-regex', reason: 'LLM unavailable, keeping regex result',
      });
      continue;
    }

    const llmCount = llmModels.length;
    console.error(`  [verify] ${provider}: regex=${regexCount} vs llm=${llmCount} vs previous=${previousCount}`);

    // Decision logic:
    // If regex is closer to LLM than to previous → real change, keep regex
    // If LLM is closer to previous → regex might have broken, warn but keep regex
    const regexDiffFromPrev = Math.abs(regexCount - previousCount);
    const llmDiffFromPrev = Math.abs(llmCount - previousCount);
    const regexDiffFromLlm = Math.abs(regexCount - llmCount);

    if (regexDiffFromLlm <= 5) {
      // Regex and LLM agree — real change
      results.push({
        provider, regexCount, previousCount, llmCount,
        action: 'keep-regex',
        reason: `Regex and LLM agree (diff=${regexDiffFromLlm}), real pricing page change`,
      });
    } else if (llmDiffFromPrev < regexDiffFromPrev) {
      // LLM closer to previous — regex might be broken
      results.push({
        provider, regexCount, previousCount, llmCount,
        action: 'use-llm',
        reason: `LLM (${llmCount}) closer to previous (${previousCount}) than regex (${regexCount}), possible regex breakage`,
        llmModels,
      });
    } else {
      // Regex closer to previous or both diverge — keep regex
      results.push({
        provider, regexCount, previousCount, llmCount,
        action: 'keep-regex',
        reason: `Keeping regex result, LLM also diverges`,
      });
    }
  }

  return results;
}
