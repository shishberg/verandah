import { describe, it, expect } from "vitest";
import { filterLastQuery } from "./logs.js";

describe("filterLastQuery", () => {
  it("returns all lines when no init line exists", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    expect(filterLastQuery(lines)).toEqual(lines);
  });

  it("returns all lines for a single query", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    expect(filterLastQuery(lines)).toEqual(lines);
  });

  it("returns only the last query when there are multiple queries", () => {
    const query1 = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    const query2 = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    const allLines = [...query1, ...query2];
    expect(filterLastQuery(allLines)).toEqual(query2);
  });

  it("handles three queries, returns only the last", () => {
    const init = (id: string) => JSON.stringify({ type: "system", subtype: "init", session_id: id });
    const msg = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    const result = () => JSON.stringify({ type: "result", subtype: "success" });

    const lines = [
      init("s1"), msg("one"), result(),
      init("s1"), msg("two"), result(),
      init("s1"), msg("three"), result(),
    ];
    expect(filterLastQuery(lines)).toEqual([
      init("s1"), msg("three"), result(),
    ]);
  });

  it("handles invalid JSON lines gracefully", () => {
    const lines = [
      "not json",
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      "also not json",
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    // Should find the init at index 1 and slice from there.
    expect(filterLastQuery(lines)).toEqual(lines.slice(1));
  });

  it("returns empty array sliced from init when init is the only line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    ];
    expect(filterLastQuery(lines)).toEqual(lines);
  });

  it("returns all lines for empty array", () => {
    expect(filterLastQuery([])).toEqual([]);
  });

  it("ignores system messages that are not init", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "system", subtype: "other" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    // The only init is at index 0, so all lines are returned.
    expect(filterLastQuery(lines)).toEqual(lines);
  });
});
