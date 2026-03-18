#!/usr/bin/env npx tsx
/**
 * AI Model Pricing Data - Main Entry Point
 *
 * Scrapes official pricing from AI providers and outputs standardized JSON.
 *
 * Usage:
 *   npx tsx scripts/index.ts              # Full scrape + output
 *   npx tsx scripts/index.ts --dry-run    # Scrape without writing files
 *   npx tsx scripts/index.ts --help       # Show this help
 */

import type { PricingData, PricingMeta } from './lib/schema.js';

function printHelp(): void {
  console.log(`
AI Model Pricing Data Scraper

Usage:
  npx tsx scripts/index.ts [options]

Options:
  --dry-run     Scrape data but don't write files
  --help        Show this help message

Output:
  data/pricing.json           Full pricing data (providers grouped)
  data/pricing-litellm.json   LiteLLM-compatible format
  data/providers/*.json       Per-provider JSON files
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');

  // Phase 0: just validate schema works
  const meta: PricingMeta = {
    generatedAt: new Date().toISOString(),
    version: '2.0.0',
    sources: {},
    totalModels: 0,
    failedProviders: [],
  };

  const data: PricingData = {
    _meta: meta,
    providers: {},
  };

  console.log('Schema validation OK');
  console.log(`Generated at: ${data._meta.generatedAt}`);

  if (dryRun) {
    console.log('Dry run mode - no files written');
  } else {
    console.log('TODO: Implement scraping in Phase 1-4');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
