/**
 * LLM fallback module for pricing extraction.
 *
 * Pattern:
 *  1. Try regex extraction first
 *  2. If isSuspicious(result) → call LLM to extract from HTML
 *  3. Cache LLM responses to disk with configurable TTL
 *
 * Supports:
 *  - Anthropic API (claude-haiku-4-5) via ANTHROPIC_API_KEY
 *  - OpenAI API (gpt-4o-mini) via OPENAI_API_KEY
 *
 * Custom endpoints:
 *  - ANTHROPIC_BASE_URL: override Anthropic API base (e.g. DashScope proxy)
 *  - ANTHROPIC_MODEL: override model name (e.g. qwen3.5-plus)
 *  - OPENAI_BASE_URL: override OpenAI API base
 *  - OPENAI_MODEL: override model name
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { postJson } from './http.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LlmFallbackOptions {
  /** Provider name, used for the cache file key (e.g. "openai", "anthropic") */
  provider: string;
  /** The system/user prompt to send to the LLM */
  prompt: string;
  /** The raw HTML content to analyze */
  htmlContent: string;
  /** Directory for cache files (default: 'data/.cache') */
  cacheDir?: string;
  /** Cache TTL in milliseconds (default: 3600000 = 1h) */
  cacheTtlMs?: number;
}

export interface LlmResult {
  /** The LLM response content */
  content: string;
  /** Whether the result came from cache */
  cached: boolean;
  /** Which model was used (or 'cache' if cached) */
  model: string;
}

interface CacheEntry {
  ts: number;
  model: string;
  data: string;
}

interface CacheFile {
  [key: string]: CacheEntry;
}

// Anthropic Messages API response shape
interface AnthropicResponse {
  content?: Array<{ text?: string }>;
}

// OpenAI Chat Completions API response shape
interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// ─── Suspicious detection ────────────────────────────────────────────────────

/**
 * Check whether extraction results look suspicious (incomplete).
 *
 * @param entries - Array of extracted entries to validate
 * @param minEntries - Minimum expected number of entries
 * @param requiredKeys - Keys that must be present in at least one entry
 * @returns true if the result is suspicious and LLM fallback should be tried
 */
export function isSuspicious(
  entries: Record<string, unknown>[] | Record<string, unknown>,
  minEntries: number,
  requiredKeys: string[],
): boolean {
  // Support both array and object forms
  const keys = Array.isArray(entries)
    ? entries.map((_, i) => String(i))
    : Object.keys(entries ?? {});

  if (keys.length === 0) return true;
  if (keys.length < minEntries) return true;

  // For object form, check that required keys exist
  if (!Array.isArray(entries)) {
    for (const k of requiredKeys) {
      if (!keys.includes(k)) return true;
    }
  }

  return false;
}

// ─── API key detection ───────────────────────────────────────────────────────

/**
 * Check which LLM APIs are available based on environment variables.
 */
export function isLlmAvailable(): { openai: boolean; anthropic: boolean } {
  return {
    openai: Boolean(process.env.OPENAI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

// ─── Cache helpers ───────────────────────────────────────────────────────────

function getCachePath(cacheDir: string, provider: string): string {
  return path.join(cacheDir, `llm-${provider}.json`);
}

function loadCache(cachePath: string): CacheFile {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(raw) as CacheFile;
  } catch {
    return {};
  }
}

function saveCache(cachePath: string, cache: CacheFile): void {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

// ─── LLM call ────────────────────────────────────────────────────────────────

/**
 * Call an LLM to extract pricing data, with file-based caching.
 *
 * Checks ANTHROPIC_API_KEY first (uses claude-haiku-4-5), then
 * OPENAI_API_KEY (uses gpt-4o-mini). Returns null if no API key
 * is available or the call fails.
 */
export async function callLlmFallback(
  options: LlmFallbackOptions,
): Promise<LlmResult | null> {
  const {
    provider,
    prompt,
    htmlContent,
    cacheDir = 'data/.cache',
    cacheTtlMs = 3_600_000,
  } = options;

  const { anthropic: hasAnthropic, openai: hasOpenai } = isLlmAvailable();
  if (!hasAnthropic && !hasOpenai) {
    console.error(
      '  [llm] No API key available (ANTHROPIC_API_KEY or OPENAI_API_KEY), skipping',
    );
    return null;
  }

  if (!htmlContent || htmlContent.length < 20) {
    console.error(
      `  [llm] Content too short for ${provider} (${htmlContent?.length ?? 0} chars), skipping`,
    );
    return null;
  }

  // ── Check cache ──
  const hash = createHash('sha256')
    .update(htmlContent)
    .digest('hex')
    .slice(0, 16);
  const cacheKey = `${provider}:${hash}`;
  const cachePath = getCachePath(cacheDir, provider);
  const cache = loadCache(cachePath);

  if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < cacheTtlMs) {
    console.error(`  [llm] Cache hit for ${provider}`);
    return {
      content: cache[cacheKey].data,
      cached: true,
      model: cache[cacheKey].model,
    };
  }

  // ── Call LLM ──
  try {
    let content: string;
    let model: string;

    if (hasAnthropic) {
      const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
      model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
      console.error(
        `  [llm] Calling ${model} for ${provider} (${htmlContent.length} chars)...`,
      );
      if (baseUrl !== 'https://api.anthropic.com') {
        console.error(`  [llm] Using custom base URL: ${baseUrl}`);
      }

      const baseBody = {
        model,
        max_tokens: 4096,
        system: prompt,
        messages: [{ role: 'user', content: htmlContent }],
      };
      const headers = {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      };

      let resp: AnthropicResponse;
      try {
        resp = await postJson<AnthropicResponse>(
          `${baseUrl}/v1/messages`,
          { ...baseBody, thinking: { type: 'disabled' } },
          headers,
          { timeoutMs: 120000 },
        );
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (retryMsg.includes('400') && retryMsg.includes('thinking')) {
          resp = await postJson<AnthropicResponse>(
            `${baseUrl}/v1/messages`,
            baseBody,
            headers,
            { timeoutMs: 120000 },
          );
        } else {
          throw retryErr;
        }
      }

      const text = resp.content?.[0]?.text;
      if (!text) {
        console.error(`  [llm] Empty response from ${model}`);
        return null;
      }

      // Claude may wrap JSON in a markdown code block
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      content = jsonMatch ? jsonMatch[0] : text;
    } else {
      const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
      model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      console.error(
        `  [llm] Calling ${model} for ${provider} (${htmlContent.length} chars)...`,
      );
      if (baseUrl !== 'https://api.openai.com') {
        console.error(`  [llm] Using custom base URL: ${baseUrl}`);
      }

      const resp = await postJson<OpenAiResponse>(
        `${baseUrl}/v1/chat/completions`,
        {
          model,
          temperature: 0,
          max_tokens: 4096,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: htmlContent },
          ],
        },
        { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}` },
      );

      const text = resp.choices?.[0]?.message?.content;
      if (!text) {
        console.error(`  [llm] Empty response from ${model}`);
        return null;
      }
      content = text;
    }

    // ── Save to cache ──
    cache[cacheKey] = { ts: Date.now(), model, data: content };
    saveCache(cachePath, cache);

    console.error(
      `  [llm] Got response for ${provider} (${content.length} chars)`,
    );
    return { content, cached: false, model };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [llm] Error for ${provider}: ${message}`);
    return null;
  }
}
