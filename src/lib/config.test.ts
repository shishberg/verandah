import { describe, it, expect, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import {
  resolveVHHome,
  socketPath,
  dbPath,
  logDir,
  logPath,
  claudeConfigDir,
} from "./config.js";

describe("config", () => {
  const originalEnv = process.env.VH_HOME;

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.VH_HOME = originalEnv;
    } else {
      delete process.env.VH_HOME;
    }
  });

  describe("resolveVHHome", () => {
    it("returns VH_HOME env var when set", () => {
      process.env.VH_HOME = "/custom/vh/home";
      expect(resolveVHHome()).toBe("/custom/vh/home");
    });

    it("returns default path when VH_HOME is not set", () => {
      delete process.env.VH_HOME;
      const expected = path.join(os.homedir(), ".local", "verandah");
      expect(resolveVHHome()).toBe(expected);
    });

    it("returns default path when VH_HOME is empty string", () => {
      process.env.VH_HOME = "";
      const expected = path.join(os.homedir(), ".local", "verandah");
      expect(resolveVHHome()).toBe(expected);
    });
  });

  describe("socketPath", () => {
    it("uses explicit vhHome argument", () => {
      expect(socketPath("/my/home")).toBe("/my/home/vh.sock");
    });

    it("falls back to resolveVHHome when no argument", () => {
      process.env.VH_HOME = "/env/home";
      expect(socketPath()).toBe("/env/home/vh.sock");
    });
  });

  describe("dbPath", () => {
    it("uses explicit vhHome argument", () => {
      expect(dbPath("/my/home")).toBe("/my/home/vh.db");
    });

    it("falls back to resolveVHHome when no argument", () => {
      process.env.VH_HOME = "/env/home";
      expect(dbPath()).toBe("/env/home/vh.db");
    });
  });

  describe("logDir", () => {
    it("uses explicit vhHome argument", () => {
      expect(logDir("/my/home")).toBe("/my/home/logs");
    });

    it("falls back to resolveVHHome when no argument", () => {
      process.env.VH_HOME = "/env/home";
      expect(logDir()).toBe("/env/home/logs");
    });
  });

  describe("logPath", () => {
    it("returns log file path for agent name", () => {
      expect(logPath("alpha", "/my/home")).toBe("/my/home/logs/alpha.log");
    });

    it("falls back to resolveVHHome when no vhHome", () => {
      process.env.VH_HOME = "/env/home";
      expect(logPath("beta")).toBe("/env/home/logs/beta.log");
    });
  });

  describe("claudeConfigDir", () => {
    it("uses explicit vhHome argument", () => {
      expect(claudeConfigDir("/my/home")).toBe("/my/home/.claude");
    });

    it("falls back to resolveVHHome when no argument", () => {
      process.env.VH_HOME = "/env/home";
      expect(claudeConfigDir()).toBe("/env/home/.claude");
    });
  });
});
