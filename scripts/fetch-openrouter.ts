#!/usr/bin/env npx tsx
/**
 * Fetch OpenRouter model pricing via their public API.
 *
 * Usage:
 *   npx tsx scripts/fetch-openrouter.ts --json
 *   npx tsx scripts/fetch-openrouter.ts --pretty
 *
 * Returns ModelPricing[] via stdout (JSON).
 *
 * The OpenRouter API (https://openrouter.ai/api/v1/models) requires no auth
 * and returns all available models with per-token pricing.
 */

import type { ModelPricing } from './lib/schema.js';
import { httpFetch } from './lib/http.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';

interface OpenRouterModel {
  id: string;
  name?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
  };
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

/**
 * Fetch all models from the OpenRouter API and convert to ModelPricing[].
 *
 * - provider is always "openrouter"
 * - modelId is the full `id` field (e.g. "anthropic/claude-opus-4-6")
 * - pricing.prompt → inputCostPerToken (parsed as float, already per-token)
 * - pricing.completion → outputCostPerToken
 *
 * Each entry's `displayName` is set to the full OpenRouter model ID
 * (e.g. "anthropic/claude-opus-4-6"), which the merge engine uses as
 * the key under `providers.openrouter`.
 */
export async function fetchOpenRouter(): Promise<ModelPricing[]> {
  console.error('Fetching OpenRouter pricing...');
  const results: ModelPricing[] = [];

  const body = await httpFetch(OPENROUTER_API_URL, { timeoutMs: 30_000 });
  const response: OpenRouterResponse = JSON.parse(body);
  const models = response.data || [];

  for (const model of models) {
    if (!model.id || !model.pricing) continue;

    const prompt = model.pricing.prompt;
    const completion = model.pricing.completion;

    // Skip models without token pricing
    if (prompt === undefined || completion === undefined) continue;

    const inputCost = parseFloat(prompt);
    const outputCost = parseFloat(completion);

    // Skip models where both costs are invalid
    if (isNaN(inputCost) && isNaN(outputCost)) continue;

    const entry: ModelPricing = {
      displayName: model.id,
      pricingUnit: 'per-token',
      sourceUrl: OPENROUTER_API_URL,
      extractionMethod: 'api',
    };

    if (!isNaN(inputCost)) entry.inputCostPerToken = inputCost;
    if (!isNaN(outputCost)) entry.outputCostPerToken = outputCost;

    results.push(entry);
  }

  console.error(`  OpenRouter: ${results.length} models fetched`);
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  (process.argv[1].endsWith('fetch-openrouter.ts') || process.argv[1].endsWith('fetch-openrouter.js'))
) {
  const pretty = process.argv.includes('--pretty');

  fetchOpenRouter()
    .then((results) => {
      const json = pretty ? JSON.stringify(results, null, 2) : JSON.stringify(results);
      process.stdout.write(json + '\n');
    })
    .catch((err: Error) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
