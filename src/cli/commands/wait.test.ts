import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatElapsed, parseLogProgress } from "./wait.js";

describe("formatElapsed", () => {
  it("formats seconds only", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(1000)).toBe("1s");
    expect(formatElapsed(45000)).toBe("45s");
    expect(formatElapsed(59000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(60000)).toBe("1m0s");
    expect(formatElapsed(272000)).toBe("4m32s");
    expect(formatElapsed(3599000)).toBe("59m59s");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatElapsed(3600000)).toBe("1h0m0s");
    expect(formatElapsed(4323000)).toBe("1h12m3s");
  });

  it("rounds fractional seconds", () => {
    expect(formatElapsed(1500)).toBe("2s");
    expect(formatElapsed(1499)).toBe("1s");
  });
});

describe("parseLogProgress", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeTmpLog(lines: unknown[]): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-wait-test-"));
    const logFile = path.join(tmpDir, "test.log");
    const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    fs.writeFileSync(logFile, content);
    return logFile;
  }

  it("returns defaults for non-existent file", () => {
    const result = parseLogProgress("/nonexistent/path/test.log");
    expect(result.turns).toBe(0);
    expect(result.startedAt).toBeNull();
    expect(result.result).toBeNull();
  });

  it("returns defaults for empty file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-wait-test-"));
    const logFile = path.join(tmpDir, "empty.log");
    fs.writeFileSync(logFile, "");
    const result = parseLogProgress(logFile);
    expect(result.turns).toBe(0);
    expect(result.startedAt).toBeNull();
    expect(result.result).toBeNull();
  });

  it("counts assistant messages with text content as turns", () => {
    const logFile = writeTmpLog([
      { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "world" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
      },
    ]);
    const result = parseLogProgress(logFile);
    expect(result.turns).toBe(3);
  });

  it("skips assistant messages with only thinking content", () => {
    const logFile = writeTmpLog([
      { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/" },
      {
        type: "assistant",
        message: { content: [{ type: "thinking", text: "hmm..." }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
    ]);
    const result = parseLogProgress(logFile);
    expect(result.turns).toBe(1);
  });

  it("skips assistant messages with empty text", () => {
    const logFile = writeTmpLog([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "   " }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "real" }] },
      },
    ]);
    const result = parseLogProgress(logFile);
    expect(result.turns).toBe(1);
  });

  it("returns null startedAt when system init has no timestamp_ms", () => {
    const logFile = writeTmpLog([
      { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/" },
    ]);
    const result = parseLogProgress(logFile);
    expect(result.startedAt).toBeNull();
  });

  it("captures startedAt from system init with timestamp_ms", () => {
    const logFile = writeTmpLog([
      { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/", timestamp_ms: 1700000000000 },
    ]);
    const result = parseLogProgress(logFile);
    expect(result.startedAt).toBe(1700000000000);
  });

  it("captures result message data for success", () => {
    const logFile = writeTmpLog([
      { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 10,
        total_cost_usd: 0.47,
        duration_ms: 272000,
      },
    ]);
    const result = parseLogProgress(logFile);
    expect(result.result).not.toBeNull();
    expect(result.result!.isError).toBe(false);
    expect(result.result!.subtype).toBe("success");
    expect(result.result!.numTurns).toBe(10);
    expect(result.result!.totalCostUsd).toBe(0.47);
    expect(result.result!.durationMs).toBe(272000);
  });

  it("captures result message data for error", () => {
    const logFile = writeTmpLog([
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 50,
        total_cost_usd: 2.10,
        duration_ms: 735000,
      },
    ]);
    const result = parseLogProgress(logFile);
    expect(result.result).not.toBeNull();
    expect(result.result!.isError).toBe(true);
    expect(result.result!.subtype).toBe("error_max_turns");
    expect(result.result!.numTurns).toBe(50);
    expect(result.result!.totalCostUsd).toBe(2.10);
    expect(result.result!.durationMs).toBe(735000);
  });

  it("handles invalid JSON lines gracefully", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-wait-test-"));
    const logFile = path.join(tmpDir, "test.log");
    fs.writeFileSync(
      logFile,
      'not json\n{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n',
    );
    const result = parseLogProgress(logFile);
    expect(result.turns).toBe(1);
  });
});
