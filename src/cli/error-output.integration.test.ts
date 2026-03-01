import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import * as path from "node:path";

/**
 * Run the vh CLI bundle and capture stdout/stderr.
 * Returns { code, stdout, stderr }.
 */
function runVh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const bundle = path.resolve(__dirname, "../../dist/vh.js");
  return new Promise((resolve) => {
    execFile("node", [bundle, ...args], (err, stdout, stderr) => {
      const code = err && "code" in err ? (err as { code: number }).code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("CLI error output", () => {
  it("prints a single error line for application errors", async () => {
    // `vh send nonexistent hi` — daemon auto-starts, session not found.
    const { code, stderr, stdout } = await runVh(["send", "nonexistent", "hi"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");

    // Verify exactly one non-empty error line.
    const lines = stderr.trim().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error: .*session.*not found/);
  });

  it("prints a single error line for Commander errors", async () => {
    // `vh send` without required argument.
    const { code, stderr, stdout } = await runVh(["send"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");

    const lines = stderr.trim().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error: missing required argument/);
  });

  it("--help exits 0 with no stderr", async () => {
    const { code, stderr, stdout } = await runVh(["--help"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage:");
  });

  it("--version exits 0 with no stderr", async () => {
    const { code, stderr, stdout } = await runVh(["--version"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("stop --all with nothing to stop exits 0 with message on stderr", async () => {
    const { code, stderr, stdout } = await runVh(["stop", "--all"]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe("no sessions to stop");
  });
});
