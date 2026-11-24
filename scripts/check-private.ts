/**
 * Fails when a file to be committed matches a line of `.private-patterns`: names, hosts, and paths
 * that must not reach this public repository, such as those in fixtures captured from a live host.
 * The pattern file stays untracked, because it lists what it guards; without it every file passes.
 *
 *   node scripts/check-private.ts <file>...
 */
import { existsSync, readFileSync } from "node:fs";

const PATTERNS_FILE = ".private-patterns";

if (existsSync(PATTERNS_FILE)) {
  const patterns = readFileSync(PATTERNS_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => new RegExp(line, "i"));
  const hits = process.argv.slice(2).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((text, index) => (patterns.some((pattern) => pattern.test(text)) ? [`${file}:${index + 1}`] : [])),
  );
  if (hits.length > 0) {
    console.error(`Private text from ${PATTERNS_FILE} in:\n${hits.join("\n")}`);
    process.exitCode = 1;
  }
}
