import { Router, type Request, type Response } from "express";
import {
  listTraces,
  getTrace,
  getStats,
  getHealth,
  pruneAll,
} from "../plugin/db.js";

export function createRouter(): Router {
  const router = Router();

  // GET /api/traces - List traces with filters
  router.get("/api/traces", (req: Request, res: Response) => {
    try {
      const params = {
        status: req.query.status as string | undefined,
        agent: req.query.agent as string | undefined,
        model: req.query.model as string | undefined,
        since: req.query.since ? Number(req.query.since) : undefined,
        until: req.query.until ? Number(req.query.until) : undefined,
        minCost: req.query.minCost ? Number(req.query.minCost) : undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      };
      const traces = listTraces(params);
      res.json(traces);
    } catch (err) {
      console.error("[openclaw-obs] GET /api/traces error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/traces/:id - Get single trace with spans
  router.get("/api/traces/:id", (req: Request, res: Response) => {
    try {
      const trace = getTrace(req.params.id as string);
      if (!trace) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }
      res.json(trace);
    } catch (err) {
      console.error("[openclaw-obs] GET /api/traces/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/stats - Aggregated analytics
  router.get("/api/stats", (req: Request, res: Response) => {
    try {
      const params = {
        since: req.query.since ? Number(req.query.since) : undefined,
        until: req.query.until ? Number(req.query.until) : undefined,
      };
      const stats = getStats(params);
      res.json(stats);
    } catch (err) {
      console.error("[openclaw-obs] GET /api/stats error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/prune - Manual prune + VACUUM
  router.post("/api/prune", (_req: Request, res: Response) => {
    try {
      const result = pruneAll();
      res.json({
        deleted: result.deleted,
        db_size_bytes: result.dbSizeBytes,
      });
    } catch (err) {
      console.error("[openclaw-obs] POST /api/prune error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/health - Health check
  router.get("/api/health", (_req: Request, res: Response) => {
    try {
      const health = getHealth();
      res.json(health);
    } catch (err) {
      console.error("[openclaw-obs] GET /api/health error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
