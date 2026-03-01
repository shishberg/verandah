import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "./store.js";
import type { AgentStatus } from "./types.js";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("migration", () => {
    it("creates schema on fresh database", () => {
      // The store was opened in beforeEach — the schema should exist.
      // Verify by creating an agent (would throw if table doesn't exist).
      const agent = store.createAgent({ name: "test", cwd: "/tmp" });
      expect(agent.name).toBe("test");
    });

    it("is idempotent — opening twice on same DB is fine", () => {
      // Close and reopen on the same in-memory DB won't work (memory is gone),
      // but we can verify the constructor doesn't throw on a fresh DB.
      const store2 = new Store(":memory:");
      const agent = store2.createAgent({ name: "test", cwd: "/tmp" });
      expect(agent.name).toBe("test");
      store2.close();
    });
  });

  describe("createAgent", () => {
    it("creates an agent with required fields", () => {
      const agent = store.createAgent({ name: "alpha", cwd: "/home/user" });

      expect(agent.id).toBeTruthy();
      expect(agent.name).toBe("alpha");
      expect(agent.cwd).toBe("/home/user");
      expect(agent.status).toBe("created");
      expect(agent.sessionId).toBeNull();
      expect(agent.model).toBeNull();
      expect(agent.prompt).toBeNull();
      expect(agent.permissionMode).toBeNull();
      expect(agent.maxTurns).toBeNull();
      expect(agent.allowedTools).toBeNull();
      expect(agent.createdAt).toBeTruthy();
      expect(agent.stoppedAt).toBeNull();
    });

    it("creates an agent with all optional fields", () => {
      const agent = store.createAgent({
        name: "beta",
        cwd: "/workspace",
        prompt: "do something",
        model: "haiku",
        permissionMode: "auto",
        maxTurns: 10,
        allowedTools: "Bash,Read",
      });

      expect(agent.name).toBe("beta");
      expect(agent.prompt).toBe("do something");
      expect(agent.model).toBe("haiku");
      expect(agent.permissionMode).toBe("auto");
      expect(agent.maxTurns).toBe(10);
      expect(agent.allowedTools).toBe("Bash,Read");
    });

    it("generates a unique ULID for each agent", () => {
      const a = store.createAgent({ name: "a", cwd: "/tmp" });
      const b = store.createAgent({ name: "b", cwd: "/tmp" });
      expect(a.id).not.toBe(b.id);
      // ULIDs are 26 characters
      expect(a.id).toHaveLength(26);
      expect(b.id).toHaveLength(26);
    });

    it("throws on duplicate name", () => {
      store.createAgent({ name: "dup", cwd: "/tmp" });
      expect(() => store.createAgent({ name: "dup", cwd: "/tmp" })).toThrow();
    });
  });

  describe("getAgent", () => {
    it("returns an agent by name", () => {
      store.createAgent({ name: "findme", cwd: "/tmp" });
      const agent = store.getAgent("findme");
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe("findme");
    });

    it("returns null for non-existent name", () => {
      const agent = store.getAgent("nonexistent");
      expect(agent).toBeNull();
    });
  });

  describe("listAgents", () => {
    it("returns all agents when no filter", () => {
      store.createAgent({ name: "a", cwd: "/tmp" });
      store.createAgent({ name: "b", cwd: "/tmp" });
      store.createAgent({ name: "c", cwd: "/tmp" });

      const agents = store.listAgents();
      expect(agents).toHaveLength(3);
    });

    it("returns empty list when no agents", () => {
      const agents = store.listAgents();
      expect(agents).toHaveLength(0);
    });

    it("filters by status", () => {
      store.createAgent({ name: "a", cwd: "/tmp" });
      store.createAgent({ name: "b", cwd: "/tmp" });
      store.updateAgent("b", { status: "running" });

      const created = store.listAgents("created");
      expect(created).toHaveLength(1);
      expect(created[0].name).toBe("a");

      const running = store.listAgents("running");
      expect(running).toHaveLength(1);
      expect(running[0].name).toBe("b");

      const stopped = store.listAgents("stopped");
      expect(stopped).toHaveLength(0);
    });

    it("returns agents ordered by created_at", () => {
      store.createAgent({ name: "first", cwd: "/tmp" });
      store.createAgent({ name: "second", cwd: "/tmp" });
      store.createAgent({ name: "third", cwd: "/tmp" });

      const agents = store.listAgents();
      expect(agents[0].name).toBe("first");
      expect(agents[1].name).toBe("second");
      expect(agents[2].name).toBe("third");
    });
  });

  describe("updateAgent", () => {
    it("updates a single field", () => {
      store.createAgent({ name: "u1", cwd: "/tmp" });
      const updated = store.updateAgent("u1", { status: "running" });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("running");
      expect(updated!.name).toBe("u1");
    });

    it("updates multiple fields", () => {
      store.createAgent({ name: "u2", cwd: "/tmp" });
      const updated = store.updateAgent("u2", {
        status: "stopped",
        sessionId: "sess-123",
        stoppedAt: "2025-01-15T10:00:00",
      });

      expect(updated!.status).toBe("stopped");
      expect(updated!.sessionId).toBe("sess-123");
      expect(updated!.stoppedAt).toBe("2025-01-15T10:00:00");
    });

    it("updates model field", () => {
      store.createAgent({ name: "u3", cwd: "/tmp" });
      const updated = store.updateAgent("u3", { model: "sonnet" });
      expect(updated!.model).toBe("sonnet");
    });

    it("updates permissionMode field", () => {
      store.createAgent({ name: "u4", cwd: "/tmp" });
      const updated = store.updateAgent("u4", {
        permissionMode: "bypassPermissions",
      });
      expect(updated!.permissionMode).toBe("bypassPermissions");
    });

    it("updates maxTurns field", () => {
      store.createAgent({ name: "u5", cwd: "/tmp" });
      const updated = store.updateAgent("u5", { maxTurns: 25 });
      expect(updated!.maxTurns).toBe(25);
    });

    it("updates allowedTools field", () => {
      store.createAgent({ name: "u6", cwd: "/tmp" });
      const updated = store.updateAgent("u6", {
        allowedTools: "Bash,Read,Write",
      });
      expect(updated!.allowedTools).toBe("Bash,Read,Write");
    });

    it("can set a field to null", () => {
      store.createAgent({
        name: "u7",
        cwd: "/tmp",
        model: "haiku",
      });
      expect(store.getAgent("u7")!.model).toBe("haiku");

      const updated = store.updateAgent("u7", { model: null });
      expect(updated!.model).toBeNull();
    });

    it("returns null for non-existent agent", () => {
      const updated = store.updateAgent("ghost", { status: "running" });
      expect(updated).toBeNull();
    });

    it("returns current agent when no fields provided", () => {
      store.createAgent({ name: "u8", cwd: "/tmp" });
      const updated = store.updateAgent("u8", {});
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("u8");
    });

    it("preserves fields not being updated", () => {
      store.createAgent({
        name: "u9",
        cwd: "/workspace",
        model: "haiku",
        prompt: "test prompt",
      });

      const updated = store.updateAgent("u9", { status: "running" });
      expect(updated!.status).toBe("running");
      expect(updated!.model).toBe("haiku");
      expect(updated!.prompt).toBe("test prompt");
      expect(updated!.cwd).toBe("/workspace");
    });
  });

  describe("deleteAgent", () => {
    it("deletes an existing agent", () => {
      store.createAgent({ name: "doomed", cwd: "/tmp" });
      expect(store.getAgent("doomed")).not.toBeNull();

      const deleted = store.deleteAgent("doomed");
      expect(deleted).toBe(true);
      expect(store.getAgent("doomed")).toBeNull();
    });

    it("returns false for non-existent agent", () => {
      const deleted = store.deleteAgent("ghost");
      expect(deleted).toBe(false);
    });

    it("agent no longer appears in list after deletion", () => {
      store.createAgent({ name: "listed", cwd: "/tmp" });
      expect(store.listAgents()).toHaveLength(1);

      store.deleteAgent("listed");
      expect(store.listAgents()).toHaveLength(0);
    });
  });

  describe("status values", () => {
    const statuses: AgentStatus[] = [
      "created",
      "running",
      "stopped",
      "failed",
      "blocked",
    ];

    for (const status of statuses) {
      it(`supports status "${status}"`, () => {
        const name = `agent-${status}`;
        store.createAgent({ name, cwd: "/tmp" });
        store.updateAgent(name, { status });
        const agent = store.getAgent(name);
        expect(agent!.status).toBe(status);
      });
    }
  });
});
