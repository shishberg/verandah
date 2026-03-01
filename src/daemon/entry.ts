import * as fs from "node:fs";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { socketPath as defaultSocketPath } from "../lib/config.js";

/**
 * Standalone entry point for the daemon process.
 *
 * Spawned by the client as a detached background process,
 * or run directly via `vh daemon`.
 *
 * Args (passed via process.argv):
 *   --vh-home <path>       VH_HOME directory (required)
 *   --socket-path <path>   Unix socket path (optional, derived from vh-home if omitted)
 *   --idle-timeout <ms>    Idle timeout in milliseconds (default: 300000 = 5m)
 *   --block-timeout <ms>   Block timeout in milliseconds (default: 600000 = 10m)
 */

function parseArgs(argv: string[]): {
  vhHome: string;
  socketPath: string;
  idleTimeout: number;
  blockTimeout: number;
} {
  let vhHome = "";
  let socketPathValue = "";
  let idleTimeout = 300000; // 5 minutes
  let blockTimeout = 600000; // 10 minutes

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--vh-home":
        vhHome = argv[++i];
        break;
      case "--socket-path":
        socketPathValue = argv[++i];
        break;
      case "--idle-timeout":
        idleTimeout = parseInt(argv[++i], 10);
        break;
      case "--block-timeout":
        blockTimeout = parseInt(argv[++i], 10);
        break;
    }
  }

  if (!vhHome) {
    process.stderr.write("daemon: --vh-home is required\n");
    process.exit(1);
  }

  if (!socketPathValue) {
    socketPathValue = defaultSocketPath(vhHome);
  }

  return { vhHome, socketPath: socketPathValue, idleTimeout, blockTimeout };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // Strip CLAUDECODE to prevent the Agent SDK from detecting a nested session.
  // The daemon is spawned by the CLI which may run inside Claude Code.
  delete process.env.CLAUDECODE;

  // Redirect stdout/stderr to a log file in VH_HOME.
  const logFile = path.join(args.vhHome, "daemon.log");
  fs.mkdirSync(args.vhHome, { recursive: true });
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  process.stdout.write = logStream.write.bind(logStream);
  process.stderr.write = logStream.write.bind(logStream);

  const daemon = new Daemon(args.vhHome, {
    idleTimeout: args.idleTimeout,
    blockTimeout: args.blockTimeout,
  });

  // Graceful shutdown on signals.
  const handleSignal = () => {
    daemon.shutdown().then(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  await daemon.start(args.socketPath);
}

main().catch((err) => {
  process.stderr.write(`daemon: ${err}\n`);
  process.exit(1);
});
