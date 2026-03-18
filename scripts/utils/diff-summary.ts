#!/usr/bin/env npx tsx
/**
 * Diff Summary — compare old and new PricingData, produce a text summary.
 *
 * As a library:
 *   import { generateChangeSummary, formatSummaryText } from './diff-summary.js';
 *
 * As a CLI (compares data/pricing.json with git HEAD version):
 *   npx tsx scripts/utils/diff-summary.ts
 */

import type { PricingData, ModelPricing } from '../lib/schema.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChangeSummary {
  added: Array<{ provider: string; modelId: string; input?: number; output?: number }>;
  removed: Array<{ provider: string; modelId: string }>;
  priceChanged: Array<{
    provider: string;
    modelId: string;
    field: string;
    oldValue: number;
    newValue: number;
    changePercent: number;
  }>;
  unchangedCount: number;
  timestamp: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a per-token price as $/MTok for display */
function fmtMTok(perToken: number | undefined): string {
  if (perToken == null) return '?';
  const perMTok = perToken * 1e6;
  if (perMTok >= 1) return `$${perMTok.toFixed(2)}`;
  if (perMTok >= 0.01) return `$${perMTok.toFixed(4)}`;
  return `$${perMTok.toPrecision(3)}`;
}

/** Price fields to compare between old and new entries */
const PRICE_FIELDS: Array<{ key: keyof ModelPricing; label: string }> = [
  { key: 'inputCostPerToken', label: 'input' },
  { key: 'outputCostPerToken', label: 'output' },
];

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Generate a structured change summary between old and new pricing data.
 * If oldData is null, all models in newData are treated as "added".
 */
export function generateChangeSummary(
  oldData: PricingData | null,
  newData: PricingData,
): ChangeSummary {
  const summary: ChangeSummary = {
    added: [],
    removed: [],
    priceChanged: [],
    unchangedCount: 0,
    timestamp: new Date().toISOString(),
  };

  // Build flat maps: "provider/modelId" → ModelPricing (skip :: keys)
  const oldMap = flattenModels(oldData);
  const newMap = flattenModels(newData);

  // Find added and changed
  for (const [key, newEntry] of newMap.entries()) {
    const oldEntry = oldMap.get(key);
    const [provider, modelId] = splitKey(key);

    if (!oldEntry) {
      summary.added.push({
        provider,
        modelId,
        input: newEntry.inputCostPerToken,
        output: newEntry.outputCostPerToken,
      });
      continue;
    }

    // Compare price fields
    let changed = false;
    for (const { key: field, label } of PRICE_FIELDS) {
      const oldVal = oldEntry[field] as number | undefined;
      const newVal = newEntry[field] as number | undefined;
      if (oldVal != null && newVal != null && oldVal !== newVal) {
        const changePercent = ((newVal - oldVal) / oldVal) * 100;
        summary.priceChanged.push({
          provider,
          modelId,
          field: label,
          oldValue: oldVal,
          newValue: newVal,
          changePercent,
        });
        changed = true;
      }
    }

    if (!changed) {
      summary.unchangedCount++;
    }
  }

  // Find removed
  for (const key of oldMap.keys()) {
    if (!newMap.has(key)) {
      const [provider, modelId] = splitKey(key);
      summary.removed.push({ provider, modelId });
    }
  }

  return summary;
}

function flattenModels(data: PricingData | null): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  if (!data) return map;

  for (const [provider, models] of Object.entries(data.providers)) {
    for (const [modelId, pricing] of Object.entries(models)) {
      if (modelId.includes('::')) continue;
      map.set(`${provider}/${modelId}`, pricing);
    }
  }
  return map;
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf('/');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// ─── Text Formatting ─────────────────────────────────────────────────────────

export function formatSummaryText(summary: ChangeSummary): string {
  const lines: string[] = [];

  // Header line
  const parts: string[] = [];
  if (summary.added.length > 0) parts.push(`+${summary.added.length} models`);
  if (summary.removed.length > 0) parts.push(`-${summary.removed.length} models`);
  if (summary.priceChanged.length > 0) parts.push(`~${summary.priceChanged.length} price changes`);
  if (parts.length === 0) {
    lines.push('No changes detected.');
    return lines.join('\n');
  }
  lines.push(parts.join(', '));
  lines.push('');

  // Added
  for (const a of summary.added) {
    lines.push(`+ ${a.provider}/${a.modelId} (${fmtMTok(a.input)}/${fmtMTok(a.output)} per MTok)`);
  }

  // Removed
  for (const r of summary.removed) {
    lines.push(`- ${r.provider}/${r.modelId} (removed)`);
  }

  // Price changes
  for (const c of summary.priceChanged) {
    const sign = c.changePercent > 0 ? '+' : '';
    lines.push(
      `~ ${c.provider}/${c.modelId} ${c.field}: ${fmtMTok(c.oldValue)} → ${fmtMTok(c.newValue)} (${sign}${c.changePercent.toFixed(1)}%)`,
    );
  }

  return lines.join('\n');
}

// ─── CLI Mode ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const { execSync } = await import('node:child_process');
  const { resolve } = await import('node:path');

  const repoRoot = resolve(import.meta.dirname!, '..', '..');
  const pricingPath = resolve(repoRoot, 'data', 'pricing.json');

  // Read current file
  let newData: PricingData;
  try {
    newData = JSON.parse(await readFile(pricingPath, 'utf-8'));
  } catch {
    console.error('No data/pricing.json found. Nothing to diff.');
    process.exit(1);
  }

  // Read git HEAD version
  let oldData: PricingData | null = null;
  try {
    const gitContent = execSync(`git show HEAD:data/pricing.json`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    oldData = JSON.parse(gitContent);
  } catch {
    console.error('No previous version in git HEAD. Treating all models as new.');
  }

  const summary = generateChangeSummary(oldData, newData);
  console.log(formatSummaryText(summary));
}

// Run CLI if executed directly
const isMain = process.argv[1]?.includes('diff-summary');
if (isMain) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
