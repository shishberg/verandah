// Agent status values matching the DB schema.
export type AgentStatus =
  | "created"
  | "running"
  | "stopped"
  | "failed"
  | "blocked";

// Agent record. Field names are camelCase in TypeScript;
// the store layer maps to/from snake_case DB columns.
export type Agent = {
  id: string;
  name: string;
  sessionId: string | null;
  status: AgentStatus;
  model: string | null;
  cwd: string;
  prompt: string | null;
  permissionMode: string | null;
  maxTurns: number | null;
  allowedTools: string | null;
  createdAt: string;
  stoppedAt: string | null;
};

// --- Socket protocol types ---

// All valid command names sent over the unix socket.
export type CommandName =
  | "new"
  | "list"
  | "send"
  | "stop"
  | "rm"
  | "logs"
  | "whoami"
  | "ping"
  | "daemon"
  | "wait"
  | "permission"
  | "notify-start"
  | "notify-exit";

// Request sent from client to daemon over the unix socket.
export type Request = {
  command: CommandName;
  args?: Record<string, unknown>;
};

// Response sent from daemon to client over the unix socket.
export type Response = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

// --- Command argument types ---

export type NewArgs = {
  name?: string;
  prompt?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
  allowedTools?: string;
  interactive?: boolean;
  wait?: boolean;
};

export type SendArgs = {
  name: string;
  message: string;
  wait?: boolean;
};

export type StopArgs = {
  name?: string;
  all?: boolean;
};

export type RemoveArgs = {
  name: string;
  force?: boolean;
};

export type LogsArgs = {
  name: string;
  follow?: boolean;
  lines?: number;
};

export type WhoamiArgs = {
  name: string;
};

export type ListArgs = {
  status?: AgentStatus;
};

export type WaitArgs = {
  name: string;
  timeout?: number;
};

export type PermissionAction = "show" | "allow" | "deny" | "answer";

export type PermissionArgs = {
  name: string;
  action: PermissionAction;
  message?: string;
  answer?: string;
  wait?: boolean;
};

export type NotifyStartArgs = {
  name: string;
};

export type NotifyExitArgs = {
  name: string;
  exitCode: number;
};

// --- Runtime types ---

// A pending permission request held in memory by the daemon.
// The `resolve` function is called when the permission is approved/denied.
// This type is NOT serialised — it only exists while the agent is blocked.
export type PermissionResult = {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
};

export type PendingPermission = {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  createdAt: Date;
};
