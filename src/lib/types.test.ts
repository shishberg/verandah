import { describe, it, expect } from "vitest";
import type {
  Request,
  Response,
  NewArgs,
  SendArgs,
  StopArgs,
  RemoveArgs,
  LogsArgs,
  WhoamiArgs,
  WaitArgs,
  PermissionArgs,
  PendingPermission,
  PermissionResult,
  CommandName,
  Session,
  SessionStatus,
  SessionWithStatus,
  CreateSessionArgs,
  UpdateSessionFields,
} from "./types.js";
import { sessionStatus } from "./types.js";

describe("types", () => {
  describe("Request", () => {
    it("can construct a request with args", () => {
      const req: Request = {
        command: "new",
        args: { name: "alpha", prompt: "hello" },
      };
      expect(req.command).toBe("new");
      expect(req.args).toEqual({ name: "alpha", prompt: "hello" });
    });

    it("can construct a request without args", () => {
      const req: Request = { command: "ping" };
      expect(req.command).toBe("ping");
      expect(req.args).toBeUndefined();
    });
  });

  describe("Response", () => {
    it("can construct a success response", () => {
      const res: Response = {
        ok: true,
        data: { name: "alpha", status: "running" },
      };
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ name: "alpha", status: "running" });
      expect(res.error).toBeUndefined();
    });

    it("can construct an error response", () => {
      const res: Response = {
        ok: false,
        error: "agent not found",
      };
      expect(res.ok).toBe(false);
      expect(res.error).toBe("agent not found");
      expect(res.data).toBeUndefined();
    });
  });

  describe("CommandName", () => {
    it("includes all protocol commands", () => {
      const commands: CommandName[] = [
        "new",
        "list",
        "send",
        "stop",
        "rm",
        "logs",
        "whoami",
        "ping",
        "daemon",
        "wait",
        "permission",
        "notify-start",
        "notify-exit",
      ];
      expect(commands).toHaveLength(13);
    });
  });

  describe("command argument types", () => {
    it("NewArgs with all fields", () => {
      const args: NewArgs = {
        name: "alpha",
        prompt: "hello",
        cwd: "/tmp",
        model: "haiku",
        permissionMode: "default",
        maxTurns: 5,
        allowedTools: "Bash Edit",
        interactive: false,
        wait: true,
      };
      expect(args.name).toBe("alpha");
    });

    it("NewArgs with minimal fields", () => {
      const args: NewArgs = {};
      expect(args.name).toBeUndefined();
    });

    it("SendArgs requires name and message", () => {
      const args: SendArgs = {
        name: "alpha",
        message: "continue",
      };
      expect(args.name).toBe("alpha");
      expect(args.message).toBe("continue");
    });

    it("StopArgs with name or all", () => {
      const byName: StopArgs = { name: "alpha" };
      const all: StopArgs = { all: true };
      expect(byName.name).toBe("alpha");
      expect(all.all).toBe(true);
    });

    it("RemoveArgs requires name", () => {
      const args: RemoveArgs = { name: "alpha", force: true };
      expect(args.force).toBe(true);
    });

    it("LogsArgs with options", () => {
      const args: LogsArgs = { name: "alpha", follow: true, lines: 50 };
      expect(args.lines).toBe(50);
    });

    it("WhoamiArgs requires name", () => {
      const args: WhoamiArgs = { name: "alpha" };
      expect(args.name).toBe("alpha");
    });

    it("WaitArgs with timeout", () => {
      const args: WaitArgs = { name: "alpha", timeout: 30000 };
      expect(args.timeout).toBe(30000);
    });

    it("PermissionArgs with all actions", () => {
      const show: PermissionArgs = {
        name: "alpha",
        action: "show",
      };
      const allow: PermissionArgs = {
        name: "alpha",
        action: "allow",
        wait: true,
      };
      const deny: PermissionArgs = {
        name: "alpha",
        action: "deny",
        message: "use git stash instead",
      };
      const answer: PermissionArgs = {
        name: "alpha",
        action: "answer",
        answer: "PostgreSQL",
      };
      expect(show.action).toBe("show");
      expect(allow.wait).toBe(true);
      expect(deny.message).toBe("use git stash instead");
      expect(answer.answer).toBe("PostgreSQL");
    });
  });

  describe("PendingPermission", () => {
    it("includes a resolve function", () => {
      let resolved: PermissionResult | null = null;
      const pending: PendingPermission = {
        id: "01JXXXXXXXXXXXXXXXXXXXXXXX",
        toolName: "Bash",
        toolInput: { command: "rm -rf /tmp/test" },
        resolve: (result) => {
          resolved = result;
        },
        createdAt: new Date("2026-03-01T10:05:00Z"),
      };

      expect(pending.toolName).toBe("Bash");
      expect(typeof pending.resolve).toBe("function");

      // Calling resolve should work
      pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
      expect(resolved).toEqual({
        behavior: "allow",
        updatedInput: { command: "rm -rf /tmp/test" },
      });
    });

    it("can be denied with a message", () => {
      let resolved: PermissionResult | null = null;
      const pending: PendingPermission = {
        id: "01JYYYYYYYYYYYYYYYYYYYYYY",
        toolName: "Edit",
        toolInput: { file: "/etc/hosts" },
        resolve: (result) => {
          resolved = result;
        },
        createdAt: new Date(),
      };

      pending.resolve({ behavior: "deny", message: "not allowed" });
      expect(resolved).toEqual({
        behavior: "deny",
        message: "not allowed",
      });
    });
  });

  describe("Session types", () => {
    it("can construct a Session record", () => {
      const session: Session = {
        id: "01JXXXXXXXXXXXXXXXXXXXXXXX",
        name: "alpha",
        sessionId: "session-123",
        model: "claude-opus-4-6",
        cwd: "/home/user/project",
        prompt: "fix the tests",
        permissionMode: "default",
        maxTurns: 10,
        allowedTools: "Bash(git:*) Edit Read",
        lastError: null,
        createdAt: "2026-03-01T10:00:00Z",
      };
      expect(session.name).toBe("alpha");
      // Session does not include a status field (status is derived at runtime)
      expect("status" in session).toBe(false);
    });

    it("SessionWithStatus includes derived status", () => {
      const session: SessionWithStatus = {
        id: "01JXXXXXXXXXXXXXXXXXXXXXXX",
        name: "alpha",
        sessionId: null,
        model: null,
        cwd: "/tmp",
        prompt: null,
        permissionMode: null,
        maxTurns: null,
        allowedTools: null,
        lastError: null,
        createdAt: "2026-03-01T10:00:00Z",
        status: "idle",
      };
      expect(session.status).toBe("idle");
    });

    it("CreateSessionArgs has all required fields", () => {
      const args: CreateSessionArgs = {
        name: "alpha",
        cwd: "/tmp",
        prompt: "hello",
        model: "haiku",
        permissionMode: "default",
        maxTurns: 5,
        allowedTools: "Bash Edit",
      };
      expect(args.name).toBe("alpha");
    });

    it("UpdateSessionFields has all expected fields", () => {
      const fields: UpdateSessionFields = {
        sessionId: "session-456",
        model: "haiku",
        prompt: "new prompt",
        permissionMode: "plan",
        maxTurns: 20,
        allowedTools: "Read",
        lastError: null,
      };
      expect(fields.sessionId).toBe("session-456");
    });
  });

  describe("sessionStatus()", () => {
    it("returns idle when no active query and no lastError", () => {
      const session = { name: "alpha", lastError: null };
      const activeQueries = new Map<
        string,
        { pendingPermission: unknown | null }
      >();
      const result: SessionStatus = sessionStatus(session, activeQueries);
      expect(result).toBe("idle");
    });

    it("returns failed when no active query and lastError is set", () => {
      const session = { name: "alpha", lastError: "something broke" };
      const activeQueries = new Map<
        string,
        { pendingPermission: unknown | null }
      >();
      expect(sessionStatus(session, activeQueries)).toBe("failed");
    });

    it("returns running when active query with no pendingPermission", () => {
      const session = { name: "alpha", lastError: null };
      const activeQueries = new Map<
        string,
        { pendingPermission: unknown | null }
      >();
      activeQueries.set("alpha", { pendingPermission: null });
      expect(sessionStatus(session, activeQueries)).toBe("running");
    });

    it("returns blocked when active query with pendingPermission set", () => {
      const session = { name: "alpha", lastError: null };
      const activeQueries = new Map<
        string,
        { pendingPermission: unknown | null }
      >();
      activeQueries.set("alpha", {
        pendingPermission: { toolName: "Bash", toolInput: {} },
      });
      expect(sessionStatus(session, activeQueries)).toBe("blocked");
    });
  });
});
