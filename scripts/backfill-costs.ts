#!/usr/bin/env npx tsx
/**
 * Backfill cost_usd for historical LLM spans that have tokens but no cost.
 * Reads cacheRead/cacheWrite from the metadata JSON column.
 *
 * Usage:
 *   npx tsx scripts/backfill-costs.ts [--dry-run]
 */

import Database from "better-sqlite3";
import path from "node:path";
import { estimateCost, lookupPricing } from "../src/plugin/pricing.js";

const DB_PATH =
  process.env.OPENCLAW_OBS_DB_PATH ||
  path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".openclaw",
    "observability",
    "traces.db",
  );

const dryRun = process.argv.includes("--dry-run");

console.log(`Database: ${DB_PATH}`);
console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
console.log();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Find all LLM spans missing cost but having token data
const rows = db
  .prepare(
    `SELECT id, model, tokens_in, tokens_out, metadata
     FROM spans
     WHERE kind = 'llm'
       AND cost_usd IS NULL
       AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL)`,
  )
  .all() as Array<{
  id: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  metadata: string | null;
}>;

console.log(`Found ${rows.length} LLM spans with tokens but no cost`);

// Stats
let updated = 0;
let skippedNoPricing = 0;
const modelStats = new Map<string, { count: number; totalCost: number }>();

const updateStmt = db.prepare(`UPDATE spans SET cost_usd = ? WHERE id = ?`);

const runUpdate = db.transaction(() => {
  for (const row of rows) {
    // Parse cacheRead/cacheWrite from metadata JSON
    let cacheRead: number | null = null;
    let cacheWrite: number | null = null;
    if (row.metadata) {
      try {
        const meta = JSON.parse(row.metadata);
        cacheRead = typeof meta.cacheRead === "number" ? meta.cacheRead : null;
        cacheWrite = typeof meta.cacheWrite === "number" ? meta.cacheWrite : null;
      } catch {
        // ignore parse errors
      }
    }

    const cost = estimateCost({
      model: row.model,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      cacheRead,
      cacheWrite,
    });

    if (cost === null) {
      skippedNoPricing++;
      continue;
    }

    if (!dryRun) {
      updateStmt.run(cost, row.id);
    }
    updated++;

    const modelKey = row.model || "unknown";
    const stats = modelStats.get(modelKey) || { count: 0, totalCost: 0 };
    stats.count++;
    stats.totalCost += cost;
    modelStats.set(modelKey, stats);
  }
});

runUpdate();

console.log();
console.log(`Results:`);
console.log(`  Updated: ${updated}`);
console.log(`  Skipped (no pricing): ${skippedNoPricing}`);
console.log();

if (modelStats.size > 0) {
  console.log(`Breakdown by model:`);
  const sorted = [...modelStats.entries()].sort((a, b) => b[1].totalCost - a[1].totalCost);
  for (const [model, stats] of sorted) {
    const pricing = lookupPricing(model);
    const pricingNote = pricing ? "" : " [NO PRICING]";
    console.log(
      `  ${model}: ${stats.count} spans, $${stats.totalCost.toFixed(4)}${pricingNote}`,
    );
  }
  const grandTotal = sorted.reduce((sum, [, s]) => sum + s.totalCost, 0);
  console.log();
  console.log(`  Total cost backfilled: $${grandTotal.toFixed(4)}`);
}

db.close();
console.log();
console.log(dryRun ? "Dry run complete. Run without --dry-run to apply." : "Done.");
