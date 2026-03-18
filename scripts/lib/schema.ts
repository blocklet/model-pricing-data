// Caching key enum - replaces free-text labels
export type CachingKey = 'write-5min' | 'write-1h' | 'write' | 'read';

export type PricingUnit = 'per-token' | 'per-image' | 'per-second' | 'per-minute';
export type ModelType =
  | 'chatCompletion' | 'lexicon' | 'embedding' | 'imageGeneration'
  | 'video' | 'audio' | 'transcription' | 'fineTuning' | 'tool';

// Context-length tiered pricing
export interface ContextTier {
  threshold: string; // ">200K", ">272K"
  inputCostPerToken?: number;
  cachedInputCostPerToken?: number;
  outputCostPerToken?: number;
}

// Batch pricing
export interface BatchPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  discountNote?: string;
}

// Special mode pricing
export interface SpecialModePricing {
  mode: string; // "fast-mode", "data-residency-us"
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  multiplierNote?: string;
}

// Image variant
export interface ImageVariant {
  quality: string;
  size: string;
  costPerImage: number;
}

// Video variant
export interface VideoVariant {
  resolution: string;
  costPerSecond: number;
}

// Core model pricing entry (used as value in providers map)
export interface ModelPricing {
  displayName?: string;
  modelType?: ModelType;
  pricingUnit: PricingUnit;

  // Token pricing ($/token)
  inputCostPerToken?: number;
  outputCostPerToken?: number;

  // Caching with enum keys
  caching?: Partial<Record<CachingKey, number>>;

  // Context tiers
  contextTiers?: ContextTier[];

  // Batch
  batchPricing?: BatchPricing;

  // Special modes
  specialModes?: SpecialModePricing[];

  // Image
  costPerImage?: number;
  imageVariants?: ImageVariant[];

  // Video
  costPerSecond?: number;
  videoVariants?: VideoVariant[];

  // Audio
  costPerMinute?: number;
  costPerMillionChars?: number;

  // Fine-tuning
  trainingCostPerToken?: number;
  trainingCostPerHour?: number;

  // Metadata
  sourceUrl: string;
  extractionMethod?: string; // "regex" | "llm"
  deprecated?: boolean;

  /**
   * Section priority for deduplication when same model appears in multiple sections.
   * Lower = higher priority: text(0) > image(1) > audio(2) > legacy(5) > fineTuning(6).
   * Not serialized to JSON — stripped during output.
   */
  _sectionPriority?: number;
}

// Provider source metadata
export interface ProviderSource {
  url: string;
  modelCount: number;
  method: string; // "regex" | "llm" | "api"
  fetchedAt?: string;
}

// Top-level metadata
export interface PricingMeta {
  generatedAt: string;
  version: string;
  sources: Record<string, ProviderSource>;
  totalModels: number;
  failedProviders: string[];
}

// Main output format - providers grouped
export interface PricingData {
  _meta: PricingMeta;
  providers: Record<string, Record<string, ModelPricing>>;
}

// LiteLLM compat entry
export interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  batch_input_cost_per_token?: number;
  batch_output_cost_per_token?: number;
  litellm_provider: string;
  model_type?: string;
  source_url?: string;
  source: string;
}

// LiteLLM compat format
export type LiteLLMPricingData = Record<string, LiteLLMEntry>;
