import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

type Method = (...args: unknown[]) => unknown;

/** An object with each of `Name` a function: as far as JavaScript can check an object no types describe. */
export type Methods<Name extends string> = Record<Name, Method>;

export function isMethod(value: unknown): value is Method {
  return typeof value === "function";
}

export function hasMethods<Name extends string>(value: unknown, names: readonly Name[]): value is Methods<Name> {
  return typeof value === "object" && value !== null && names.every((name) => isMethod(Reflect.get(value, name)));
}

/** The root of the installed Paseo CLI package, which also carries the daemon and its web build. */
export function installedCli(): string {
  return join(dirname(realpathSync(execFileSync("which", ["paseo"], { encoding: "utf8" }).trim())), "..");
}

/**
 * A client of the local Paseo daemon, from the installed Paseo CLI, found at run time: it matches the
 * daemon's version. The CLI ships no types this checkout can import, so `methods` are the ones checked.
 */
export async function connectToDaemon<Name extends string>(methods: readonly Name[]): Promise<Methods<Name>> {
  const cli = join(installedCli(), "dist", "utils");
  const clientModule: unknown = await import(join(cli, "client.js"));
  const targetModule: unknown = await import(join(cli, "daemon-target.js"));
  if (!hasMethods(clientModule, ["connectToDaemon"]) || !hasMethods(targetModule, ["selectDaemonTarget"])) {
    throw new Error("The installed Paseo CLI lacks connectToDaemon or selectDaemonTarget");
  }
  const client: unknown = await clientModule.connectToDaemon({ target: targetModule.selectDaemonTarget({}), timeout: 5_000 });
  if (!hasMethods(client, methods)) throw new Error(`The installed Paseo CLI's daemon client lacks one of ${methods.join(", ")}`);
  return client;
}
