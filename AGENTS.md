# paseo-companion

A Paseo plugin: Usage, Pull requests, and System screens. [README.md](README.md) says what each one shows.

## Layout

| Path                | Runs in                        | Owns                                                                                      |
| ------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `index.server.ts`   | the plugin process, under Node | Registers RPCs, feeds, hooks, and usage sources.                                          |
| `server/<feature>/` | the plugin process             | Reads (omp, `gh`, Paseo, `/proc`), caches them, and builds each view.                     |
| `index.client.tsx`  | the Paseo app (React Native)   | Registers screens, sidebar rows, badges, and pills.                                       |
| `client/`           | the Paseo app                  | Stores that subscribe to feeds, and components that render views.                         |
| `shared/`           | both                           | The RPC and feed contracts as zod schemas, the view types, and pure formatting.           |
| `fixtures/`         | tests                          | `*.input.json` are captured reads; `*.view.json` are the views the tests build from them. |
| `scripts/`          | Node, by hand                  | `project-icons.ts` (`npm run icons`) and the daemon client it shares with `e2e/`.         |
| `e2e/`              | Node, against the live daemon  | Reloads the plugin and calls each RPC and feed through the daemon.                        |

The server decides and words everything; the client renders the view it receives. When a screen needs a new fact, add it to the view in `server/<feature>/view.ts` and its type in `shared/`, not a computation in `client/`.

TypeScript project references enforce the boundaries: `tsconfig.client.json` covers `client/` and `shared/` without Node types, and `tsconfig.server.json` covers the rest. A client import of `server/` fails `tsc -b`.

The plugin SDK's contract is its type declarations, under `node_modules/@getpaseo/plugin/dist/`.

Paseo gives the client its own `react` and `react-native` at run time, so their versions in `package.json` only type-check and test the code. Keep them equal to the versions in Paseo's app (`packages/app/package.json` in `getpaseo/paseo`); a newer React lets the code use APIs the app does not have.

## Checks

`npm install` installs a prek pre-commit hook (`.pre-commit-config.yaml`). Each commit runs, in order:

1. Fixers: `oxfmt`, trailing whitespace, final newline, line endings.
2. In parallel: `oxlint` with type-aware rules (`.oxlintrc.json`), `tsc -b`, `knip` (unused files, exports, and dependencies), `jscpd` (duplicated code), `vitest`, `rumdl` (Markdown), secret and large-file checks, and the private-text check.

All of them take a few seconds. `npm run check` runs every hook on every file. Each tool also has its own script: `format`, `lint`, `typecheck`, `knip`, `dupes`, `test`, `lint:md`.

A view test compares its view with `fixtures/<feature>.view.json`. When a change is meant to alter a view, run `npx vitest run -u` and read the fixture diff: every changed value must be one the change intended.

This repository is public. A fixture captured from a live host carries its owner's names, hostnames, addresses, and paths; replace them with neutral ones (`acme`, `example.org`, `/home/me`, `192.0.2.0/24`) before committing. The private-text hook enforces this with patterns from `.private-patterns`, an untracked file each owner keeps; `scripts/check-private.ts` documents it.

`npm run e2e` checks the plugin end to end. It is not part of the hook, because it reloads the plugin in the running daemon and needs `gh` and `omp` signed in.

## Rules

- Fix the cause of a finding. Do not loosen a config, cast to silence the compiler, or add `!` after a lookup. A suppression names one rule on the narrowest line and gives the reason: `// oxlint-disable-next-line <rule> -- <reason>`. A rule that is wrong for the whole codebase is changed in `.oxlintrc.json`, with the reason in a comment there.
- The Paseo daemon is shared with live agent sessions. Load new code with `paseo plugin reload paseo-companion`. Never restart or stop the daemon.
- The plugin has no logger API. Paseo records the plugin's stderr in the daemon log, so the server reports failures with `console.error`.
