import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { agentDbPath, listProfiles, readPinnedIdentity } from "./omp";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeDir(files: string[]) {
  dir = mkdtempSync(join(tmpdir(), "omp-"));
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
}

describe("omp stores on disk", () => {
  it("lists the default store first, then valid named profiles in order", () => {
    makeDir([
      ".omp/agent/agent.db",
      ".omp/profiles/work/agent/agent.db",
      ".omp/profiles/alpha/stats.db",
      ".omp/profiles/Bad Name/agent/agent.db",
      ".omp/profiles/default/agent/agent.db",
    ]);
    expect(listProfiles({ home: dir, env: {}, platform: "linux" })).toEqual(["default", "alpha", "work"]);
  });

  it("omits a default profile that never stored anything, and finds stores under an existing XDG root", () => {
    makeDir([".omp/profiles/work/agent/agent.db", "xdg/omp/profiles/home/agent.db"]);
    const xdg = { home: dir, env: { XDG_DATA_HOME: join(dir, "xdg") }, platform: "linux" as const };
    expect(listProfiles(xdg)).toEqual(["home", "work"]);
    expect(agentDbPath("home", xdg)).toBe(join(dir, "xdg/omp/profiles/home/agent.db"));
    expect(agentDbPath("work", xdg)).toBe(join(dir, ".omp/profiles/work/agent/agent.db"));
  });
});

describe("readPinnedIdentity", () => {
  it("reads the identity of the one asked pin, and never the credential data", () => {
    makeDir([]);
    const path = join(dir, "agent.db");
    // omp's schema, as found in a real agent.db.
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT,
        disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER);
      INSERT INTO auth_credentials (id, provider, credential_type, data, identity_key) VALUES
        (1, 'anthropic', 'oauth', '{"access":"secret"}', 'email:a@acme.dev|org:o1'),
        (2, 'anthropic', 'oauth', '{"access":"secret"}', 'email:b@acme.dev|org:o1');
      INSERT INTO cache VALUES ('session:sticky:anthropic:s-1', '{"type":"oauth","index":1,"credentialId":2,"lastUsedAtMs":1}', 0);
      INSERT INTO cache VALUES ('session:sticky:anthropic:xs-1', '{"type":"oauth","index":0,"credentialId":1}', 0);
      INSERT INTO cache VALUES ('session:sticky:xai-oauth:s-2', '{"type":"oauth","index":0,"credentialId":1}', 0);
    `);
    db.close();
    expect(readPinnedIdentity(path, "anthropic", "s-1")).toBe("email:b@acme.dev|org:o1");
    expect(readPinnedIdentity(path, "anthropic", "s-2")).toBeNull();
    expect(readPinnedIdentity(join(dir, "missing.db"), "anthropic", "s-1")).toBeNull();
  });
});
