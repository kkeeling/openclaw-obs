#!/usr/bin/env npx tsx
/**
 * Batch Annotator: Reads a work queue, formats traces, sends each to
 * Claude Sonnet for evaluation against the rubric, and writes annotations
 * to the obs API.
 *
 * Usage:
 *   npx tsx scripts/annotate-batch.ts [--batch-size 20] [--queue work-queue.json] [--dry-run]
 *
 * Environment:
 *   ANTHROPIC_API_KEY  — required
 *   OBS_PORT           — obs server port (default: 19100)
 *   EVAL_MODEL         — model to use (default: anthropic/claude-sonnet-4-5)
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { formatTrace } from "./format-trace.js";

const OBS_PORT = parseInt(process.env.OBS_PORT || "19100", 10);
const OBS_BASE = `http://localhost:${OBS_PORT}`;
const ANNOTATOR_ID = "neutral-annotator-v1";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

interface WorkQueue {
  generated_at: string;
  total_unannotated: number;
  sampled: number;
  traces: Array<{
    id: string;
    category: string;
    agent_name: string;
    total_cost: number;
  }>;
}

interface EvalResult {
  verdict: "pass" | "fail" | "flag";
  notes: string;
  failure_category: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let batchSize = 20;
  let queuePath = path.join(path.dirname(new URL(import.meta.url).pathname), "work-queue.json");
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch-size" && args[i + 1]) {
      batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--queue" && args[i + 1]) {
      queuePath = args[i + 1];
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { batchSize, queuePath, dryRun };
}

function loadRubric(): string {
  const rubricPath = path.join(path.dirname(new URL(import.meta.url).pathname), "eval-rubric.md");
  return fs.readFileSync(rubricPath, "utf-8");
}

function parseEvalResponse(text: string): EvalResult {
  let jsonStr = text.trim();
  // Strip markdown fences
  jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```\s*$/, "").trim();
  // Extract JSON object if surrounded by prose
  const jsonMatch = jsonStr.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  const parsed = JSON.parse(jsonStr) as EvalResult;
  if (!["pass", "fail", "flag"].includes(parsed.verdict)) {
    throw new Error(`Invalid verdict: ${parsed.verdict}`);
  }
  return {
    verdict: parsed.verdict,
    notes: parsed.notes || "",
    failure_category: parsed.failure_category || null,
  };
}

async function evaluateTrace(
  client: Anthropic,
  model: string,
  rubric: string,
  traceMarkdown: string,
): Promise<EvalResult> {
  const MAX_RETRIES = 2; // initial + 1 retry
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Evaluate this trace:\n\n${traceMarkdown}` },
  ];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: rubric,
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    try {
      return parseEvalResponse(text);
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        // Retry: append the bad response + correction nudge
        console.warn(`[annotate] Parse failed (attempt ${attempt + 1}), retrying with nudge...`);
        messages.push(
          { role: "assistant", content: text },
          { role: "user", content: "Your response was not valid JSON. Respond with ONLY a JSON object: {\"verdict\": \"pass|fail|flag\", \"notes\": \"...\", \"failure_category\": null}. No other text." },
        );
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      // Final attempt failed
      console.warn(`[annotate] Failed to parse after ${MAX_RETRIES} attempts. Raw: ${text.slice(0, 200)}`);
      return {
        verdict: "flag",
        notes: `[parse_error] Could not parse evaluator response after ${MAX_RETRIES} attempts.\nRaw output: ${text.slice(0, 500)}`,
        failure_category: null,
      };
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error("Unreachable");
}

async function writeAnnotation(
  traceId: string,
  result: EvalResult,
): Promise<void> {
  const resp = await fetch(`${OBS_BASE}/api/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trace_id: traceId,
      annotator_id: ANNOTATOR_ID,
      verdict: result.verdict,
      failure_category: result.failure_category,
      notes: result.notes,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to write annotation: ${resp.status} ${body}`);
  }
}

async function main() {
  const { batchSize, queuePath, dryRun } = parseArgs();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[annotate] ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  // Load queue
  if (!fs.existsSync(queuePath)) {
    console.error(`[annotate] Queue file not found: ${queuePath}`);
    console.error("  Run sample-traces.ts first to generate the work queue.");
    process.exit(1);
  }

  const queue: WorkQueue = JSON.parse(fs.readFileSync(queuePath, "utf-8"));
  const rubric = loadRubric();
  const model = (process.env.EVAL_MODEL || DEFAULT_MODEL).replace("anthropic/", "");

  const client = new Anthropic();

  // Track processed IDs to update queue after
  const processedPath = queuePath.replace(".json", "-processed.json");
  const processed: Set<string> = new Set();
  if (fs.existsSync(processedPath)) {
    const prev = JSON.parse(fs.readFileSync(processedPath, "utf-8")) as string[];
    prev.forEach((id) => processed.add(id));
  }

  // Filter out already-processed traces
  const remaining = queue.traces.filter((t) => !processed.has(t.id));
  const batch = remaining.slice(0, batchSize);

  console.log(`[annotate] Queue: ${queue.sampled} total, ${remaining.length} remaining, processing ${batch.length}`);
  console.log(`[annotate] Model: ${model} | Dry run: ${dryRun}`);

  const stats = { pass: 0, fail: 0, flag: 0, errors: 0 };

  for (let i = 0; i < batch.length; i++) {
    const trace = batch[i];
    const prefix = `[${i + 1}/${batch.length}]`;

    try {
      // Format the trace
      const formatted = formatTrace(trace.id);

      console.log(`${prefix} Evaluating ${trace.id} (${trace.category}, ${trace.agent_name}, $${trace.total_cost.toFixed(4)})`);

      if (dryRun) {
        console.log(`${prefix} [DRY RUN] Would send ${formatted.markdown.length} chars to ${model}`);
        processed.add(trace.id);
        continue;
      }

      // Evaluate
      const result = await evaluateTrace(client, model, rubric, formatted.markdown);

      // Write annotation
      await writeAnnotation(trace.id, result);

      stats[result.verdict]++;
      processed.add(trace.id);

      const firstNote = result.notes.split("\n")[0];
      console.log(`${prefix} [${result.verdict.toUpperCase()}] ${firstNote}`);

      // Brief pause to avoid rate limits
      if (i < batch.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      stats.errors++;
      console.error(`${prefix} ERROR on ${trace.id}:`, (err as Error).message);
      // Continue with next trace
    }
  }

  // Save processed IDs
  fs.writeFileSync(processedPath, JSON.stringify([...processed], null, 2));

  console.log("\n[annotate] Batch complete:");
  console.log(`  pass: ${stats.pass}, fail: ${stats.fail}, flag: ${stats.flag}, errors: ${stats.errors}`);
  console.log(`  Total processed: ${processed.size}/${queue.sampled}`);
}

main().catch((err) => {
  console.error("[annotate] Fatal:", err);
  process.exit(1);
});
