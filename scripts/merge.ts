/**
 * Merge Engine
 *
 * Combines pricing data from all 6 sources (OpenAI, Anthropic, Google, xAI,
 * DeepSeek, OpenRouter) into the final PricingData structure.
 *
 * Key decisions:
 * - Official data (OpenAI/Anthropic/Google/xAI/DeepSeek) always wins over OpenRouter
 * - Within each provider, models are keyed by displayName (normalized)
 * - If same modelId has multiple types, non-default types use "modelId::type" key
 * - Default type priority: chatCompletion > lexicon > embedding > others
 */

import type {
  ModelPricing,
  ModelType,
  PricingData,
  PricingMeta,
  ProviderSource,
} from './lib/schema.js';
import { normalizeModelName } from './lib/pricing-core.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MergeInput {
  provider: string;
  entries: ModelPricing[];
  source: ProviderSource;
}

// ─── Type Priority ───────────────────────────────────────────────────────────

const TYPE_PRIORITY: Record<string, number> = {
  chatCompletion: 0,
  lexicon: 1,
  embedding: 2,
  imageGeneration: 3,
  video: 4,
  audio: 5,
  transcription: 6,
  tool: 7,
  fineTuning: 8,
};

function typePriority(t: ModelType | undefined): number {
  if (!t) return TYPE_PRIORITY.chatCompletion; // default to highest priority
  return TYPE_PRIORITY[t] ?? 99;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a model key from a ModelPricing entry.
 * Uses `displayName` (what all scrapers set), normalized to lowercase with
 * hyphens for spaces. Falls back to a positional key if displayName is missing.
 */
function deriveModelKey(entry: ModelPricing, index: number): string {
  if (entry.displayName) {
    return normalizeModelName(entry.displayName);
  }
  return `unknown-model-${index}`;
}

/**
 * Merge entries into a provider's model map, handling type-qualified keys.
 *
 * For each entry:
 * 1. Derive the base key from displayName
 * 2. If the base key already exists and has a different type:
 *    - Higher-priority type takes the base key
 *    - Lower-priority type gets "key::type" qualified key
 * 3. Always store under the type-qualified key too (if modelType is set)
 */
function mergeIntoProviderMap(
  map: Record<string, ModelPricing>,
  entries: ModelPricing[],
): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const baseKey = deriveModelKey(entry, i);

    // Always store under type-qualified key when type is known
    if (entry.modelType) {
      const qualifiedKey = `${baseKey}::${entry.modelType}`;
      map[qualifiedKey] = entry;
    }

    // For the base key, prefer higher-priority types
    const existing = map[baseKey];
    if (!existing) {
      map[baseKey] = entry;
    } else if (typePriority(entry.modelType) < typePriority(existing.modelType)) {
      // New entry has higher priority — it takes the base key,
      // demote existing to qualified key if it has a type
      if (existing.modelType) {
        const demotedKey = `${baseKey}::${existing.modelType}`;
        if (!map[demotedKey]) {
          map[demotedKey] = existing;
        }
      }
      map[baseKey] = entry;
    }
  }
}

// ─── Official Providers ──────────────────────────────────────────────────────
// Official data always wins over OpenRouter for the same model

const OFFICIAL_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'xai', 'deepseek']);

// ─── Main Merge Function ─────────────────────────────────────────────────────

/**
 * Merge all data sources into a single PricingData structure.
 *
 * Logic:
 * 1. Group entries by provider (from MergeInput.provider)
 * 2. OpenRouter entries go under providers.openrouter
 * 3. Within each provider, key by model ID derived from displayName
 * 4. Build _meta with source stats, totalModels count, failedProviders
 * 5. Official scrapers always win over OpenRouter for same model
 */
export function mergeAll(
  inputs: MergeInput[],
  failedProviders: string[] = [],
): PricingData {
  const providers: Record<string, Record<string, ModelPricing>> = {};
  const sources: Record<string, ProviderSource> = {};

  // Phase 1: Process official providers first
  for (const input of inputs) {
    if (!OFFICIAL_PROVIDERS.has(input.provider)) continue;
    processInput(providers, sources, input);
  }

  // Phase 2: Process non-official providers (e.g. OpenRouter)
  // These never overwrite official data
  for (const input of inputs) {
    if (OFFICIAL_PROVIDERS.has(input.provider)) continue;
    processInput(providers, sources, input);
  }

  // Count total models (base keys only, excluding type-qualified ::keys)
  let totalModels = 0;
  for (const providerModels of Object.values(providers)) {
    for (const key of Object.keys(providerModels)) {
      if (!key.includes('::')) totalModels++;
    }
  }

  const meta: PricingMeta = {
    generatedAt: new Date().toISOString(),
    version: '2.0.0',
    sources,
    totalModels,
    failedProviders,
  };

  return { _meta: meta, providers };
}

function processInput(
  providers: Record<string, Record<string, ModelPricing>>,
  sources: Record<string, ProviderSource>,
  input: MergeInput,
): void {
  const { provider, entries, source } = input;

  if (!providers[provider]) {
    providers[provider] = {};
  }

  mergeIntoProviderMap(providers[provider], entries);

  // Update source metadata
  sources[provider] = {
    ...source,
    modelCount: Object.keys(providers[provider]).filter((k) => !k.includes('::')).length,
  };
}
