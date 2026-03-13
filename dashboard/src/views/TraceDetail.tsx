import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Waterfall from "../components/Waterfall";
import ConversationView from "../components/ConversationView";
import SubAgentLinks from "../components/SubAgentLinks";
import { useTraceDetail, createAnnotation, type AnnotationRow } from "../hooks/useApi";

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === "success"
      ? "bg-green-100 text-status-success dark:bg-green-950 dark:text-green-400"
      : status === "error"
        ? "bg-red-100 text-status-error dark:bg-red-950 dark:text-red-400"
        : "bg-blue-100 text-status-running dark:bg-blue-950 dark:text-blue-400";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles}`}>
      {status}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function AnnotatePanel({ traceId, annotations, onAnnotated }: { traceId: string; annotations: AnnotationRow[]; onAnnotated: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [verdict, setVerdict] = useState<string>("pass");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await createAnnotation({
        trace_id: traceId,
        annotator_id: "dashboard-user",
        verdict,
        failure_category: category || undefined,
        notes: notes || undefined,
      });
      setShowForm(false);
      setVerdict("pass");
      setCategory("");
      setNotes("");
      onAnnotated();
    } catch (err) {
      console.error("Failed to create annotation:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const verdictColors: Record<string, string> = {
    pass: "text-green-600 dark:text-green-400",
    fail: "text-red-600 dark:text-red-400",
    interesting: "text-yellow-600 dark:text-yellow-400",
  };
  const verdictEmoji: Record<string, string> = { pass: "✓", fail: "✗", interesting: "★" };

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          📝 Annotations
          {annotations.length > 0 && (
            <span className="text-xs bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">{annotations.length}</span>
          )}
        </h2>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-xs px-2 py-1 bg-accent text-white rounded hover:bg-accent/90 transition-colors"
          >
            + Annotate
          </button>
        )}
      </div>

      {/* Existing annotations */}
      {annotations.length > 0 && (
        <div className="space-y-2 mb-3">
          {annotations.map((a) => (
            <div key={a.id} className="text-sm border border-gray-100 dark:border-gray-800 rounded p-2">
              <div className="flex items-center gap-2">
                <span className={`font-medium ${verdictColors[a.verdict] || ""}`}>
                  {verdictEmoji[a.verdict] || "?"} {a.verdict}
                </span>
                {a.failure_category && (
                  <span className="text-xs bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 px-1.5 py-0.5 rounded">
                    {a.failure_category}
                  </span>
                )}
                <span className="text-xs text-gray-400 ml-auto">{a.annotator_id} · {new Date(a.created_at).toLocaleString()}</span>
              </div>
              {a.notes && <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{a.notes}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Annotation form */}
      {showForm && (
        <div className="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3">
          <div className="flex gap-2">
            {["pass", "fail", "interesting"].map((v) => (
              <button
                key={v}
                onClick={() => setVerdict(v)}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  verdict === v
                    ? v === "pass" ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400"
                    : v === "fail" ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400"
                    : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400"
                    : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                }`}
              >
                {verdictEmoji[v]} {v}
              </button>
            ))}
          </div>
          {verdict === "fail" && (
            <input
              type="text"
              placeholder="Failure category (e.g. hallucination, wrong_tool, incomplete)"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-transparent"
            />
          )}
          <textarea
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-transparent resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="text-xs px-3 py-1 bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50"
            >
              {submitting ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-xs px-3 py-1 text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type TabId = "conversation" | "timeline";

export default function TraceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: trace, loading, refresh } = useTraceDetail(id!);
  const [activeTab, setActiveTab] = useState<TabId>("conversation");

  if (loading && !trace) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto space-y-4">
        <div className="skeleton h-4 w-48" />
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  if (!trace) {
    return (
      <div className="p-6 text-center py-16 text-gray-400">
        <p className="text-lg">Trace not found</p>
        <button
          onClick={() => navigate("/traces")}
          className="mt-4 text-accent hover:underline"
        >
          Back to Traces
        </button>
      </div>
    );
  }

  const totalCost = trace.spans.reduce((sum, s) => sum + (s.cost_usd || 0), 0);
  const totalTokensIn = trace.spans.reduce((sum, s) => sum + (s.tokens_in || 0), 0);
  const totalTokensOut = trace.spans.reduce((sum, s) => sum + (s.tokens_out || 0), 0);
  const duration = trace.ended_at ? trace.ended_at - trace.started_at : null;
  const traceEnd = trace.ended_at || Math.max(
    trace.started_at,
    ...trace.spans.map((s) => s.ended_at || s.started_at),
  );

  const models = [...new Set(trace.spans.filter((s) => s.model).map((s) => s.model!))];
  const hasChildren = trace.children && trace.children.length > 0;
  const hasParent = !!trace.parent_trace_id;

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: "conversation", label: "Conversation", count: trace.messages?.length || 0 },
    { id: "timeline", label: "Timeline", count: trace.spans.length },
  ];

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-4">
      {/* Breadcrumb */}
      <nav className="text-sm">
        <button
          onClick={() => navigate("/traces")}
          className="text-accent hover:underline"
        >
          Traces
        </button>
        <span className="mx-2 text-gray-400">/</span>
        <span className="text-gray-600 dark:text-gray-400 font-mono">{trace.id.slice(0, 12)}...</span>
      </nav>

      {/* Summary Card */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-lg font-semibold">{trace.agent_name}</h1>
          <StatusBadge status={trace.status} />
          {hasParent && (
            <span className="text-xs text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/30 px-2 py-0.5 rounded">
              Sub-agent
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Session ID</p>
            <p className="font-mono text-xs mt-0.5 break-all">{trace.session_id}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Duration</p>
            <p className="font-mono mt-0.5">{duration != null ? formatDuration(duration) : "running"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Cost</p>
            <p className="font-mono mt-0.5">{formatCost(totalCost)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Models</p>
            <p className="font-mono text-xs mt-0.5">{models.join(", ") || "-"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Started</p>
            <p className="text-xs mt-0.5">{formatTimestamp(trace.started_at)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Ended</p>
            <p className="text-xs mt-0.5">{trace.ended_at ? formatTimestamp(trace.ended_at) : "-"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Tokens In / Out</p>
            <p className="font-mono text-xs mt-0.5">
              {totalTokensIn.toLocaleString()} / {totalTokensOut.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Messages</p>
            <p className="font-mono mt-0.5">{trace.messages?.length || 0}</p>
          </div>
        </div>
      </div>

      {/* Annotations */}
      <AnnotatePanel
        traceId={trace.id}
        annotations={trace.annotations || []}
        onAnnotated={refresh}
      />

      {/* Sub-agent links */}
      {(hasParent || hasChildren) && (
        <SubAgentLinks
          parentTraceId={trace.parent_trace_id}
          children={trace.children || []}
        />
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-800">
        <div className="flex gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-accent text-accent"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="ml-1.5 text-xs text-gray-400">({tab.count})</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "conversation" ? (
        <ConversationView
          messages={trace.messages || []}
          spans={trace.spans}
        />
      ) : (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-gray-600 dark:text-gray-400">
              Timeline ({trace.spans.length} spans)
            </h2>
            <span className="text-sm font-mono text-gray-500">{formatCost(totalCost)}</span>
          </div>
          <Waterfall
            spans={trace.spans}
            traceStart={trace.started_at}
            traceEnd={traceEnd}
          />
        </div>
      )}
    </div>
  );
}
