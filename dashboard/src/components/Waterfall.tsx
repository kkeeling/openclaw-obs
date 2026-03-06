import { useState } from "react";
import type { SpanRow } from "../hooks/useApi";

interface WaterfallProps {
  spans: SpanRow[];
  traceStart: number;
  traceEnd: number;
}

const KIND_ICONS: Record<string, string> = {
  llm: "\u{1F9E0}",
  tool: "\u{1F527}",
  subagent: "\u{1F916}",
};

const KIND_COLORS: Record<string, string> = {
  llm: "bg-blue-500",
  tool: "bg-emerald-500",
  subagent: "bg-purple-500",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatCost(usd: number | null): string {
  if (usd == null) return "-";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number | null): string {
  if (n == null) return "-";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function truncateText(text: string | null, maxLen: number): { truncated: string; isTruncated: boolean } {
  if (!text) return { truncated: "", isTruncated: false };
  if (text.length <= maxLen) return { truncated: text, isTruncated: false };
  return { truncated: text.slice(0, maxLen) + "...", isTruncated: true };
}

interface SpanNode {
  span: SpanRow;
  children: SpanNode[];
  depth: number;
}

function buildTree(spans: SpanRow[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  const roots: SpanNode[] = [];

  for (const span of spans) {
    byId.set(span.id, { span, children: [], depth: 0 });
  }

  for (const span of spans) {
    const node = byId.get(span.id)!;
    if (span.parent_span_id && byId.has(span.parent_span_id)) {
      const parent = byId.get(span.parent_span_id)!;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function flatten(nodes: SpanNode[]): SpanNode[] {
    const result: SpanNode[] = [];
    for (const node of nodes) {
      result.push(node);
      result.push(...flatten(node.children));
    }
    return result;
  }

  return flatten(roots);
}

function SpanDetail({ span }: { span: SpanRow }) {
  const [showFullInput, setShowFullInput] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);

  const input = truncateText(span.input_json, 200);
  const output = truncateText(span.output_json, 200);

  return (
    <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 text-xs space-y-2">
      <div className="flex gap-6">
        <div>
          <span className="text-gray-500">Tokens In:</span>{" "}
          <span className="font-mono">{formatTokens(span.tokens_in)}</span>
        </div>
        <div>
          <span className="text-gray-500">Tokens Out:</span>{" "}
          <span className="font-mono">{formatTokens(span.tokens_out)}</span>
        </div>
        <div>
          <span className="text-gray-500">Cost:</span>{" "}
          <span className="font-mono">{formatCost(span.cost_usd)}</span>
        </div>
        {span.model && (
          <div>
            <span className="text-gray-500">Model:</span>{" "}
            <span className="font-mono">{span.model}</span>
          </div>
        )}
      </div>

      {span.error && (
        <div className="text-status-error bg-red-50 dark:bg-red-950/30 p-2 rounded font-mono break-all">
          {span.error}
        </div>
      )}

      {span.input_json && (
        <div>
          <p className="text-gray-500 mb-1">Input:</p>
          <pre className="font-mono text-xs bg-white dark:bg-gray-950 p-2 rounded border border-gray-200 dark:border-gray-800 whitespace-pre-wrap break-all max-h-60 overflow-auto">
            {showFullInput ? span.input_json : input.truncated}
          </pre>
          {input.isTruncated && (
            <button
              onClick={() => setShowFullInput((s) => !s)}
              className="text-accent text-xs mt-1 hover:underline"
            >
              {showFullInput ? "Show less" : "Show full"}
            </button>
          )}
        </div>
      )}

      {span.output_json && (
        <div>
          <p className="text-gray-500 mb-1">Output:</p>
          <pre className="font-mono text-xs bg-white dark:bg-gray-950 p-2 rounded border border-gray-200 dark:border-gray-800 whitespace-pre-wrap break-all max-h-60 overflow-auto">
            {showFullOutput ? span.output_json : output.truncated}
          </pre>
          {output.isTruncated && (
            <button
              onClick={() => setShowFullOutput((s) => !s)}
              className="text-accent text-xs mt-1 hover:underline"
            >
              {showFullOutput ? "Show less" : "Show full"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Waterfall({ spans, traceStart, traceEnd }: WaterfallProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const totalDuration = Math.max(traceEnd - traceStart, 1);
  const flatSpans = buildTree(spans);

  if (spans.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 dark:text-gray-600">
        <p className="text-lg mb-1">No spans recorded</p>
        <p className="text-sm">This trace has no span data.</p>
      </div>
    );
  }

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center bg-gray-100 dark:bg-gray-900 px-4 py-2 text-xs text-gray-500 font-medium border-b border-gray-200 dark:border-gray-800">
        <div className="w-[300px] shrink-0">Span</div>
        <div className="flex-1">Timeline</div>
      </div>

      {/* Rows */}
      {flatSpans.map(({ span, depth }) => {
        const spanStart = span.started_at - traceStart;
        const spanEnd = (span.ended_at ?? traceEnd) - traceStart;
        const leftPct = (spanStart / totalDuration) * 100;
        const widthPct = Math.max(((spanEnd - spanStart) / totalDuration) * 100, 0.5);
        const expanded = expandedIds.has(span.id);
        const duration = span.ended_at ? span.ended_at - span.started_at : null;

        return (
          <div key={span.id}>
            <div
              className="flex items-center hover:bg-gray-50 dark:hover:bg-gray-900/50 cursor-pointer transition-colors duration-100 border-b border-gray-100 dark:border-gray-800/50"
              onClick={() => toggle(span.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && toggle(span.id)}
            >
              {/* Span info */}
              <div
                className="w-[300px] shrink-0 flex items-center gap-1.5 px-4 py-2 text-sm truncate"
                style={{ paddingLeft: `${depth * 20 + 16}px` }}
              >
                <span className="text-base leading-none" aria-hidden>
                  {KIND_ICONS[span.kind] || "\u{2B50}"}
                </span>
                <span className="truncate font-mono text-xs">{span.name}</span>
                {duration != null && (
                  <span className="text-xs text-gray-400 ml-auto shrink-0">
                    {formatDuration(duration)}
                  </span>
                )}
              </div>

              {/* Timeline bar */}
              <div className="flex-1 h-8 relative px-2">
                <div
                  className={`absolute top-1.5 h-5 rounded ${KIND_COLORS[span.kind] || "bg-gray-400"} opacity-80`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: "2px" }}
                />
              </div>
            </div>

            {/* Expanded detail */}
            {expanded && <SpanDetail span={span} />}
          </div>
        );
      })}
    </div>
  );
}
