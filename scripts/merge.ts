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

import fs from 'node:fs';
import path from 'node:path';
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
 * Two-pass strategy:
 *  Pass 1: Collect best entry per (baseKey, type) pair, track which models have multiple types
 *  Pass 2: Write to map — base key gets highest-priority type,
 *          only models with 2+ types get "key::type" qualified keys
 */
function mergeIntoProviderMap(
  map: Record<string, ModelPricing>,
  entries: ModelPricing[],
): void {
  // Pass 1: Collect best entry per (baseKey, type), preserving section priority
  const byKeyType = new Map<string, ModelPricing>(); // "baseKey::type" → best entry
  const typesByKey = new Map<string, Set<string>>();  // baseKey → set of types

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const baseKey = deriveModelKey(entry, i);
    const type = entry.modelType ?? 'chatCompletion';

    // Track types per model
    if (!typesByKey.has(baseKey)) typesByKey.set(baseKey, new Set());
    typesByKey.get(baseKey)!.add(type);

    // Keep best entry per (baseKey, type) — prefer higher section priority
    const compositeKey = `${baseKey}::${type}`;
    const existing = byKeyType.get(compositeKey);
    if (!existing || (entry._sectionPriority ?? 99) < (existing._sectionPriority ?? 99)) {
      byKeyType.set(compositeKey, entry);
    }
  }

  // Pass 2: Write to output map
  for (const [baseKey, types] of typesByKey.entries()) {
    const isMultiType = types.size > 1;

    // Find best type for base key (highest type priority = lowest number)
    let bestType: string | undefined;
    let bestPriority = 999;
    for (const type of types) {
      const p = typePriority(type as ModelType);
      if (p < bestPriority) {
        bestPriority = p;
        bestType = type;
      }
    }

    for (const type of types) {
      const compositeKey = `${baseKey}::${type}`;
      const entry = byKeyType.get(compositeKey)!;

      if (type === bestType) {
        // This type wins the base key
        map[baseKey] = entry;
      }

      // Only add ::type qualified key when model has multiple types
      if (isMultiType) {
        map[`${baseKey}::${type}`] = entry;
      }
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

  // Read previous version from existing pricing.json
  const prev = loadPreviousMeta();
  const newVersion = bumpVersion(prev, providers);

  const meta: PricingMeta = {
    generatedAt: newVersion !== prev?.version ? new Date().toISOString() : (prev?.generatedAt ?? new Date().toISOString()),
    version: newVersion,
    sources,
    totalModels,
    failedProviders,
  };

  return { _meta: meta, providers };
}

// ─── Version Management ─────────────────────────────────────────────────────

function loadPreviousMeta(): PricingMeta | null {
  try {
    const filePath = path.resolve(import.meta.dirname!, '..', 'data', 'pricing.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const prev = JSON.parse(raw) as PricingData;
    return prev._meta;
  } catch {
    return null;
  }
}

/**
 * Compare new providers data with previous pricing.json to detect changes.
 * Returns true if any model was added, removed, or had price changes.
 */
function hasDataChanged(
  prev: PricingMeta | null,
  newProviders: Record<string, Record<string, ModelPricing>>,
): boolean {
  if (!prev) return true;

  try {
    const filePath = path.resolve(import.meta.dirname!, '..', 'data', 'pricing.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const prevData = JSON.parse(raw) as PricingData;

    // Quick check: different provider count or total model count
    const prevProviderKeys = Object.keys(prevData.providers);
    const newProviderKeys = Object.keys(newProviders);
    if (prevProviderKeys.length !== newProviderKeys.length) return true;

    for (const provider of newProviderKeys) {
      const prevModels = prevData.providers[provider];
      const newModels = newProviders[provider];
      if (!prevModels) return true;

      const prevKeys = Object.keys(prevModels).filter(k => !k.includes('::'));
      const newKeys = Object.keys(newModels).filter(k => !k.includes('::'));
      if (prevKeys.length !== newKeys.length) return true;

      // Check each base model for price changes
      for (const key of newKeys) {
        const prevModel = prevModels[key];
        const newModel = newModels[key];
        if (!prevModel) return true;
        if (prevModel.inputCostPerToken !== newModel.inputCostPerToken) return true;
        if (prevModel.outputCostPerToken !== newModel.outputCostPerToken) return true;
      }
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Bump patch version if data changed, keep current version if unchanged.
 */
function bumpVersion(
  prev: PricingMeta | null,
  newProviders: Record<string, Record<string, ModelPricing>>,
): string {
  const baseVersion = prev?.version ?? '2.0.0';

  if (!hasDataChanged(prev, newProviders)) {
    return baseVersion;
  }

  // Bump patch: 2.0.0 → 2.0.1, 2.0.5 → 2.0.6
  const parts = baseVersion.split('.').map(Number);
  if (parts.length === 3) {
    parts[2]++;
    return parts.join('.');
  }
  return baseVersion;
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
