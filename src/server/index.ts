import express from "express";
import path from "node:path";
import net from "node:net";
import { createRouter } from "./routes.js";

const BASE_PORT = parseInt(process.env.OPENCLAW_OBS_PORT || "19100", 10);
const MAX_PORT_ATTEMPTS = 10;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function findAvailablePort(): Promise<number> {
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = BASE_PORT + i;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(
    `No available port found in range ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}`,
  );
}

export async function startServer(): Promise<{ port: number; close: () => void }> {
  const app = express();
  app.use(express.json());

  // API routes
  app.use(createRouter());

  // Static files — serve built dashboard
  const dashboardDist = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "dashboard",
    "dist",
  );
  app.use(express.static(dashboardDist));

  // SPA fallback — serve index.html for non-API routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });

  const port = await findAvailablePort();

  return new Promise((resolve) => {
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`[openclaw-obs] Dashboard running at http://127.0.0.1:${port}`);
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}
