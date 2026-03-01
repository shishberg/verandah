/**
 * Parse a simple duration string into milliseconds.
 *
 * Supported formats:
 * - "Ns" or "Nsec" — seconds
 * - "Nm" or "Nmin" — minutes
 * - "Nh" or "Nhr"  — hours
 * - Plain number    — treated as milliseconds
 *
 * Throws on invalid input.
 */
export function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|ms)?$/);
  if (!match) {
    throw new Error(`invalid duration: "${s}"`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2] ?? "ms";

  switch (unit) {
    case "ms":
      return value;
    case "s":
    case "sec":
      return value * 1000;
    case "m":
    case "min":
      return value * 60 * 1000;
    case "h":
    case "hr":
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`invalid duration unit: "${unit}"`);
  }
}
