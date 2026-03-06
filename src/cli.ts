#!/usr/bin/env node

import { startServer } from "./server/index.js";
import { getDb, closeDb, pruneOldTraces, pruneBySize } from "./plugin/db.js";

async function main() {
  // Initialize DB (creates schema, runs WAL pragma)
  try {
    getDb();
  } catch (err) {
    console.error("[openclaw-obs] Failed to initialize database:", err);
    process.exit(1);
  }

  // Prune on startup
  try {
    const deleted = pruneOldTraces() + pruneBySize();
    if (deleted > 0) {
      console.log(`[openclaw-obs] Pruned ${deleted} expired traces`);
    }
  } catch (err) {
    console.error("[openclaw-obs] Prune on startup failed:", err);
  }

  // Start server
  const { port, close } = await startServer();

  // Try to open browser
  try {
    const url = `http://127.0.0.1:${port}`;
    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd);
  } catch {
    // Browser open is best-effort
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[openclaw-obs] Shutting down...");
    close();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[openclaw-obs] Fatal error:", err);
  process.exit(1);
});
