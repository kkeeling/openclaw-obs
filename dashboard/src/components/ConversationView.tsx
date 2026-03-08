import { useState } from "react";
import type { MessageRow, SpanRow } from "../hooks/useApi";

interface ConversationViewProps {
  messages: MessageRow[];
  spans: SpanRow[];
}

const ROLE_STYLES: Record<string, { bg: string; align: string; label: string; icon: string }> = {
  user: {
    bg: "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800",
    align: "ml-auto",
    label: "User",
    icon: "👤",
  },
  assistant: {
    bg: "bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-800",
    align: "mr-auto",
    label: "Assistant",
    icon: "🤖",
  },
  system: {
    bg: "bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800",
    align: "mx-auto",
    label: "System",
    icon: "⚙️",
  },
  tool_call: {
    bg: "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800",
    align: "mx-auto",
    label: "Tool Call",
    icon: "🔧",
  },
  tool_result: {
    bg: "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800",
    align: "mx-auto",
    label: "Tool Result",
    icon: "📋",
  },
};

const PREVIEW_CHARS = 500;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ContentBlock({ content, role }: { content: string | null; role: string }) {
  const [expanded, setExpanded] = useState(false);

  if (!content) return <span className="text-gray-400 italic">No content</span>;

  const isJson = role === "tool_call" || role === "tool_result";
  const isLong = content.length > PREVIEW_CHARS;
  const displayContent = !expanded && isLong ? content.slice(0, PREVIEW_CHARS) + "…" : content;

  // Try to pretty-print JSON for tool calls/results
  let formatted = displayContent;
  if (isJson) {
    try {
      const parsed = JSON.parse(displayContent);
      formatted = JSON.stringify(parsed, null, 2);
    } catch {
      // Not valid JSON, show as-is
    }
  }

  return (
    <div>
      <pre className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${isJson ? "font-mono text-xs" : ""}`}>
        {formatted}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-accent text-xs mt-1 hover:underline"
        >
          {expanded ? "Show less" : `Show more (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function ToolCallCard({ message }: { message: MessageRow }) {
  const [expanded, setExpanded] = useState(false);
  const style = ROLE_STYLES[message.role] || ROLE_STYLES.tool_call;

  return (
    <div className={`mx-4 my-1 ${style.align}`}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium ${style.bg} hover:opacity-80 transition-opacity w-full text-left`}
      >
        <span>{style.icon}</span>
        <span>{message.role === "tool_call" ? "→" : "←"} {message.tool_name || "unknown"}</span>
        <span className="ml-auto text-gray-400">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className={`mt-1 px-3 py-2 rounded-b-lg border border-t-0 ${style.bg} max-h-80 overflow-auto`}>
          <ContentBlock content={message.content} role={message.role} />
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: MessageRow }) {
  const style = ROLE_STYLES[message.role] || ROLE_STYLES.assistant;

  // Tool calls/results render as compact cards
  if (message.role === "tool_call" || message.role === "tool_result") {
    return <ToolCallCard message={message} />;
  }

  // System messages render centered and muted
  if (message.role === "system") {
    return (
      <div className="mx-auto max-w-[85%] my-2">
        <div className={`px-4 py-2 rounded-lg border ${style.bg} text-xs text-gray-500 dark:text-gray-400`}>
          <div className="flex items-center gap-1.5 mb-1 font-medium">
            <span>{style.icon}</span>
            <span>{style.label}</span>
            <span className="ml-auto text-gray-400">{formatTime(message.timestamp)}</span>
          </div>
          <ContentBlock content={message.content} role={message.role} />
        </div>
      </div>
    );
  }

  // User and assistant messages render as chat bubbles
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} my-2 px-4`}>
      <div className={`max-w-[80%] ${style.bg} border rounded-lg px-4 py-2.5`}>
        <div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
          <span>{style.icon}</span>
          <span>{style.label}</span>
          {message.metadata && (() => {
            try {
              const meta = JSON.parse(message.metadata);
              if (meta.model) return <span className="font-mono">· {meta.model}</span>;
            } catch { /* ignore */ }
            return null;
          })()}
          <span className="ml-auto">{formatTime(message.timestamp)}</span>
        </div>
        <ContentBlock content={message.content} role={message.role} />
      </div>
    </div>
  );
}

export default function ConversationView({ messages, spans: _spans }: ConversationViewProps) {
  if (messages.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 dark:text-gray-600">
        <p className="text-lg mb-1">No conversation data</p>
        <p className="text-sm">Conversation messages will appear here once captured.</p>
        <p className="text-xs mt-2">Messages are captured via llm_input/llm_output hooks on new sessions.</p>
      </div>
    );
  }

  return (
    <div className="py-4 space-y-0.5 max-w-4xl mx-auto">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  );
}
