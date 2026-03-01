import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateName,
  generateUniqueName,
  ADJECTIVES,
  NOUNS,
} from "./names.js";

describe("generateName", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a string in adjective-noun format", () => {
    const name = generateName();
    const parts = name.split("-");
    // Some adjectives contain hyphens (no-worries, true-blue), so we check
    // that the last part is a noun and the rest form a valid adjective.
    const noun = parts[parts.length - 1];
    const adj = parts.slice(0, -1).join("-");
    expect(ADJECTIVES).toContain(adj);
    expect(NOUNS).toContain(noun);
  });

  it("produces names using only valid adjectives and nouns", () => {
    // Generate a bunch and verify all are valid.
    for (let i = 0; i < 100; i++) {
      const name = generateName();
      const parts = name.split("-");
      const noun = parts[parts.length - 1];
      const adj = parts.slice(0, -1).join("-");
      expect(ADJECTIVES).toContain(adj);
      expect(NOUNS).toContain(noun);
    }
  });

  it("generates a specific name when Math.random is mocked", () => {
    // Math.random returning 0 should pick the first adjective and noun.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const name = generateName();
    expect(name).toBe(`${ADJECTIVES[0]}-${NOUNS[0]}`);
  });
});

describe("generateUniqueName", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a name not in the existing list", () => {
    const existing = ["ace-bat", "beaut-croc"];
    const name = generateUniqueName(existing);
    expect(existing).not.toContain(name);
  });

  it("retries and succeeds when first attempts collide", () => {
    // Force first call to collide, second to succeed.
    const colliding = `${ADJECTIVES[0]}-${NOUNS[0]}`;
    const good = `${ADJECTIVES[1]}-${NOUNS[1]}`;

    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0) // adj index 0
      .mockReturnValueOnce(0) // noun index 0 -> colliding
      .mockReturnValueOnce(1 / ADJECTIVES.length) // adj index 1
      .mockReturnValueOnce(1 / NOUNS.length); // noun index 1 -> good

    const name = generateUniqueName([colliding]);
    expect(name).toBe(good);
  });

  it("throws after 5 collisions", () => {
    // Mock Math.random to always return 0 -> always the same name.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const colliding = `${ADJECTIVES[0]}-${NOUNS[0]}`;

    expect(() => generateUniqueName([colliding])).toThrow(
      "failed to generate unique name after 5 attempts",
    );
  });

  it("succeeds with empty existing list", () => {
    const name = generateUniqueName([]);
    expect(name).toBeTruthy();
    // Should still be valid format.
    const parts = name.split("-");
    const noun = parts[parts.length - 1];
    const adj = parts.slice(0, -1).join("-");
    expect(ADJECTIVES).toContain(adj);
    expect(NOUNS).toContain(noun);
  });
});
