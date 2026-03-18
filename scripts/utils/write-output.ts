/**
 * Atomic file writer for pricing data outputs.
 *
 * Writes:
 *   data/pricing.json          — full PricingData
 *   data/pricing-litellm.json  — LiteLLM-compatible format
 *   data/providers/{provider}.json — per-provider model maps
 *
 * Uses atomic write (write to .tmp, then rename) to avoid partial files.
 */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { PricingData, LiteLLMPricingData } from '../lib/schema.js';

/**
 * Atomically write content to a file: write to .tmp first, then rename.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Write all output files for the pricing data.
 *
 * @param data       Full PricingData structure
 * @param litellm    LiteLLM-compatible pricing data
 * @param outputDir  Base output directory (defaults to repo's data/ dir)
 */
export async function writeOutput(
  data: PricingData,
  litellm: LiteLLMPricingData,
  outputDir?: string,
): Promise<void> {
  const baseDir = outputDir ?? resolve(import.meta.dirname!, '..', '..', 'data');

  // 1. Full pricing data
  await atomicWrite(
    resolve(baseDir, 'pricing.json'),
    JSON.stringify(data, null, 2) + '\n',
  );

  // 2. LiteLLM format
  await atomicWrite(
    resolve(baseDir, 'pricing-litellm.json'),
    JSON.stringify(litellm, null, 2) + '\n',
  );

  // 3. Per-provider files
  const providersDir = resolve(baseDir, 'providers');
  for (const [provider, models] of Object.entries(data.providers)) {
    // Skip empty providers
    const modelCount = Object.keys(models).length;
    if (modelCount === 0) continue;

    await atomicWrite(
      resolve(providersDir, `${provider}.json`),
      JSON.stringify(models, null, 2) + '\n',
    );
  }
}
