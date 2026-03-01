import * as os from "os";
import * as path from "path";

const DEFAULT_VH_HOME = path.join(os.homedir(), ".local", "verandah");

/**
 * Resolve the VH_HOME directory. Uses the VH_HOME environment variable
 * if set, otherwise defaults to ~/.local/verandah.
 */
export function resolveVHHome(): string {
  return process.env.VH_HOME || DEFAULT_VH_HOME;
}

/** Path to the unix socket file. */
export function socketPath(vhHome?: string): string {
  return path.join(vhHome ?? resolveVHHome(), "vh.sock");
}

/** Path to the SQLite database file. */
export function dbPath(vhHome?: string): string {
  return path.join(vhHome ?? resolveVHHome(), "vh.db");
}

/** Path to the logs directory. */
export function logDir(vhHome?: string): string {
  return path.join(vhHome ?? resolveVHHome(), "logs");
}

/** Path to the log file for a specific agent. */
export function logPath(name: string, vhHome?: string): string {
  return path.join(logDir(vhHome), `${name}.log`);
}

/** Path to the isolated Claude config directory. */
export function claudeConfigDir(vhHome?: string): string {
  return path.join(vhHome ?? resolveVHHome(), ".claude");
}
