import { useNavigate } from "react-router-dom";

interface ChildTrace {
  id: string;
  agent_name: string;
  started_at: number;
  status: string;
}

interface SubAgentLinksProps {
  parentTraceId: string | null;
  children: ChildTrace[];
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "success"
      ? "bg-green-500"
      : status === "error"
        ? "bg-red-500"
        : "bg-blue-500";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export default function SubAgentLinks({ parentTraceId, children }: SubAgentLinksProps) {
  const navigate = useNavigate();

  if (!parentTraceId && children.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">
        🔗 Session Relationships
      </h3>

      {parentTraceId && (
        <div className="mb-3">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Parent Session</span>
          <button
            onClick={() => navigate(`/traces/${parentTraceId}`)}
            className="block mt-1 text-sm text-accent hover:underline font-mono"
          >
            ↑ {parentTraceId.slice(0, 12)}…
          </button>
        </div>
      )}

      {children.length > 0 && (
        <div>
          <span className="text-xs text-gray-500 uppercase tracking-wide">
            Sub-agent Sessions ({children.length})
          </span>
          <div className="mt-1 space-y-1">
            {children.map((child) => (
              <button
                key={child.id}
                onClick={() => navigate(`/traces/${child.id}`)}
                className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-sm"
              >
                <StatusDot status={child.status} />
                <span className="font-medium">{child.agent_name}</span>
                <span className="text-xs text-gray-400 ml-auto">{timeAgo(child.started_at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
