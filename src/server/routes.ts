import { Router, type Request, type Response } from "express";
import {
  listTraces,
  getTrace,
  getMessages,
  getStats,
  getHealth,
  pruneAll,
  createAnnotation,
  bulkCreateAnnotations,
  getAnnotation,
  updateAnnotation,
  deleteAnnotation,
  listAnnotations,
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
        verdict: req.query.verdict as string | undefined,
        annotated: req.query.annotated === "true" ? true : req.query.annotated === "false" ? false : undefined,
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

  // GET /api/traces/:id - Get single trace with spans, messages, children
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

  // GET /api/traces/:id/messages - Get messages for a trace
  router.get("/api/traces/:id/messages", (req: Request, res: Response) => {
    try {
      const messages = getMessages(req.params.id as string);
      res.json(messages);
    } catch (err) {
      console.error("[openclaw-obs] GET /api/traces/:id/messages error:", err);
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

  // ---- Annotation Endpoints ----

  // GET /api/annotations - List annotations with filters
  router.get("/api/annotations", (req: Request, res: Response) => {
    try {
      const params = {
        traceId: req.query.traceId as string | undefined,
        annotatorId: req.query.annotatorId as string | undefined,
        verdict: req.query.verdict as string | undefined,
        since: req.query.since ? Number(req.query.since) : undefined,
        until: req.query.until ? Number(req.query.until) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      };
      const annotations = listAnnotations(params);
      res.json(annotations);
    } catch (err) {
      console.error("[openclaw-obs] GET /api/annotations error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/annotations - Create a single annotation
  router.post("/api/annotations", (req: Request, res: Response) => {
    try {
      const { trace_id, annotator_id, verdict, failure_category, notes } = req.body;
      if (!trace_id || !annotator_id || !verdict) {
        res.status(400).json({ error: "trace_id, annotator_id, and verdict are required" });
        return;
      }
      if (!["pass", "fail", "flag"].includes(verdict)) {
        res.status(400).json({ error: "verdict must be 'pass', 'fail', or 'flag'" });
        return;
      }
      const annotation = createAnnotation({
        trace_id,
        annotator_id,
        verdict,
        failure_category: failure_category ?? null,
        notes: notes ?? null,
        created_at: Date.now(),
      });
      res.status(201).json(annotation);
    } catch (err) {
      console.error("[openclaw-obs] POST /api/annotations error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/annotations/bulk - Bulk create annotations
  router.post("/api/annotations/bulk", (req: Request, res: Response) => {
    try {
      const { annotations: items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: "annotations array is required" });
        return;
      }
      const now = Date.now();
      const toCreate = items.map((item: Record<string, unknown>) => ({
        trace_id: item.trace_id as string,
        annotator_id: item.annotator_id as string,
        verdict: item.verdict as string,
        failure_category: (item.failure_category as string) ?? null,
        notes: (item.notes as string) ?? null,
        created_at: now,
      }));
      // Validate all items
      for (const item of toCreate) {
        if (!item.trace_id || !item.annotator_id || !item.verdict) {
          res.status(400).json({ error: "Each annotation requires trace_id, annotator_id, and verdict" });
          return;
        }
        if (!["pass", "fail", "flag"].includes(item.verdict)) {
          res.status(400).json({ error: "verdict must be 'pass', 'fail', or 'flag'" });
          return;
        }
      }
      const created = bulkCreateAnnotations(toCreate);
      res.status(201).json({ created: created.length, annotations: created });
    } catch (err) {
      console.error("[openclaw-obs] POST /api/annotations/bulk error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/annotations/:id - Get single annotation
  router.get("/api/annotations/:id", (req: Request, res: Response) => {
    try {
      const annotation = getAnnotation(Number(req.params.id));
      if (!annotation) {
        res.status(404).json({ error: "Annotation not found" });
        return;
      }
      res.json(annotation);
    } catch (err) {
      console.error("[openclaw-obs] GET /api/annotations/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/annotations/:id - Update annotation
  router.patch("/api/annotations/:id", (req: Request, res: Response) => {
    try {
      const { verdict, failure_category, notes } = req.body;
      const updates: Record<string, unknown> = {};
      if (verdict !== undefined) {
        if (!["pass", "fail", "flag"].includes(verdict)) {
          res.status(400).json({ error: "verdict must be 'pass', 'fail', or 'flag'" });
          return;
        }
        updates.verdict = verdict;
      }
      if (failure_category !== undefined) updates.failure_category = failure_category;
      if (notes !== undefined) updates.notes = notes;

      updateAnnotation(Number(req.params.id), updates);
      const updated = getAnnotation(Number(req.params.id));
      res.json(updated);
    } catch (err) {
      console.error("[openclaw-obs] PATCH /api/annotations/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/annotations/:id - Delete annotation
  router.delete("/api/annotations/:id", (req: Request, res: Response) => {
    try {
      deleteAnnotation(Number(req.params.id));
      res.status(204).send();
    } catch (err) {
      console.error("[openclaw-obs] DELETE /api/annotations/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
