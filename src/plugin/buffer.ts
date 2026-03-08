type FlushCallback = (events: BufferedEvent[]) => void;

export interface BufferedEvent {
  type: "trace" | "span" | "trace_update" | "span_update" | "message";
  data: Record<string, unknown>;
}

const FLUSH_INTERVAL_MS = 100;
const FLUSH_THRESHOLD = 50;

export class EventBuffer {
  private queue: BufferedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushFn: FlushCallback;

  constructor(flushFn: FlushCallback) {
    this.flushFn = flushFn;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // Allow process to exit even if timer is running
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  push(event: BufferedEvent): void {
    this.queue.push(event);
    if (this.queue.length >= FLUSH_THRESHOLD) {
      this.flush();
    }
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    try {
      this.flushFn(batch);
    } catch (err) {
      console.error("[openclaw-obs] Flush error:", err);
    }
  }
}
