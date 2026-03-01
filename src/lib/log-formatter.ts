/**
 * Log message formatter for `vh logs` and `vh wait`.
 *
 * Three output modes:
 * - `color` — ANSI-colored output for interactive terminals.
 * - `text`  — plain text, no escape codes (pipes, files).
 * - `json`  — raw JSONL passthrough (one JSON object per line).
 */

export type LogFormat = "color" | "text" | "json";

// --- ANSI escape helpers (no third-party deps) ---

const ANSI = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
} as const;

function dim(s: string): string {
  return `${ANSI.dim}${s}${ANSI.reset}`;
}

function boldCyan(s: string): string {
  return `${ANSI.bold}${ANSI.cyan}${s}${ANSI.reset}`;
}

function boldGreen(s: string): string {
  return `${ANSI.bold}${ANSI.green}${s}${ANSI.reset}`;
}

function boldRed(s: string): string {
  return `${ANSI.bold}${ANSI.red}${s}${ANSI.reset}`;
}

// --- Truncation ---

const MAX_LINE_LENGTH = 120;

function truncate(s: string, maxLen: number = MAX_LINE_LENGTH): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

// --- Tool input summarisation ---

type ToolInput = Record<string, unknown>;

function summariseToolInput(toolName: string, input: ToolInput): string {
  switch (toolName) {
    case "Bash":
      return truncate(String(input.command ?? ""));
    case "Read":
    case "Write":
    case "Edit":
      return truncate(String(input.file_path ?? ""));
    case "Glob":
      return truncate(String(input.pattern ?? ""));
    case "Grep": {
      const pattern = String(input.pattern ?? "");
      const path = input.path ? ` ${String(input.path)}` : "";
      return truncate(pattern + path);
    }
    case "WebFetch":
      return truncate(String(input.url ?? ""));
    case "WebSearch":
      return truncate(String(input.query ?? ""));
    case "Agent":
      return truncate(
        String(input.description ?? input.prompt ?? ""),
      );
    default:
      return truncate(firstStringValue(input));
  }
}

/** Return the first string-valued field from an object, or "". */
function firstStringValue(obj: ToolInput): string {
  for (const value of Object.values(obj)) {
    if (typeof value === "string") return value;
  }
  return "";
}

// --- Content block helpers ---

type ContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: ToolInput;
  id?: string;
  [key: string]: unknown;
};

// --- Message type guards ---

function isSystemInit(msg: unknown): msg is {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  cwd: string;
} {
  if (!isObj(msg)) return false;
  return msg.type === "system" && msg.subtype === "init";
}

function isAssistant(msg: unknown): msg is {
  type: "assistant";
  message: { content: ContentBlock[] };
} {
  if (!isObj(msg)) return false;
  return msg.type === "assistant" && isObj((msg as Record<string, unknown>).message);
}

function isResult(msg: unknown): msg is {
  type: "result";
  subtype: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  duration_ms: number;
} {
  if (!isObj(msg)) return false;
  return msg.type === "result";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// --- Format cost ---

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// --- Format duration ---

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${s}s`;
}

// --- Main formatter ---

/**
 * Format a single SDK log message for display.
 *
 * Returns zero or more lines. For `json` mode, returns `[JSON.stringify(msg)]`.
 * The caller joins with `\n` and prints.
 */
export function formatLogMessage(msg: unknown, format: LogFormat): string[] {
  if (format === "json") {
    return [JSON.stringify(msg)];
  }

  // color and text share the same structure; color wraps with ANSI codes.
  const useColor = format === "color";

  if (isSystemInit(msg)) {
    const line = `session ${msg.session_id} model=${msg.model} cwd=${msg.cwd}`;
    return [useColor ? dim(line) : line];
  }

  if (isAssistant(msg)) {
    return formatAssistant(msg, useColor);
  }

  if (isResult(msg)) {
    return formatResult(msg, useColor);
  }

  // All other types: skip.
  return [];
}

function formatAssistant(
  msg: { type: "assistant"; message: { content: ContentBlock[] } },
  useColor: boolean,
): string[] {
  const lines: string[] = [];
  const content = Array.isArray(msg.message.content) ? msg.message.content : [];

  for (const block of content) {
    if (block.type === "thinking") {
      // Skip thinking blocks.
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text.length > 0) {
        // Assistant text: default (no decoration).
        lines.push(text);
      }
      continue;
    }

    if (block.type === "tool_use") {
      const toolName = String(block.name ?? "unknown");
      const input: ToolInput =
        isObj(block.input) ? (block.input as ToolInput) : {};
      const summary = summariseToolInput(toolName, input);

      const nameStr = useColor ? boldCyan(toolName) : toolName;
      const summaryStr = useColor ? dim(summary) : summary;
      const line = truncate(`> ${toolName}: ${summary}`, MAX_LINE_LENGTH);
      // For color mode, reconstruct with styled parts.
      if (useColor) {
        lines.push(`> ${nameStr}: ${summaryStr}`);
      } else {
        lines.push(line);
      }
      continue;
    }

    // Other content block types: skip.
  }

  return lines;
}

function formatResult(
  msg: {
    type: "result";
    subtype: string;
    is_error: boolean;
    num_turns: number;
    total_cost_usd: number;
    duration_ms: number;
  },
  useColor: boolean,
): string[] {
  if (msg.is_error) {
    const line = `--- error: ${msg.subtype} (turns: ${msg.num_turns}, cost: ${formatCost(msg.total_cost_usd)}) ---`;
    return [useColor ? boldRed(line) : line];
  }

  const line = `--- done (turns: ${msg.num_turns}, cost: ${formatCost(msg.total_cost_usd)}, duration: ${formatDuration(msg.duration_ms)}) ---`;
  return [useColor ? boldGreen(line) : line];
}
