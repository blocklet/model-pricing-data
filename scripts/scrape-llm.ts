#!/usr/bin/env npx tsx
/**
 * Pure LLM Scraper — extracts pricing from all providers using LLM only.
 *
 * Used when --llm-only flag is set. Fetches each provider's pricing page,
 * pre-processes HTML into clean text, and sends to LLM for extraction.
 *
 * OpenAI requires special handling: Astro Island props must be decoded first.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ModelPricing } from './lib/schema.js';
import { httpFetch, postJson } from './lib/http.js';
import { PRICING_URLS } from './lib/pricing-core.js';

const execFileAsync = promisify(execFile);

// Actual working URLs for each provider (may differ from PRICING_URLS)
const LLM_FETCH_URLS: Record<string, string> = {
  openai: 'https://developers.openai.com/api/docs/pricing?latest-pricing=standard',
  anthropic: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  xai: 'https://docs.x.ai/docs/models',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface AnthropicResponse {
  content?: Array<{ text?: string; type?: string }>;
}

// ─── Provider-specific content preparation ──────────────────────────────────

function cleanHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function prepareOpenAIContent(html: string): string {
  // Extract Standard tier from Astro Island props → readable table
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

  // Other sections from clean text
  const cleanText = cleanHtmlToText(html);
  const sections = ['Image tokens', 'Audio tokens', 'Video Prices', 'Transcription',
    'Fine-tuning', 'Image generation', 'Embedding', 'Built-in tools', 'Legacy models'];
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

// ─── LLM Prompt ─────────────────────────────────────────────────────────────

function buildPrompt(provider: string): string {
  const base = `You are a pricing data extractor for ${provider} AI models.
Extract ALL models and their pricing from the provided text.
Output ONLY valid JSON:
{
  "models": [
    {
      "modelId": "model-name",
      "displayName": "Model Name",
      "modelType": "chatCompletion",
      "inputPerMTok": 2.0,
      "outputPerMTok": 8.0,
      "cachedInputPerMTok": 0.5,
      "batchInputPerMTok": 1.0,
      "batchOutputPerMTok": 4.0
    }
  ]
}

Rules:
- Extract EVERY model. Do NOT skip any.
- modelId: lowercase with hyphens (e.g. "gpt-4.1", "claude-opus-4-6")
- modelType: one of chatCompletion, audio, video, fineTuning, imageGeneration, embedding, transcription, tool
- All token prices in $/MTok
- For image models: add "costPerImage" field
- For video models: add "costPerSecond" field
- For audio/transcription: add "costPerMinute" if applicable
- Include cache pricing: cachedInputPerMTok, or cacheWrite5minPerMTok/cacheWrite1hPerMTok/cacheReadPerMTok for Anthropic
- Include batch pricing if available
- Set null for fields not found
- Do NOT hallucinate or guess prices — only extract what is explicitly stated`;

  // Provider-specific additions
  if (provider === 'openai') {
    return base + `\n- For context tiers like "(<272K context length)", use base price only, add contextTiers array
- Group image generation variants under ONE model (not separate entries per quality/size)
- For fine-tuning models, include trainingCostPerHour if shown`;
  }
  if (provider === 'anthropic') {
    return base + `\n- Include all cache tiers: cacheWrite5minPerMTok, cacheWrite1hPerMTok, cacheReadPerMTok
- Include batch pricing and fast mode pricing if available`;
  }
  return base;
}

// ─── Convert LLM output to ModelPricing[] ───────────────────────────────────

function toModelPricing(provider: string, raw: Record<string, unknown>): ModelPricing {
  const r = raw as Record<string, any>;
  const entry: ModelPricing = {
    displayName: r.modelId || r.displayName || 'unknown',
    modelType: r.modelType || 'chatCompletion',
    pricingUnit: 'per-token',
    sourceUrl: PRICING_URLS[provider] || '',
    extractionMethod: 'llm',
  };

  // Token pricing (convert $/MTok → $/token)
  if (r.inputPerMTok != null) entry.inputCostPerToken = r.inputPerMTok / 1_000_000;
  if (r.outputPerMTok != null) entry.outputCostPerToken = r.outputPerMTok / 1_000_000;

  // Caching
  const caching: Record<string, number> = {};
  if (r.cachedInputPerMTok != null) caching['read'] = r.cachedInputPerMTok / 1_000_000;
  if (r.cacheReadPerMTok != null) caching['read'] = r.cacheReadPerMTok / 1_000_000;
  if (r.cacheWrite5minPerMTok != null) caching['write-5min'] = r.cacheWrite5minPerMTok / 1_000_000;
  if (r.cacheWrite1hPerMTok != null) caching['write-1h'] = r.cacheWrite1hPerMTok / 1_000_000;
  if (Object.keys(caching).length > 0) entry.caching = caching;

  // Batch
  if (r.batchInputPerMTok != null && r.batchOutputPerMTok != null) {
    entry.batchPricing = {
      inputCostPerToken: r.batchInputPerMTok / 1_000_000,
      outputCostPerToken: r.batchOutputPerMTok / 1_000_000,
    };
  }

  // Image
  if (r.costPerImage != null) {
    entry.pricingUnit = 'per-image';
    entry.costPerImage = r.costPerImage;
  }

  // Video
  if (r.costPerSecond != null) {
    entry.pricingUnit = 'per-second';
    entry.costPerSecond = r.costPerSecond;
  }

  // Audio
  if (r.costPerMinute != null) entry.costPerMinute = r.costPerMinute;

  // Fine-tuning
  if (r.trainingCostPerHour != null) entry.trainingCostPerHour = r.trainingCostPerHour;
  if (r.trainingPerMTok != null) entry.trainingCostPerToken = r.trainingPerMTok / 1_000_000;

  return entry;
}

// ─── Scrape a single provider via LLM ───────────────────────────────────────

export async function scrapeLlm(provider: string): Promise<ModelPricing[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(`ANTHROPIC_API_KEY required for --llm-only mode`);
  }

  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  const url = LLM_FETCH_URLS[provider] || PRICING_URLS[provider];
  if (!url) {
    console.error(`  [llm-only] No URL for ${provider}, skipping`);
    return [];
  }

  // Fetch page (with Python fallback for xAI TLS issues)
  console.error(`  [llm-only] Fetching ${provider}: ${url}`);
  let html: string;
  try {
    html = await httpFetch(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [llm-only] Node fetch failed: ${msg}, trying Python fallback...`);
    try {
      const { stdout } = await execFileAsync('python3', [
        '-c',
        `import urllib.request; req = urllib.request.Request("${url}", headers={"User-Agent": "Mozilla/5.0 (compatible; ModelPricingData/1.0)"}); print(urllib.request.urlopen(req, timeout=30).read().decode())`,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 60000 });
      html = stdout;
    } catch {
      throw new Error(`Both Node and Python fetch failed for ${provider}`);
    }
  }

  // Prepare content
  let content: string;
  if (provider === 'openai') {
    content = prepareOpenAIContent(html);
  } else {
    content = cleanHtmlToText(html).slice(0, 40000);
  }
  console.error(`  [llm-only] Content: ${content.length} chars`);

  // Call LLM — try with thinking disabled first, retry without if model requires it
  console.error(`  [llm-only] Calling ${model}...`);
  const startTime = Date.now();

  const baseBody = {
    model,
    max_tokens: 16384,
    system: buildPrompt(provider),
    messages: [{ role: 'user', content }],
  };
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const opts = { timeoutMs: 180000 };

  let resp: AnthropicResponse;
  try {
    resp = await postJson<AnthropicResponse>(
      `${baseUrl}/v1/messages`,
      { ...baseBody, thinking: { type: 'disabled' } },
      headers,
      opts,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('400') && msg.includes('thinking')) {
      // Model requires thinking enabled — retry without thinking param
      console.error(`  [llm-only] Model requires thinking, retrying...`);
      resp = await postJson<AnthropicResponse>(
        `${baseUrl}/v1/messages`,
        baseBody,
        headers,
        opts,
      );
    } else {
      throw err;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const text = resp.content?.find(c => c.type === 'text')?.text || '';

  if (!text) {
    console.error(`  [llm-only] Empty response for ${provider} (${elapsed}s)`);
    return [];
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error(`  [llm-only] No JSON in response for ${provider} (${elapsed}s)`);
    return [];
  }

  const data = JSON.parse(jsonMatch[0]);
  const models = (data.models || []) as Record<string, unknown>[];
  const results = models.map(m => toModelPricing(provider, m));

  console.error(`  [llm-only] ${provider}: ${results.length} models (${elapsed}s)`);
  return results;
}
