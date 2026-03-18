#!/usr/bin/env npx tsx
/**
 * Scrape OpenAI official pricing (Standard tier only) from developers.openai.com
 *
 * Usage:
 *   npx tsx scripts/scrape-openai.ts --json
 *   npx tsx scripts/scrape-openai.ts --json --no-llm
 *
 * Returns ModelPricing[] via stdout (JSON).
 *
 * Migrated from aigne-hub scrape-openai-pricing.mjs
 */

import type { ModelPricing, ModelType, CachingKey, ContextTier } from './lib/schema.js';
import { httpFetch } from './lib/http.js';
import { callLlmFallback, isSuspicious } from './lib/llm-fallback.js';
import { toPerToken, stripHtml, stripHtmlClean, findSectionEnd } from './lib/pricing-core.js';

const PAGE_URL = 'https://developers.openai.com/api/docs/pricing?latest-pricing=standard';
const SOURCE_URL = 'https://developers.openai.com/api/docs/pricing';

// ──────────────────────────────────────────────────────────────────────────────
// Section expectations for suspicious detection
// ──────────────────────────────────────────────────────────────────────────────

const SECTION_EXPECTATIONS: Record<string, { minEntries: number; requiredKeys: string[] }> = {
  text: { minEntries: 30, requiredKeys: ['gpt-4.1', 'gpt-4o', 'o3'] },
  image: { minEntries: 2, requiredKeys: ['gpt-image-1.5'] },
  audio: { minEntries: 2, requiredKeys: [] },
  video: { minEntries: 1, requiredKeys: ['sora-2'] },
  transcription: { minEntries: 3, requiredKeys: ['whisper'] },
  fineTuning: { minEntries: 3, requiredKeys: [] },
  imageGeneration: { minEntries: 3, requiredKeys: ['gpt-image-1.5'] },
  embedding: { minEntries: 2, requiredKeys: ['text-embedding-3-small'] },
  builtInTools: { minEntries: 3, requiredKeys: ['web-search'] },
  legacy: { minEntries: 5, requiredKeys: ['gpt-4-0613'] },
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

// ──────────────────────────────────────────────────────────────────────────────
// Section anchors for LLM fallback text extraction
// ──────────────────────────────────────────────────────────────────────────────

const SECTION_ANCHORS: Record<string, { start: string; end: string[] }> = {
  text: { start: 'Text tokens Prices per 1M tokens', end: ['Image tokens'] },
  image: { start: 'Image tokens Prices per 1M tokens', end: ['Audio tokens'] },
  audio: { start: 'Audio tokens Prices per 1M tokens', end: ['Video Prices per second', 'Fine-tuning'] },
  video: { start: 'Video Prices per second', end: ['Fine-tuning'] },
  transcription: { start: 'Transcription and speech generation', end: ['Image generation', 'Embeddings'] },
  fineTuning: { start: 'Fine-tuning Prices per 1M tokens', end: ['Built-in tools'] },
  imageGeneration: { start: 'Image generation Prices per image', end: ['Embeddings Prices per 1M tokens'] },
  embedding: { start: 'Embeddings Prices per 1M tokens', end: ['Built-in tools', 'Legacy models'] },
  builtInTools: { start: 'Built-in tools', end: ['Transcription', 'Legacy models', 'Data residency'] },
  legacy: { start: 'Legacy models Prices per 1M tokens', end: ['Data residency', 'AgentKit'] },
};

const SECTION_PROMPTS: Record<string, { schema: string; example: string; instructions: string }> = {
  text: {
    schema: '{ "model-id": { "input": number, "cachedInput": number|null, "output": number } }',
    example:
      '{ "gpt-4.1": { "input": 2, "cachedInput": 0.5, "output": 8 }, "gpt-4o-mini": { "input": 0.15, "cachedInput": 0.075, "output": 0.6 } }',
    instructions:
      'Extract ALL text token models with input/cachedInput/output prices in $/MTok. If a model has context tiers (e.g. <272K / >272K), include only the base tier as the main entry. Omit "Batch" tier entries.',
  },
  image: {
    schema: '{ "model-id": { "input": number, "cachedInput": number|null, "output": number|null } }',
    example: '{ "gpt-image-1.5": { "input": 8, "cachedInput": 2, "output": 32 } }',
    instructions: 'Extract image token models. Prices are in $/MTok. Only "Standard" tier.',
  },
  audio: {
    schema: '{ "model-id": { "input": number, "cachedInput": number|null, "output": number|null } }',
    example: '{ "gpt-realtime": { "input": 32, "cachedInput": 2.4, "output": 160 } }',
    instructions: 'Extract audio token models. Prices are in $/MTok. Only "Standard" tier.',
  },
  video: {
    schema: '{ "model-id": { "perSecond": number, "resolution": "WxH / WxH" } }',
    example: '{ "sora-2": { "perSecond": 0.1, "resolution": "480x848 / 848x480" } }',
    instructions:
      'Extract video models with per-second pricing. Resolution format: "Portrait / Landscape". If multiple resolution tiers, use resolutionTiers object.',
  },
  transcription: {
    schema:
      '{ "model-id": { "text"?: { "input": number, "output"?: number }, "audio"?: { "input"?: number, "output"?: number }, "estimatedPerMinute"?: number, "perMinute"?: number, "perMillionChars"?: number } }',
    example:
      '{ "whisper": { "perMinute": 0.006 }, "tts": { "perMillionChars": 15 }, "gpt-4o-transcribe": { "text": { "input": 2.5, "output": 10 }, "estimatedPerMinute": 0.006 } }',
    instructions:
      'Extract transcription & speech models. Include text token sub-table, audio token sub-table, and "Other" section (Whisper per-minute, TTS per-million-chars). Models with both text and audio pricing should have both sub-objects.',
  },
  fineTuning: {
    schema:
      '{ "model-id": { "trainingPerMTok"?: number, "trainingPerHour"?: number, "input": number, "cachedInput"?: number, "output": number } }',
    example: '{ "gpt-4.1-2025-04-14": { "trainingPerMTok": 25, "input": 4, "cachedInput": 1, "output": 16 } }',
    instructions:
      'Extract fine-tuning models from "Standard" tier only. Some have training price per MTok, some per hour. Models with "with data sharing" suffix should use "-data-sharing" in the ID.',
  },
  imageGeneration: {
    schema: '{ "model-id": { "variants": [{ "quality": string, "size": string, "perImage": number }] } }',
    example: '{ "gpt-image-1.5": { "variants": [{ "quality": "low", "size": "1024x1024", "perImage": 0.009 }] } }',
    instructions:
      'Extract image generation per-image pricing. Each model has quality levels (low/medium/high or standard/hd) and sizes. Normalize model names: "GPT Image 1.5" -> "gpt-image-1.5", "DALL-E 3" -> "dall-e-3", etc.',
  },
  embedding: {
    schema: '{ "model-id": { "input": number } }',
    example: '{ "text-embedding-3-small": { "input": 0.02 }, "text-embedding-3-large": { "input": 0.13 } }',
    instructions: 'Extract embedding model prices in $/MTok.',
  },
  builtInTools: {
    schema: '{ "tool-id": { ...pricing fields } }',
    example:
      '{ "web-search": { "per1kCalls": 10, "note": "+ content tokens at model input rate" }, "file-search-storage": { "perGBPerDay": 0.1, "freeGB": 1 } }',
    instructions:
      'Extract built-in tool pricing. Tools include: code interpreter containers (per20min by GB tier), file search (storage per GB-day + per 1k calls), web search variants (per 1k calls). Use IDs like "container-1gb", "file-search-storage", "file-search-call", "web-search", "web-search-reasoning-preview", "web-search-non-reasoning-preview".',
  },
  legacy: {
    schema: '{ "model-id": { "input": number, "output": number } }',
    example: '{ "gpt-4-0613": { "input": 30, "output": 60 }, "gpt-3.5-turbo-0125": { "input": 0.5, "output": 1.5 } }',
    instructions: 'Extract legacy model prices from "Standard" tier. Prices in $/MTok. No cached input column.',
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Internal types for raw parsed data
// ──────────────────────────────────────────────────────────────────────────────

interface RawEntry {
  id: string;
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  contextNote: string | null;
}

interface TextModelData {
  input: number;
  cachedInput?: number | null;
  output?: number | null;
  contextTiers?: Record<string, { input: number; cachedInput?: number | null; output?: number | null }>;
}

interface VideoModelData {
  perSecond: number;
  resolution?: string;
  resolutionTiers?: Record<string, { perSecond: number }>;
}

interface TranscriptionModelData {
  text?: { input: number; output?: number };
  audio?: { input?: number; output?: number };
  estimatedPerMinute?: number;
  perMinute?: number;
  perMillionChars?: number;
}

interface FineTuningModelData {
  trainingPerMTok?: number;
  trainingPerHour?: number;
  input: number;
  cachedInput?: number | null;
  output: number;
}

interface ImageGenModelData {
  variants?: Array<{ quality: string; size: string; perImage: number }>;
  perImage?: number;
}

interface EmbeddingModelData {
  input: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// LLM section extraction helpers
// ──────────────────────────────────────────────────────────────────────────────

let _cleanText: string | null = null;

function extractSectionText(text: string, sectionName: string): string {
  const anchors = SECTION_ANCHORS[sectionName];
  if (!anchors) return '';
  const source = _cleanText || text;
  const startIdx = source.indexOf(anchors.start);
  if (startIdx === -1) {
    const fallbackIdx = text.indexOf(anchors.start);
    if (fallbackIdx === -1) return '';
    const endIdx = findSectionEnd(text, fallbackIdx, anchors.end, 5000);
    return text.substring(fallbackIdx, endIdx);
  }
  const endIdx = findSectionEnd(source, startIdx, anchors.end, 5000);
  return source.substring(startIdx, endIdx);
}

async function tryLlmFallback(
  sectionName: string,
  regexResult: Record<string, unknown>,
  text: string,
  extractionMethod: Record<string, string>,
  noLLM: boolean,
): Promise<Record<string, unknown>> {
  extractionMethod[sectionName] = 'regex';
  if (isSectionSuspicious(sectionName, regexResult) && !noLLM) {
    console.error(
      `  ${sectionName} section suspicious (${Object.keys(regexResult ?? {}).length} entries), trying LLM fallback...`,
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
        provider: `openai-${sectionName}`,
        prompt: systemPrompt,
        htmlContent: sectionText,
      });
      if (llmResult) {
        try {
          const parsed = JSON.parse(llmResult.content) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            if (!isSectionSuspicious(sectionName, parsed)) {
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
// Text tokens — parsed from Astro island props
// ──────────────────────────────────────────────────────────────────────────────

function parseTextFromAstroIslands(html: string): RawEntry[] {
  const propsRegex = /props="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = propsRegex.exec(html)) !== null) {
    const decoded = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    let data: { tier?: [number, string]; rows?: [number, Array<[number, Array<[number, unknown]>]>] };
    try {
      data = JSON.parse(decoded);
    } catch {
      continue;
    }
    if (!data.tier || !data.rows) continue;
    const tier = data.tier[1];
    if (tier !== 'standard') continue;

    const rows = data.rows[1];
    const entries: RawEntry[] = [];
    for (const row of rows) {
      if (row[0] !== 1) continue;
      const cells = row[1];
      if (!cells || cells.length < 4) continue;

      const rawName = String(cells[0][1]).trim();
      const input = cells[1][1];
      const cached = cells[2][1];
      const output = cells[3][1];

      const nameMatch = rawName.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      const id = nameMatch ? nameMatch[1].trim() : rawName;
      const contextNote = nameMatch ? nameMatch[2].trim() : null;

      entries.push({
        id,
        input: typeof input === 'number' ? input : null,
        cachedInput: typeof cached === 'number' ? cached : null,
        output: typeof output === 'number' ? output : null,
        contextNote,
      });
    }
    return entries;
  }
  return [];
}

function groupContextTiers(entries: RawEntry[]): Record<string, TextModelData> {
  const result: Record<string, TextModelData> = {};

  for (const e of entries) {
    if (e.contextNote && e.contextNote.startsWith('>')) {
      const base = e.id;
      if (result[base]) {
        if (!result[base].contextTiers) result[base].contextTiers = {};
        const label = e.contextNote.replace(/\s*context length\s*/i, '').trim();
        result[base].contextTiers![label] = {
          input: e.input!,
          ...(e.cachedInput != null ? { cachedInput: e.cachedInput } : {}),
          ...(e.output != null ? { output: e.output } : {}),
        };
      }
      continue;
    }

    const entry: TextModelData = { input: e.input! };
    if (e.cachedInput != null) entry.cachedInput = e.cachedInput;
    if (e.output != null) entry.output = e.output;

    if (e.contextNote && /^<\d+K/i.test(e.contextNote)) {
      const threshold = e.contextNote.replace(/\s*context length\s*/i, '').trim();
      const highLabel = threshold.replace('<', '>');
      entry.contextTiers = {};
      const highTier: { input: number; cachedInput?: number; output?: number } = { input: e.input! * 2 };
      if (e.cachedInput != null) highTier.cachedInput = e.cachedInput * 2;
      if (e.output != null) highTier.output = e.output * 1.5;
      entry.contextTiers[highLabel] = highTier;
    }

    result[e.id] = entry;
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// HTML table parsers
// ──────────────────────────────────────────────────────────────────────────────

function parseStandardSection(text: string, sectionStart: number, sectionEnd: number): RawEntry[] {
  const block = text.substring(sectionStart, sectionEnd);
  const models: RawEntry[] = [];
  const seen = new Set<string>();

  // Pass 1: 3-field (input, cached-or-dash, output-or-dash)
  const regex3 =
    /([\w][\w./-]*(?:-[\w.]+)*)(?:\s+\(([^)]+)\))?\s+\$([\d.]+)\s+(?:\$([\d.]+)|[-/])\s+(?:\$([\d.]+)|[-/])/g;
  let m: RegExpExecArray | null;
  while ((m = regex3.exec(block)) !== null) {
    const id = m[1];
    if (id.includes('window') || id.includes('function') || id.includes('var')) continue;
    const contextNote = m[2] || null;
    const key = `${id}|${contextNote || ''}`;
    seen.add(key);
    models.push({
      id,
      input: parseFloat(m[3]),
      cachedInput: m[4] ? parseFloat(m[4]) : null,
      output: m[5] ? parseFloat(m[5]) : null,
      contextNote,
    });
  }

  // Pass 2: 2-field (input, output — no cached column)
  const regex2 = /([\w][\w./-]*(?:-[\w.]+)*)(?:\s+\(([^)]+)\))?\s+\$([\d.]+)\s+\$([\d.]+)/g;
  while ((m = regex2.exec(block)) !== null) {
    const id = m[1];
    if (id.includes('window') || id.includes('function') || id.includes('var')) continue;
    const contextNote = m[2] || null;
    const key = `${id}|${contextNote || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({
      id,
      input: parseFloat(m[3]),
      cachedInput: null,
      output: parseFloat(m[4]),
      contextNote,
    });
  }

  return models;
}

function parseImageTokens(text: string): Record<string, TextModelData> {
  const sectionIdx = text.indexOf('Image tokens Prices per 1M tokens');
  if (sectionIdx === -1) return {};
  const stdIdx = text.indexOf('Standard', sectionIdx);
  if (stdIdx === -1 || stdIdx > sectionIdx + 2000) return {};
  const endIdx = findSectionEnd(text, stdIdx, ['Audio tokens', 'Video', 'if (!window.__contentSwitcherInit)']);
  const entries = parseStandardSection(text, stdIdx, endIdx);
  return groupContextTiers(entries);
}

function parseAudioTokens(text: string): Record<string, TextModelData> {
  const sectionIdx = text.indexOf('Audio tokens Prices per 1M tokens');
  if (sectionIdx === -1) return {};
  const endIdx = findSectionEnd(text, sectionIdx, ['Video Prices per second', 'Fine-tuning']);
  const entries = parseStandardSection(text, sectionIdx, endIdx);
  return groupContextTiers(entries);
}

function parseVideo(text: string): Record<string, VideoModelData> {
  const sectionIdx = text.indexOf('Video Prices per second');
  if (sectionIdx === -1) return {};
  const endIdx = findSectionEnd(text, sectionIdx, ['Fine-tuning'], 1000);
  const fullBlock = text.substring(sectionIdx, endIdx);

  const batchModelIdx = fullBlock.indexOf('Batch Model');
  const videoBlock = batchModelIdx > 0 ? fullBlock.substring(0, batchModelIdx) : fullBlock;

  const vRegex = /(sora[\w-]+)\s+Portrait:\s*(\d+x\d+)\s+Landscape:\s*(\d+x\d+)\s+\$([\d.]+)/g;
  let vm: RegExpExecArray | null;
  const result: Record<string, VideoModelData> = {};

  while ((vm = vRegex.exec(videoBlock)) !== null) {
    const id = vm[1];
    const portrait = vm[2];
    const landscape = vm[3];
    const price = parseFloat(vm[4]);
    const resolution = `${portrait} / ${landscape}`;

    if (!result[id]) {
      result[id] = { perSecond: price, resolution };
    } else {
      if (!result[id].resolutionTiers) result[id].resolutionTiers = {};
      result[id].resolutionTiers![resolution] = { perSecond: price };
    }
  }

  return result;
}

function parseTranscription(text: string): Record<string, TranscriptionModelData> {
  let sectionIdx = text.indexOf('Transcription and speech generation');
  if (sectionIdx === -1) sectionIdx = text.indexOf('Transcription & Speech');
  if (sectionIdx === -1) sectionIdx = text.indexOf('Transcription');
  if (sectionIdx === -1) return {};

  const endIdx = findSectionEnd(text, sectionIdx, ['Image generation', 'Embeddings'], 3000);
  const block = text.substring(sectionIdx, endIdx);

  const result: Record<string, TranscriptionModelData> = {};

  const textSection = block.indexOf('Text tokens');
  const audioSection = block.indexOf('Audio tokens');
  const otherSection = block.indexOf('Other');

  if (textSection !== -1 && audioSection !== -1) {
    const textBlock = block.substring(textSection, audioSection);
    const re = /(gpt-[\w-]+)\s*\|?\s*\$([\d.]+)\s*\|?\s*(?:\$([\d.]+)|[-])\s*\|?\s*\$([\d.]+)\s*\/\s*minute/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(textBlock)) !== null) {
      const id = m[1];
      if (!result[id]) result[id] = {};
      result[id].text = { input: parseFloat(m[2]) };
      if (m[3]) result[id].text!.output = parseFloat(m[3]);
      result[id].estimatedPerMinute = parseFloat(m[4]);
    }

    const reFallback = /(gpt-[\w-]+)\s+\$([\d.]+)\s+(?:\$([\d.]+)\s+)?\$([\d.]+)\s*\/\s*minute/g;
    let mf: RegExpExecArray | null;
    while ((mf = reFallback.exec(textBlock)) !== null) {
      const id = mf[1];
      if (result[id]) continue;
      result[id] = {};
      if (mf[3]) {
        result[id].text = { input: parseFloat(mf[2]), output: parseFloat(mf[3]) };
      } else {
        result[id].text = { input: parseFloat(mf[2]) };
      }
      result[id].estimatedPerMinute = parseFloat(mf[4]);
    }
  }

  if (audioSection !== -1) {
    const audioEnd = otherSection > audioSection ? otherSection : audioSection + 1000;
    const audioBlock = block.substring(audioSection, audioEnd);
    const re = /(gpt-[\w-]+)\s*\|?\s*(?:\$([\d.]+)|[-])\s*\|?\s*(?:\$([\d.]+)|[-])\s*\|?\s*\$([\d.]+)\s*\/\s*minute/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(audioBlock)) !== null) {
      const id = m[1];
      if (!result[id]) result[id] = {};
      result[id].audio = {};
      if (m[2]) result[id].audio!.input = parseFloat(m[2]);
      if (m[3]) result[id].audio!.output = parseFloat(m[3]);
      if (!result[id].estimatedPerMinute) result[id].estimatedPerMinute = parseFloat(m[4]);
    }

    const reFallback = /(gpt-[\w-]+)\s+(?:\$([\d.]+)\s+)?\$([\d.]+)\s*\/\s*minute/g;
    let mf: RegExpExecArray | null;
    while ((mf = reFallback.exec(audioBlock)) !== null) {
      const id = mf[1];
      if (result[id]?.audio) continue;
      if (!result[id]) result[id] = {};
      result[id].audio = {};
      if (mf[2]) {
        const isTTS = id.includes('tts');
        if (isTTS) {
          result[id].audio!.output = parseFloat(mf[2]);
        } else {
          result[id].audio!.input = parseFloat(mf[2]);
        }
      }
      if (!result[id].estimatedPerMinute) result[id].estimatedPerMinute = parseFloat(mf[3]);
    }
  }

  if (otherSection !== -1) {
    const otherBlock = block.substring(otherSection);
    const whiskerMatch = otherBlock.match(/Whisper[^$]*\$([\d.]+)\s*\/\s*minute/i);
    if (whiskerMatch) {
      result['whisper'] = { perMinute: parseFloat(whiskerMatch[1]) };
    }
    const ttsHdMatch = otherBlock.match(/TTS\s+HD[^$]*\$([\d.]+)\s*\/\s*1M\s*char/i);
    if (ttsHdMatch) {
      result['tts-hd'] = { perMillionChars: parseFloat(ttsHdMatch[1]) };
    }
    const ttsMatch = otherBlock.match(/(?<!\w)TTS(?!\s+HD)[^$]*\$([\d.]+)\s*\/\s*1M\s*char/i);
    if (ttsMatch) {
      result['tts'] = { perMillionChars: parseFloat(ttsMatch[1]) };
    }
  }

  return result;
}

function parseFineTuning(text: string): Record<string, FineTuningModelData> {
  const sectionIdx = text.indexOf('Fine-tuning Prices per 1M tokens');
  if (sectionIdx === -1) return {};

  const endIdx = findSectionEnd(text, sectionIdx, ['Built-in tools', 'AgentKit'], 3000);
  const fullBlock = text.substring(sectionIdx, endIdx);

  let stdIdx = fullBlock.indexOf('Standard Model Training');
  if (stdIdx === -1) stdIdx = fullBlock.lastIndexOf('Standard');
  if (stdIdx === -1) return {};

  const stdBlock = fullBlock.substring(stdIdx);
  const result: Record<string, FineTuningModelData> = {};

  const re =
    /([\w][\w./-]+(?:-[\w.]+)*(?:\s+with\s+data\s+sharing)?)\s+\$([\d.]+)\s*(?:\/\s*hour\s+)?\$([\d.]+)\s+(?:\$([\d.]+)|[-])\s+\$([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdBlock)) !== null) {
    const rawId = m[1].trim();
    if (rawId.includes('window') || rawId.includes('function')) continue;

    const id = rawId.replace(/\s+with\s+data\s+sharing/, '-data-sharing');
    const trainingVal = parseFloat(m[2]);
    const input = parseFloat(m[3]);
    const cached = m[4] ? parseFloat(m[4]) : null;
    const output = parseFloat(m[5]);

    const trainingCtx = stdBlock.substring(m.index!, m.index! + m[0].length);
    const isPerHour = trainingCtx.includes('/ hour');

    const entry: FineTuningModelData = { input, output };
    if (isPerHour) {
      entry.trainingPerHour = trainingVal;
    } else {
      entry.trainingPerMTok = trainingVal;
    }
    if (cached != null) entry.cachedInput = cached;

    result[id] = entry;
  }

  return result;
}

function parseImageGeneration(text: string): Record<string, ImageGenModelData> {
  const sectionIdx = text.indexOf('Image generation Prices per image');
  if (sectionIdx === -1) return {};

  const endIdx = findSectionEnd(text, sectionIdx, ['Embeddings Prices per 1M tokens'], 4000);
  const block = text.substring(sectionIdx, endIdx);

  const result: Record<string, ImageGenModelData> = {};

  const modelDefs = [
    { search: 'GPT Image 1.5', id: 'gpt-image-1.5', sizes: ['1024x1024', '1024x1536', '1536x1024'] },
    {
      search: 'GPT Image Latest',
      altSearch: 'ChatGPT Image Latest',
      id: 'chatgpt-image-latest',
      sizes: ['1024x1024', '1024x1536', '1536x1024'],
    },
    {
      search: 'GPT Image 1 ',
      id: 'gpt-image-1',
      sizes: ['1024x1024', '1024x1536', '1536x1024'],
      skipIfFollowedBy: 'Mini',
    },
    { search: 'GPT Image 1 Mini', id: 'gpt-image-1-mini', sizes: ['1024x1024', '1024x1536', '1536x1024'] },
    { search: 'DALL', id: 'dall-e-3', sizes: ['1024x1024', '1024x1792', '1792x1024'] },
    { search: 'DALL', id: 'dall-e-2', sizes: ['256x256', '512x512', '1024x1024'] },
  ];

  const modelPositions: Array<{
    search: string;
    altSearch?: string;
    id: string;
    sizes: string[];
    skipIfFollowedBy?: string;
    pos: number;
  }> = [];
  let searchFrom = 0;
  for (const def of modelDefs) {
    let pos = searchFrom;
    while (true) {
      pos = block.indexOf(def.search, pos);
      if (pos === -1 && 'altSearch' in def && def.altSearch) pos = block.indexOf(def.altSearch, searchFrom);
      if (pos === -1) break;
      if ('skipIfFollowedBy' in def && def.skipIfFollowedBy && block.substring(pos + def.search.length).startsWith(def.skipIfFollowedBy)) {
        pos += def.search.length;
        continue;
      }
      break;
    }
    if (pos === -1) continue;
    modelPositions.push({ ...def, pos });
    searchFrom = pos + def.search.length;
  }

  const qualityRowRegex = /(Low|Medium|High|Standard|HD)\s+\$([\d.]+)\s+\$([\d.]+)\s+\$([\d.]+)/g;

  for (let i = 0; i < modelPositions.length; i++) {
    const def = modelPositions[i];
    const modelStart = def.pos;
    const modelEnd = i + 1 < modelPositions.length ? modelPositions[i + 1].pos : block.length;

    const modelBlock = block.substring(modelStart, modelEnd);
    const variants: Array<{ quality: string; size: string; perImage: number }> = [];

    qualityRowRegex.lastIndex = 0;
    let qm: RegExpExecArray | null;
    while ((qm = qualityRowRegex.exec(modelBlock)) !== null) {
      const quality = qm[1].toLowerCase();
      const prices = [parseFloat(qm[2]), parseFloat(qm[3]), parseFloat(qm[4])];
      for (let j = 0; j < 3; j++) {
        variants.push({ quality, size: def.sizes[j], perImage: prices[j] });
      }
    }

    if (variants.length > 0) {
      result[def.id] = { variants };
    }
  }

  return result;
}

function parseEmbeddings(text: string): Record<string, EmbeddingModelData> {
  const sectionIdx = text.indexOf('Embeddings Prices per 1M tokens');
  if (sectionIdx === -1) return {};

  const endIdx = findSectionEnd(text, sectionIdx, ['Built-in tools', 'Legacy models'], 1500);
  const block = text.substring(sectionIdx, endIdx);

  const result: Record<string, EmbeddingModelData> = {};

  const re = /(text-embedding[\w-]+)\s+\$([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    result[m[1]] = { input: parseFloat(m[2]) };
  }

  return result;
}

function parseLegacy(text: string): Record<string, { input: number; output: number }> {
  const sectionIdx = text.indexOf('Legacy models Prices per 1M tokens');
  if (sectionIdx === -1) return {};

  const endIdx = findSectionEnd(text, sectionIdx, ['Data residency', 'AgentKit'], 4000);
  const fullBlock = text.substring(sectionIdx, endIdx);

  const stdIdx = fullBlock.lastIndexOf('Standard');
  if (stdIdx === -1) return {};

  const afterStd = fullBlock.substring(stdIdx);
  const batchModelIdx = afterStd.indexOf('Batch Model');
  const stdBlock = batchModelIdx > 0 ? afterStd.substring(0, batchModelIdx) : afterStd;
  const result: Record<string, { input: number; output: number }> = {};

  const re = /([\w][\w./-]*(?:-[\w.]+)*)\s+\$([\d.]+)\s+\$([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdBlock)) !== null) {
    const id = m[1];
    if (id.includes('window') || id.includes('function') || id.includes('var')) continue;
    if (id === 'Standard' || id === 'Batch') continue;
    result[id] = { input: parseFloat(m[2]), output: parseFloat(m[3]) };
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Convert raw sections to ModelPricing[]
// ──────────────────────────────────────────────────────────────────────────────

function convertTextModels(
  models: Record<string, TextModelData>,
  modelType: ModelType,
  method?: string,
): ModelPricing[] {
  const results: ModelPricing[] = [];
  for (const [modelId, data] of Object.entries(models)) {
    const entry: ModelPricing = {
      pricingUnit: 'per-token',
      modelType,
      sourceUrl: SOURCE_URL,
      extractionMethod: method,
    };
    if (data.input != null) entry.inputCostPerToken = toPerToken(data.input);
    if (data.output != null) entry.outputCostPerToken = toPerToken(data.output);
    if (data.cachedInput != null) {
      const caching: Partial<Record<CachingKey, number>> = { read: toPerToken(data.cachedInput) };
      entry.caching = caching;
    }
    if (data.contextTiers) {
      entry.contextTiers = Object.entries(data.contextTiers).map(([threshold, tier]): ContextTier => {
        const ct: ContextTier = { threshold };
        if (tier.input != null) ct.inputCostPerToken = toPerToken(tier.input);
        if (tier.cachedInput != null) ct.cachedInputCostPerToken = toPerToken(tier.cachedInput);
        if (tier.output != null) ct.outputCostPerToken = toPerToken(tier.output);
        return ct;
      });
    }
    entry.displayName = modelId;
    results.push(entry);
  }
  return results;
}

function convertToModelPricing(
  textModels: Record<string, TextModelData>,
  imageModels: Record<string, TextModelData>,
  audioModels: Record<string, TextModelData>,
  videoModels: Record<string, VideoModelData>,
  transcriptionModels: Record<string, TranscriptionModelData>,
  fineTuningModels: Record<string, FineTuningModelData>,
  imageGenModels: Record<string, ImageGenModelData>,
  embeddingModels: Record<string, EmbeddingModelData>,
  legacyModels: Record<string, { input: number; output: number }>,
  extractionMethod: Record<string, string>,
): ModelPricing[] {
  const results: ModelPricing[] = [];

  // Text models — highest priority (0)
  for (const mp of convertTextModels(textModels, 'chatCompletion', extractionMethod.text)) {
    mp._sectionPriority = 0;
    results.push(mp);
  }

  // Image token models (vision input) — priority 1
  for (const mp of convertTextModels(imageModels, 'chatCompletion', extractionMethod.image)) {
    mp._sectionPriority = 1;
    results.push(mp);
  }

  // Audio token models — priority 2
  for (const mp of convertTextModels(audioModels, 'audio', extractionMethod.audio)) {
    mp._sectionPriority = 2;
    results.push(mp);
  }

  // Video models — priority 3
  for (const [modelId, data] of Object.entries(videoModels)) {
    const entry: ModelPricing = {
      displayName: modelId,
      modelType: 'video',
      pricingUnit: 'per-second',
      sourceUrl: SOURCE_URL,
      extractionMethod: extractionMethod.video,
      _sectionPriority: 3,
    };
    if (data.perSecond != null) entry.costPerSecond = data.perSecond;
    const variants: Array<{ resolution: string; costPerSecond: number }> = [];
    if (data.resolution) {
      variants.push({ resolution: data.resolution, costPerSecond: data.perSecond });
    }
    if (data.resolutionTiers) {
      for (const [resolution, tier] of Object.entries(data.resolutionTiers)) {
        variants.push({ resolution, costPerSecond: tier.perSecond });
      }
    }
    if (variants.length > 0) entry.videoVariants = variants;
    results.push(entry);
  }

  // Transcription models — priority 4
  for (const [modelId, data] of Object.entries(transcriptionModels)) {
    const entry: ModelPricing = {
      displayName: modelId,
      sourceUrl: SOURCE_URL,
      extractionMethod: extractionMethod.transcription,
      pricingUnit: 'per-token',
      _sectionPriority: 4,
    };
    if (data.text || data.audio) {
      entry.modelType = 'transcription';
      if (data.text?.input != null) entry.inputCostPerToken = toPerToken(data.text.input);
      if (data.text?.output != null) entry.outputCostPerToken = toPerToken(data.text.output);
      if (data.estimatedPerMinute != null) entry.costPerMinute = data.estimatedPerMinute;
    } else if (data.perMinute != null) {
      entry.modelType = 'transcription';
      entry.pricingUnit = 'per-minute';
      entry.costPerMinute = data.perMinute;
    } else if (data.perMillionChars != null) {
      entry.modelType = 'audio';
      entry.costPerMillionChars = data.perMillionChars;
    }
    results.push(entry);
  }

  // Fine-tuning models — priority 6
  for (const [modelId, data] of Object.entries(fineTuningModels)) {
    const entry: ModelPricing = {
      displayName: modelId,
      modelType: 'fineTuning',
      pricingUnit: 'per-token',
      sourceUrl: SOURCE_URL,
      extractionMethod: extractionMethod.fineTuning,
      _sectionPriority: 6,
    };
    if (data.trainingPerMTok != null) entry.trainingCostPerToken = toPerToken(data.trainingPerMTok);
    if (data.trainingPerHour != null) entry.trainingCostPerHour = data.trainingPerHour;
    if (data.input != null) entry.inputCostPerToken = toPerToken(data.input);
    if (data.output != null) entry.outputCostPerToken = toPerToken(data.output);
    results.push(entry);
  }

  // Image generation models — priority 3
  for (const [modelId, data] of Object.entries(imageGenModels)) {
    const entry: ModelPricing = {
      displayName: modelId,
      modelType: 'imageGeneration',
      pricingUnit: 'per-image',
      sourceUrl: SOURCE_URL,
      extractionMethod: extractionMethod.imageGeneration,
      _sectionPriority: 3,
    };
    if (data.variants && data.variants.length > 0) {
      entry.costPerImage = Math.min(...data.variants.map((v) => v.perImage));
      entry.imageVariants = data.variants.map((v) => ({
        quality: v.quality,
        size: v.size,
        costPerImage: v.perImage,
      }));
    }
    results.push(entry);
  }

  // Embedding models — priority 3
  for (const [modelId, data] of Object.entries(embeddingModels)) {
    const entry: ModelPricing = {
      displayName: modelId,
      modelType: 'embedding',
      pricingUnit: 'per-token',
      sourceUrl: SOURCE_URL,
      extractionMethod: extractionMethod.embedding,
      _sectionPriority: 3,
    };
    if (data.input != null) entry.inputCostPerToken = toPerToken(data.input);
    results.push(entry);
  }

  // Legacy models — priority 5
  for (const [modelId, data] of Object.entries(legacyModels)) {
    const entry: ModelPricing = {
      displayName: modelId,
      modelType: 'chatCompletion',
      pricingUnit: 'per-token',
      sourceUrl: SOURCE_URL,
      extractionMethod: extractionMethod.legacy,
      deprecated: true,
      _sectionPriority: 5,
    };
    if (data.input != null) entry.inputCostPerToken = toPerToken(data.input);
    if (data.output != null) entry.outputCostPerToken = toPerToken(data.output);
    results.push(entry);
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

export async function scrapeOpenAI(options: { noLlm?: boolean } = {}): Promise<ModelPricing[]> {
  const noLLM = options.noLlm ?? false;

  if (noLLM) console.error('LLM fallback disabled (--no-llm)');

  console.error(`Fetching ${PAGE_URL} ...`);
  const html = await httpFetch(PAGE_URL);
  const text = stripHtml(html);

  const cleanText = stripHtmlClean(html);
  _cleanText = cleanText;
  console.error(
    `  Text lengths: regex=${text.length}, clean=${cleanText.length} (${Math.round((1 - cleanText.length / text.length) * 100)}% smaller)`,
  );

  const extractionMethod: Record<string, string> = {};

  // Text tokens (from Astro island structured data)
  const textEntries = parseTextFromAstroIslands(html);
  let textModels: Record<string, TextModelData> = textEntries.length > 0 ? groupContextTiers(textEntries) : {};
  extractionMethod.text = 'regex';
  if (isSectionSuspicious('text', textModels as Record<string, unknown>) && !noLLM) {
    console.error(`  text section suspicious (${Object.keys(textModels).length} entries), trying LLM fallback...`);
    const prompt = SECTION_PROMPTS.text;
    const systemPrompt = [
      'You are a pricing data extractor. Extract structured pricing data from the given text.',
      `Output ONLY valid JSON matching this schema: ${prompt.schema}`,
      `Example output: ${prompt.example}`,
      prompt.instructions,
      'All prices must be numbers (not strings). Use null for missing values.',
      'Do NOT include any text outside the JSON object.',
    ].join('\n');
    const sectionText = extractSectionText(text, 'text');
    const llmResult = await callLlmFallback({
      provider: 'openai-text',
      prompt: systemPrompt,
      htmlContent: sectionText,
    });
    if (llmResult) {
      try {
        const parsed = JSON.parse(llmResult.content) as Record<string, TextModelData>;
        if (!isSectionSuspicious('text', parsed as Record<string, unknown>)) {
          textModels = parsed;
          extractionMethod.text = 'llm';
        } else {
          extractionMethod.text = 'regex+llm-failed';
        }
      } catch {
        extractionMethod.text = 'regex+llm-failed';
      }
    } else {
      extractionMethod.text = 'regex+llm-skipped';
    }
  }
  console.error(`  Text models: ${Object.keys(textModels).length} [${extractionMethod.text}]`);

  // Image tokens
  const imageModelsRaw = await tryLlmFallback('image', parseImageTokens(text) as Record<string, unknown>, text, extractionMethod, noLLM);
  const imageModels = imageModelsRaw as Record<string, TextModelData>;
  console.error(`  Image models: ${Object.keys(imageModels).length} [${extractionMethod.image}]`);

  // Audio tokens
  const audioModelsRaw = await tryLlmFallback('audio', parseAudioTokens(text) as Record<string, unknown>, text, extractionMethod, noLLM);
  const audioModels = audioModelsRaw as Record<string, TextModelData>;
  console.error(`  Audio models: ${Object.keys(audioModels).length} [${extractionMethod.audio}]`);

  // Video
  const videoModelsRaw = await tryLlmFallback('video', parseVideo(text) as Record<string, unknown>, text, extractionMethod, noLLM);
  const videoModels = videoModelsRaw as Record<string, VideoModelData>;
  console.error(`  Video models: ${Object.keys(videoModels).length} [${extractionMethod.video}]`);

  // Transcription
  const transcriptionModelsRaw = await tryLlmFallback('transcription', parseTranscription(text) as Record<string, unknown>, text, extractionMethod, noLLM);
  const transcriptionModels = transcriptionModelsRaw as Record<string, TranscriptionModelData>;
  console.error(`  Transcription models: ${Object.keys(transcriptionModels).length} [${extractionMethod.transcription}]`);

  // Fine-tuning
  const fineTuningModelsRaw = await tryLlmFallback('fineTuning', parseFineTuning(cleanText) as Record<string, unknown>, text, extractionMethod, noLLM);
  const fineTuningModels = fineTuningModelsRaw as Record<string, FineTuningModelData>;
  console.error(`  Fine-tuning models: ${Object.keys(fineTuningModels).length} [${extractionMethod.fineTuning}]`);

  // Image Generation
  const imageGenModelsRaw = await tryLlmFallback('imageGeneration', parseImageGeneration(text) as Record<string, unknown>, text, extractionMethod, noLLM);
  const imageGenModels = imageGenModelsRaw as Record<string, ImageGenModelData>;
  console.error(`  Image generation models: ${Object.keys(imageGenModels).length} [${extractionMethod.imageGeneration}]`);

  // Embeddings
  const embeddingModelsRaw = await tryLlmFallback('embedding', parseEmbeddings(text) as Record<string, unknown>, text, extractionMethod, noLLM);
  const embeddingModels = embeddingModelsRaw as Record<string, EmbeddingModelData>;
  console.error(`  Embedding models: ${Object.keys(embeddingModels).length} [${extractionMethod.embedding}]`);

  // Legacy
  const legacyModelsRaw = await tryLlmFallback('legacy', parseLegacy(text) as Record<string, unknown>, text, extractionMethod, noLLM);
  const legacyModels = legacyModelsRaw as Record<string, { input: number; output: number }>;
  console.error(`  Legacy models: ${Object.keys(legacyModels).length} [${extractionMethod.legacy}]`);

  const results = convertToModelPricing(
    textModels,
    imageModels,
    audioModels,
    videoModels,
    transcriptionModels,
    fineTuningModels,
    imageGenModels,
    embeddingModels,
    legacyModels,
    extractionMethod,
  );

  console.error(`  Total ModelPricing entries: ${results.length}`);
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && (process.argv[1].endsWith('scrape-openai.ts') || process.argv[1].endsWith('scrape-openai.js'))) {
  const noLlm = process.argv.includes('--no-llm');
  const pretty = process.argv.includes('--pretty');

  scrapeOpenAI({ noLlm })
    .then((results) => {
      const json = pretty ? JSON.stringify(results, null, 2) : JSON.stringify(results);
      process.stdout.write(json + '\n');
    })
    .catch((err: Error) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
