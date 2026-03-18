/**
 * Convert PricingData to LiteLLM-compatible format.
 *
 * Keys: modelId for official providers, provider/modelId for openrouter.
 * Skips type-qualified entries (keys containing "::").
 */

import type { PricingData, LiteLLMPricingData, LiteLLMEntry } from '../lib/schema.js';

export function toLiteLLMFormat(data: PricingData): LiteLLMPricingData {
  const result: LiteLLMPricingData = {};

  for (const [provider, models] of Object.entries(data.providers)) {
    for (const [modelId, pricing] of Object.entries(models)) {
      // Skip type-qualified duplicates
      if (modelId.includes('::')) continue;

      // For openrouter, modelId already has provider prefix (e.g. "anthropic/claude-opus-4")
      // For official providers, use just the modelId
      const key = provider === 'openrouter' ? `${provider}/${modelId}` : modelId;

      const entry: LiteLLMEntry = {
        litellm_provider: provider,
        source: 'official',
      };

      if (pricing.inputCostPerToken != null) {
        entry.input_cost_per_token = pricing.inputCostPerToken;
      }
      if (pricing.outputCostPerToken != null) {
        entry.output_cost_per_token = pricing.outputCostPerToken;
      }

      // Caching: prefer write-5min, fall back to write
      if (pricing.caching) {
        const writecost = pricing.caching['write-5min'] ?? pricing.caching['write'];
        if (writecost != null) {
          entry.cache_creation_input_token_cost = writecost;
        }
        if (pricing.caching.read != null) {
          entry.cache_read_input_token_cost = pricing.caching.read;
        }
      }

      // Batch pricing
      if (pricing.batchPricing) {
        entry.batch_input_cost_per_token = pricing.batchPricing.inputCostPerToken;
        entry.batch_output_cost_per_token = pricing.batchPricing.outputCostPerToken;
      }

      if (pricing.modelType) {
        entry.model_type = pricing.modelType;
      }
      if (pricing.sourceUrl) {
        entry.source_url = pricing.sourceUrl;
      }

      result[key] = entry;
    }
  }

  return result;
}
