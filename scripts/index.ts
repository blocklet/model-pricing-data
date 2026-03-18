#!/usr/bin/env npx tsx
/**
 * AI Model Pricing Data - Main Entry Point
 *
 * Scrapes official pricing from AI providers and outputs standardized JSON.
 *
 * Usage:
 *   npx tsx scripts/index.ts              # Full scrape + output
 *   npx tsx scripts/index.ts --dry-run    # Scrape without writing files
 *   npx tsx scripts/index.ts --no-llm     # Disable LLM fallback for scrapers
 *   npx tsx scripts/index.ts --help       # Show this help
 */

import type { ModelPricing, ProviderSource } from './lib/schema.js';
import { PRICING_URLS } from './lib/pricing-core.js';
import { scrapeOpenAI } from './scrape-openai.js';
import { scrapeAnthropic } from './scrape-anthropic.js';
import { scrapeGoogle } from './scrape-google.js';
import { scrapeXAI } from './scrape-xai.js';
import { scrapeDeepSeek } from './scrape-deepseek.js';
import { fetchOpenRouter } from './fetch-openrouter.js';
import { mergeAll } from './merge.js';
import type { MergeInput } from './merge.js';
import { toLiteLLMFormat } from './utils/to-litellm-format.js';
import { writeOutput } from './utils/write-output.js';
import { verifyScraperResults } from './llm-verify.js';

function printHelp(): void {
  console.log(`
AI Model Pricing Data Scraper

Usage:
  npx tsx scripts/index.ts [options]

Options:
  --dry-run     Scrape data but don't write files
  --no-llm      Disable LLM fallback for scrapers that support it
  --help        Show this help message

Output:
  data/pricing.json           Full pricing data (providers grouped)
  data/pricing-litellm.json   LiteLLM-compatible format
  data/providers/*.json       Per-provider JSON files
`);
}

// ─── Scraper Definitions ─────────────────────────────────────────────────────

interface ScraperDef {
  provider: string;
  label: string;
  method: string;
  fn: () => Promise<ModelPricing[]>;
}

function buildScrapers(noLlm: boolean): ScraperDef[] {
  return [
    {
      provider: 'openai',
      label: 'OpenAI',
      method: noLlm ? 'regex' : 'regex+llm',
      fn: () => scrapeOpenAI({ noLlm }),
    },
    {
      provider: 'anthropic',
      label: 'Anthropic',
      method: noLlm ? 'regex' : 'regex+llm',
      fn: () => scrapeAnthropic({ noLlm }),
    },
    {
      provider: 'google',
      label: 'Google',
      method: 'regex',
      fn: scrapeGoogle,
    },
    {
      provider: 'xai',
      label: 'xAI',
      method: 'regex',
      fn: scrapeXAI,
    },
    {
      provider: 'deepseek',
      label: 'DeepSeek',
      method: 'regex',
      fn: scrapeDeepSeek,
    },
    {
      provider: 'openrouter',
      label: 'OpenRouter',
      method: 'api',
      fn: fetchOpenRouter,
    },
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const noLlm = args.includes('--no-llm');

  const scrapers = buildScrapers(noLlm);

  console.error(`Starting ${scrapers.length} scrapers in parallel...`);
  const startTime = Date.now();

  // Run all scrapers in parallel
  const results = await Promise.allSettled(
    scrapers.map((s) => s.fn()),
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`All scrapers completed in ${elapsed}s\n`);

  // Collect results, track failures
  const inputs: MergeInput[] = [];
  const failedProviders: string[] = [];

  for (let i = 0; i < scrapers.length; i++) {
    const scraper = scrapers[i];
    const result = results[i];

    if (result.status === 'fulfilled') {
      const entries = result.value;
      const source: ProviderSource = {
        url: PRICING_URLS[scraper.provider] || '',
        modelCount: entries.length,
        method: scraper.method,
        fetchedAt: new Date().toISOString(),
      };

      inputs.push({ provider: scraper.provider, entries, source });
      console.error(`  ${scraper.label}: ${entries.length} models`);
    } else {
      failedProviders.push(scraper.provider);
      console.error(`  ${scraper.label}: FAILED - ${result.reason?.message || result.reason}`);
    }
  }

  console.error('');

  // Verify: check for significant model count changes vs previous data
  if (!noLlm) {
    const verifyResults = await verifyScraperResults(
      inputs.map(inp => ({ provider: inp.provider, entries: inp.entries })),
    );

    for (const vr of verifyResults) {
      if (vr.action === 'use-llm' && vr.llmModels) {
        console.error(`  [verify] ⚠️  ${vr.provider}: ${vr.reason}`);
        console.error(`  [verify] Replacing regex result with LLM result for ${vr.provider}`);
        const idx = inputs.findIndex(inp => inp.provider === vr.provider);
        if (idx >= 0) {
          inputs[idx].entries = vr.llmModels;
          inputs[idx].source.modelCount = vr.llmModels.length;
          inputs[idx].source.method = 'llm-verified';
        }
      } else if (vr.action === 'keep-regex') {
        console.error(`  [verify] ✅ ${vr.provider}: ${vr.reason}`);
      }
    }
    if (verifyResults.length > 0) console.error('');
  }

  // Merge all sources
  const data = mergeAll(inputs, failedProviders);

  // Summary
  const providerCount = Object.keys(data.providers).length;
  console.error(`Merged: ${data._meta.totalModels} models across ${providerCount} providers`);
  if (failedProviders.length > 0) {
    console.error(`Failed providers: ${failedProviders.join(', ')}`);
  }

  // Convert to LiteLLM format
  const litellm = toLiteLLMFormat(data);

  if (dryRun) {
    console.log(JSON.stringify(data._meta, null, 2));
  } else {
    await writeOutput(data, litellm);
    console.log(`Written: data/pricing.json (${data._meta.totalModels} models)`);
    console.log(`Written: data/pricing-litellm.json (${Object.keys(litellm).length} entries)`);
    console.log(`Written: data/providers/*.json (${providerCount} providers)`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
