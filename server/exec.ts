import { execFile } from "node:child_process";
import { promisify } from "node:util";

// oxlint-disable-next-line typescript/strict-void-return -- execFile defines util.promisify.custom, so promisify uses that and never sees the returned ChildProcess
export const execFileAsync = promisify(execFile);

/**
 * Why running `command` failed, in one line: missing from PATH, timed out, or its first stderr
 * line. `label` names the run in the timed-out and failed messages.
 */
export function execFailure(error: unknown, command: string, timeoutMs: number, label = command): Error {
  if (!(error instanceof Error)) return new Error(`${label} failed: ${String(error)}`);
  if ("code" in error && error.code === "ENOENT") return new Error(`${command} is not on the daemon's PATH`);
  if ("killed" in error && error.killed === true) return new Error(`${label} timed out after ${timeoutMs / 1000}s`);
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  return new Error(`${label} failed: ${stderr.split("\n")[0] || error.message}`);
}
