import { describe, it, expect } from "vitest";
import { formatLogMessage, type LogFormat } from "./log-formatter.js";

// --- Test fixtures ---

const systemInitMsg = {
  type: "system",
  subtype: "init",
  session_id: "sess-abc-123",
  model: "claude-sonnet-4-20250514",
  cwd: "/home/user/project",
  tools: ["Bash", "Read"],
  mcp_servers: [],
  permissionMode: "default",
  slash_commands: [],
  output_style: "text",
  skills: [],
  plugins: [],
  apiKeySource: "env",
  claude_code_version: "1.0.0",
  uuid: "00000000-0000-0000-0000-000000000000",
};

const assistantTextMsg = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "  Hello, world!  " }],
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-0000-0000-000000000001",
  session_id: "sess-abc-123",
};

const assistantToolUseMsg = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "ls -la /tmp" },
        id: "tool-1",
      },
    ],
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-0000-0000-000000000002",
  session_id: "sess-abc-123",
};

const assistantThinkingMsg = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "thinking", text: "Let me think about this..." }],
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-0000-0000-000000000003",
  session_id: "sess-abc-123",
};

const assistantMixedMsg = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", text: "thinking..." },
      { type: "text", text: "I will read the file." },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/home/user/project/src/main.ts" },
        id: "tool-2",
      },
    ],
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-0000-0000-000000000004",
  session_id: "sess-abc-123",
};

const resultSuccessMsg = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 5,
  total_cost_usd: 0.47,
  duration_ms: 12345,
  duration_api_ms: 10000,
  result: "All done",
  stop_reason: "end_turn",
  usage: {
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {},
  permission_denials: [],
  uuid: "00000000-0000-0000-0000-000000000010",
  session_id: "sess-abc-123",
};

const resultErrorMsg = {
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  num_turns: 50,
  total_cost_usd: 2.1,
  duration_ms: 735000,
  duration_api_ms: 600000,
  stop_reason: null,
  usage: {
    input_tokens: 50000,
    output_tokens: 25000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {},
  permission_denials: [],
  errors: ["max turns exceeded"],
  uuid: "00000000-0000-0000-0000-000000000011",
  session_id: "sess-abc-123",
};

// --- Helpers ---

/** Check that a string contains ANSI escape codes. */
function hasAnsi(s: string): boolean {
  return /\x1b\[[\d;]+m/.test(s);
}

// --- Tests ---

describe("formatLogMessage", () => {
  describe("json mode", () => {
    it("returns JSON.stringify of the message", () => {
      const lines = formatLogMessage(systemInitMsg, "json");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(systemInitMsg);
    });

    it("returns valid JSON for assistant messages", () => {
      const lines = formatLogMessage(assistantTextMsg, "json");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe("assistant");
    });

    it("returns valid JSON for result messages", () => {
      const lines = formatLogMessage(resultSuccessMsg, "json");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe("result");
    });

    it("returns valid JSON for unknown message types", () => {
      const msg = { type: "something_else", data: 42 };
      const lines = formatLogMessage(msg, "json");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(msg);
    });
  });

  describe("system init", () => {
    it("text mode: renders session line without ANSI", () => {
      const lines = formatLogMessage(systemInitMsg, "text");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        "session sess-abc-123 model=claude-sonnet-4-20250514 cwd=/home/user/project",
      );
      expect(hasAnsi(lines[0])).toBe(false);
    });

    it("color mode: renders session line with dim ANSI", () => {
      const lines = formatLogMessage(systemInitMsg, "color");
      expect(lines).toHaveLength(1);
      expect(hasAnsi(lines[0])).toBe(true);
      expect(lines[0]).toContain("session sess-abc-123");
      expect(lines[0]).toContain("\x1b[2m"); // dim
    });
  });

  describe("assistant with text content", () => {
    it("text mode: renders trimmed text without ANSI", () => {
      const lines = formatLogMessage(assistantTextMsg, "text");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe("Hello, world!");
      expect(hasAnsi(lines[0])).toBe(false);
    });

    it("color mode: renders text without decoration (no ANSI)", () => {
      const lines = formatLogMessage(assistantTextMsg, "color");
      expect(lines).toHaveLength(1);
      // Assistant text has no decoration, so no ANSI codes.
      expect(lines[0]).toBe("Hello, world!");
    });

    it("skips empty text blocks", () => {
      const msg = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "   " }],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess",
      };
      expect(formatLogMessage(msg, "text")).toEqual([]);
      expect(formatLogMessage(msg, "color")).toEqual([]);
    });
  });

  describe("assistant with tool_use content", () => {
    it("text mode: renders tool summary without ANSI", () => {
      const lines = formatLogMessage(assistantToolUseMsg, "text");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe("> Bash: ls -la /tmp");
      expect(hasAnsi(lines[0])).toBe(false);
    });

    it("color mode: renders tool name in bold cyan, summary in dim", () => {
      const lines = formatLogMessage(assistantToolUseMsg, "color");
      expect(lines).toHaveLength(1);
      expect(hasAnsi(lines[0])).toBe(true);
      // Bold cyan for tool name.
      expect(lines[0]).toContain("\x1b[1m\x1b[36m"); // bold+cyan
      expect(lines[0]).toContain("Bash");
      // Dim for summary.
      expect(lines[0]).toContain("\x1b[2m"); // dim
      expect(lines[0]).toContain("ls -la /tmp");
    });
  });

  describe("assistant with thinking content", () => {
    it("text mode: skips thinking blocks", () => {
      const lines = formatLogMessage(assistantThinkingMsg, "text");
      expect(lines).toEqual([]);
    });

    it("color mode: skips thinking blocks", () => {
      const lines = formatLogMessage(assistantThinkingMsg, "color");
      expect(lines).toEqual([]);
    });
  });

  describe("assistant with mixed content", () => {
    it("text mode: renders text and tool_use, skips thinking", () => {
      const lines = formatLogMessage(assistantMixedMsg, "text");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("I will read the file.");
      expect(lines[1]).toBe("> Read: /home/user/project/src/main.ts");
    });

    it("color mode: renders text and tool_use, skips thinking", () => {
      const lines = formatLogMessage(assistantMixedMsg, "color");
      expect(lines).toHaveLength(2);
      expect(hasAnsi(lines[0])).toBe(false); // text has no decoration
      expect(hasAnsi(lines[1])).toBe(true); // tool_use has ANSI
    });
  });

  describe("result success", () => {
    it("text mode: renders done line without ANSI", () => {
      const lines = formatLogMessage(resultSuccessMsg, "text");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        "--- done (turns: 5, cost: $0.47, duration: 12s) ---",
      );
      expect(hasAnsi(lines[0])).toBe(false);
    });

    it("color mode: renders done line in bold green", () => {
      const lines = formatLogMessage(resultSuccessMsg, "color");
      expect(lines).toHaveLength(1);
      expect(hasAnsi(lines[0])).toBe(true);
      expect(lines[0]).toContain("\x1b[1m\x1b[32m"); // bold+green
      expect(lines[0]).toContain("done");
      expect(lines[0]).toContain("turns: 5");
      expect(lines[0]).toContain("$0.47");
    });
  });

  describe("result error", () => {
    it("text mode: renders error line without ANSI", () => {
      const lines = formatLogMessage(resultErrorMsg, "text");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        "--- error: error_max_turns (turns: 50, cost: $2.10) ---",
      );
      expect(hasAnsi(lines[0])).toBe(false);
    });

    it("color mode: renders error line in bold red", () => {
      const lines = formatLogMessage(resultErrorMsg, "color");
      expect(lines).toHaveLength(1);
      expect(hasAnsi(lines[0])).toBe(true);
      expect(lines[0]).toContain("\x1b[1m\x1b[31m"); // bold+red
      expect(lines[0]).toContain("error: error_max_turns");
      expect(lines[0]).toContain("$2.10");
    });
  });

  describe("skipped message types", () => {
    const skippedMessages = [
      { type: "user", message: "hello" },
      { type: "system", subtype: "compact_boundary" },
      { type: "stream_event", event: {} },
      { type: "status", status: "running" },
      { type: "unknown_type", data: 123 },
      42,
      "just a string",
      null,
      undefined,
    ];

    for (const msg of skippedMessages) {
      it(`text mode: skips ${JSON.stringify(msg)}`, () => {
        expect(formatLogMessage(msg, "text")).toEqual([]);
      });

      it(`color mode: skips ${JSON.stringify(msg)}`, () => {
        expect(formatLogMessage(msg, "color")).toEqual([]);
      });
    }

    it("json mode: still returns JSON for skipped types", () => {
      const msg = { type: "user", message: "hello" };
      const lines = formatLogMessage(msg, "json");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(msg);
    });
  });

  describe("tool input summarisation", () => {
    function toolUseMsg(name: string, input: Record<string, unknown>) {
      return {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name, input, id: "tool-test" }],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess",
      };
    }

    it("Bash: uses command field", () => {
      const lines = formatLogMessage(
        toolUseMsg("Bash", { command: "npm test" }),
        "text",
      );
      expect(lines[0]).toBe("> Bash: npm test");
    });

    it("Read: uses file_path field", () => {
      const lines = formatLogMessage(
        toolUseMsg("Read", { file_path: "/src/main.ts" }),
        "text",
      );
      expect(lines[0]).toBe("> Read: /src/main.ts");
    });

    it("Write: uses file_path field", () => {
      const lines = formatLogMessage(
        toolUseMsg("Write", { file_path: "/src/output.ts", content: "..." }),
        "text",
      );
      expect(lines[0]).toBe("> Write: /src/output.ts");
    });

    it("Edit: uses file_path field", () => {
      const lines = formatLogMessage(
        toolUseMsg("Edit", {
          file_path: "/src/config.ts",
          old_string: "a",
          new_string: "b",
        }),
        "text",
      );
      expect(lines[0]).toBe("> Edit: /src/config.ts");
    });

    it("Glob: uses pattern field", () => {
      const lines = formatLogMessage(
        toolUseMsg("Glob", { pattern: "**/*.ts" }),
        "text",
      );
      expect(lines[0]).toBe("> Glob: **/*.ts");
    });

    it("Grep: uses pattern + path", () => {
      const lines = formatLogMessage(
        toolUseMsg("Grep", { pattern: "TODO", path: "/src" }),
        "text",
      );
      expect(lines[0]).toBe("> Grep: TODO /src");
    });

    it("Grep: uses pattern only when no path", () => {
      const lines = formatLogMessage(
        toolUseMsg("Grep", { pattern: "FIXME" }),
        "text",
      );
      expect(lines[0]).toBe("> Grep: FIXME");
    });

    it("WebFetch: uses url field", () => {
      const lines = formatLogMessage(
        toolUseMsg("WebFetch", { url: "https://example.com" }),
        "text",
      );
      expect(lines[0]).toBe("> WebFetch: https://example.com");
    });

    it("WebSearch: uses query field", () => {
      const lines = formatLogMessage(
        toolUseMsg("WebSearch", { query: "vitest docs" }),
        "text",
      );
      expect(lines[0]).toBe("> WebSearch: vitest docs");
    });

    it("Agent: uses description field", () => {
      const lines = formatLogMessage(
        toolUseMsg("Agent", {
          description: "Refactor the module",
          prompt: "Please refactor",
        }),
        "text",
      );
      expect(lines[0]).toBe("> Agent: Refactor the module");
    });

    it("Agent: falls back to prompt field", () => {
      const lines = formatLogMessage(
        toolUseMsg("Agent", { prompt: "Please refactor" }),
        "text",
      );
      expect(lines[0]).toBe("> Agent: Please refactor");
    });

    it("unknown tool: uses first string-valued field", () => {
      const lines = formatLogMessage(
        toolUseMsg("CustomTool", { count: 5, label: "my-label", flag: true }),
        "text",
      );
      expect(lines[0]).toBe("> CustomTool: my-label");
    });

    it("unknown tool: empty string when no string fields", () => {
      const lines = formatLogMessage(
        toolUseMsg("NumericTool", { count: 5, flag: true }),
        "text",
      );
      expect(lines[0]).toBe("> NumericTool: ");
    });
  });

  describe("truncation", () => {
    it("truncates long tool input summaries to 120 chars", () => {
      const longCommand = "x".repeat(200);
      const msg = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: longCommand },
              id: "tool-long",
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess",
      };

      const lines = formatLogMessage(msg, "text");
      expect(lines).toHaveLength(1);
      // The overall line "> Bash: <summary>" is truncated to 120 chars.
      expect(lines[0].length).toBeLessThanOrEqual(120);
      expect(lines[0]).toContain("\u2026"); // ellipsis
    });

    it("does not truncate short summaries", () => {
      const msg = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls" },
              id: "tool-short",
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess",
      };

      const lines = formatLogMessage(msg, "text");
      expect(lines[0]).toBe("> Bash: ls");
      expect(lines[0]).not.toContain("\u2026");
    });
  });

  describe("edge cases", () => {
    it("handles assistant with empty content array", () => {
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: [] },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess",
      };
      expect(formatLogMessage(msg, "text")).toEqual([]);
      expect(formatLogMessage(msg, "color")).toEqual([]);
    });

    it("handles result with zero cost and duration", () => {
      const msg = {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
        result: "",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess",
      };
      const lines = formatLogMessage(msg, "text");
      expect(lines[0]).toBe(
        "--- done (turns: 1, cost: $0.00, duration: 0s) ---",
      );
    });

    it("handles tool_use with missing input", () => {
      const msg = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", id: "tool-no-input" }],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess",
      };
      const lines = formatLogMessage(msg, "text");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe("> Bash: ");
    });

    it("all three modes return string arrays", () => {
      const modes: LogFormat[] = ["color", "text", "json"];
      for (const mode of modes) {
        const lines = formatLogMessage(systemInitMsg, mode);
        expect(Array.isArray(lines)).toBe(true);
        for (const line of lines) {
          expect(typeof line).toBe("string");
        }
      }
    });
  });
});
