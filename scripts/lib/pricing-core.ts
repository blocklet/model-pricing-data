/**
 * Shared Pricing Core — pure computation functions and constants used by scrapers.
 *
 * Migrated from aigne-hub/.claude/skills/model-pricing-analyzer/scripts/core/pricing-core.mjs
 */

// ─── Provider Aliases & Normalization ─────────────────────────────────────────

export const PROVIDER_ALIASES: Record<string, string> = {
  gemini: 'google',
  vertex_ai: 'google',
  vertex_ai_beta: 'google',
  google: 'google',
  anthropic: 'anthropic',
  openai: 'openai',
  'text-completion-openai': 'openai',
  chatgpt: 'openai',
  deepseek: 'deepseek',
  xai: 'xai',
  'x-ai': 'xai',
  openrouter: 'openrouter',
  volcengine: 'doubao',
};

export const PRICING_URLS: Record<string, string> = {
  anthropic: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
  xai: 'https://docs.x.ai/developers/models',
  openai: 'https://platform.openai.com/docs/pricing',
  doubao: 'https://www.volcengine.com/docs/82379/1544106',
  openrouter: 'https://openrouter.ai/models',
  bedrock: 'https://aws.amazon.com/bedrock/pricing/',
  ideogram: 'https://ideogram.ai/pricing',
  poe: 'https://poe.com/api/models',
};

export const PROV_NAMES: Record<string, string> = {
  google: 'Google',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  doubao: 'Doubao',
  ideogram: 'Ideogram',
  minimax: 'MiniMax',
  bedrock: 'Bedrock',
  poe: 'Poe',
};

export const MODEL_PREFIX_TO_PROVIDER: Record<string, string> = {
  'claude-': 'anthropic',
  'gpt-': 'openai',
  'o1-': 'openai',
  'o3-': 'openai',
  'o4-': 'openai',
  'gemini-': 'google',
  'grok-': 'xai',
  'deepseek-': 'deepseek',
};

export const MODEL_NAME_OVERRIDES: Record<string, string> = {
  'gemini-flash-2.5': 'gemini-2.5-flash',
  'gpt-3.5-turbo-instruct': 'gpt-3.5-turbo-instruct',
};

// ─── Math & Formatting Utilities ──────────────────────────────────────────────

/**
 * Convert a $/MTok value to $/token, eliminating IEEE 754 floating-point noise.
 * Uses `.toPrecision(10)` to eliminate noise from division.
 */
export function toPerToken(perMTok: number): number {
  return Number((perMTok / 1e6).toPrecision(10));
}

/**
 * Normalize a model name to a canonical key.
 *
 * General: lowercase + trim + whitespace → hyphen
 *
 * Claude-specific rules:
 *   - Dots → hyphens  (e.g. "claude-opus-4.6" → "claude-opus-4-6")
 *   - Bare integer suffix → append "-0" (e.g. "claude-opus-4" → "claude-opus-4-0")
 */
export function normalizeModelName(name: string): string {
  let key = name.toLowerCase().trim().replace(/\s+/g, '-');
  if (key.startsWith('claude')) {
    key = key.replace(/\./g, '-');
    // Append -0 when trailing segment is a bare integer (no minor version)
    if (/^.*-\d+$/.test(key) && !/^.*-\d+-\d+$/.test(key)) {
      key += '-0';
    }
  }
  return key;
}

/**
 * Normalize a provider name to the canonical DB provider name.
 */
export function normalizeProvider(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (PROVIDER_ALIASES[lower]) return PROVIDER_ALIASES[lower];
  for (const [alias, canonical] of Object.entries(PROVIDER_ALIASES)) {
    if (lower.startsWith(alias)) return canonical;
  }
  if (lower.startsWith('bedrock')) return 'bedrock';
  return undefined;
}

/**
 * Strip HTML tags and entities from a string, producing clean plaintext.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?[\w]+;/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Strip HTML with script/style removal first (clean text, no JS noise).
 */
export function stripHtmlClean(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?[\w]+;/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Find earliest index from candidates that is > start, or fallback.
 */
export function findSectionEnd(
  text: string,
  start: number,
  candidates: string[],
  fallbackLen = 3000,
): number {
  let best = -1;
  for (const c of candidates) {
    const idx = text.indexOf(c, start + 20);
    if (idx > start && (best === -1 || idx < best)) best = idx;
  }
  return best > start ? best : start + fallbackLen;
}

/**
 * Get provider display name.
 */
export function provName(p: string): string {
  return PROV_NAMES[p.toLowerCase()] || p.charAt(0).toUpperCase() + p.slice(1);
}
