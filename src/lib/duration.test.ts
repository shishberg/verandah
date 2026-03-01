import { describe, it, expect } from "vitest";
import { parseDuration } from "./duration.js";

describe("parseDuration", () => {
  it("should parse seconds", () => {
    expect(parseDuration("30s")).toBe(30000);
    expect(parseDuration("1s")).toBe(1000);
    expect(parseDuration("0s")).toBe(0);
  });

  it("should parse 'sec' suffix", () => {
    expect(parseDuration("30sec")).toBe(30000);
  });

  it("should parse minutes", () => {
    expect(parseDuration("5m")).toBe(300000);
    expect(parseDuration("1m")).toBe(60000);
    expect(parseDuration("10min")).toBe(600000);
  });

  it("should parse hours", () => {
    expect(parseDuration("1h")).toBe(3600000);
    expect(parseDuration("2hr")).toBe(7200000);
  });

  it("should parse plain number as milliseconds", () => {
    expect(parseDuration("500")).toBe(500);
    expect(parseDuration("0")).toBe(0);
  });

  it("should parse milliseconds with 'ms' suffix", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  it("should parse fractional values", () => {
    expect(parseDuration("0.5s")).toBe(500);
    expect(parseDuration("1.5m")).toBe(90000);
  });

  it("should throw on invalid input", () => {
    expect(() => parseDuration("")).toThrow("invalid duration");
    expect(() => parseDuration("abc")).toThrow("invalid duration");
    expect(() => parseDuration("-5s")).toThrow("invalid duration");
    expect(() => parseDuration("5x")).toThrow("invalid duration");
  });
});
