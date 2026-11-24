import { hashAccountKey, toneFromUsedPct, usedPctOf } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { balanceUnitSchema } from "../../shared/usage";
import { type Account, balanceTone, epoch, lenientArray, planLabel, SDK_TONE } from "./accounts";
import { PROVIDERS, providerName } from "./providers";

// Paseo's answer is parsed leniently, as omp's is: one odd entry must not hide the rest.
const toneSchema = z.enum(["default", "ok", "warning", "danger"]).optional().catch(undefined);
const time = z.string().nullable().catch(null);
const count = z.number().nullable().catch(null);

const entrySchema = z.object({
  /** The usage source's id: "claude", "cursor", or this plugin's own "omp-anthropic". */
  providerId: z.string(),
  /** "<source label> (<account>)", or the source label alone where the account has no name. */
  displayName: z.string(),
  status: z.enum(["available", "unavailable", "error"]),
  planLabel: z.string().nullable().catch(null),
  fetchedAt: time,
  windows: lenientArray(
    z.object({
      id: z.string(),
      label: z.string(),
      shortLabel: z.string().optional().catch(undefined),
      /** Account-wide; absent for one model family's own pool. */
      summary: z.boolean().optional().catch(undefined),
      usedPct: count,
      resetsAt: time,
      durationSeconds: count,
      runsOutAt: time,
      tone: toneSchema,
    }),
  ),
  balances: lenientArray(
    z.object({
      id: z.string(),
      label: z.string(),
      used: count,
      limit: count,
      remaining: count,
      unit: balanceUnitSchema,
      resetsAt: time,
      tone: toneSchema,
    }),
  ),
  error: z.string().nullable().catch(null),
});
const listSchema = z.object({ providers: lenientArray(entrySchema) }).catch({ providers: [] });

/** omp's provider id by the Paseo usage source reporting the same vendor, so both name it alike. */
const OMP_PROVIDER_BY_SOURCE: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDERS).flatMap(([provider, { paseoProvider }]) => (paseoProvider ? [[paseoProvider, provider]] : [])),
);

const DISPLAY_NAME = /^(.*) \((.+)\)$/;

/**
 * The accounts in `paseo.providers.listUsage()`, as Paseo gave it, that `skip` does not claim:
 * what Paseo's own usage sources read, such as Claude Code's or Cursor's sign-in. `provider` is
 * the source's id, which is also the id of the Paseo provider whose agents draw from it.
 */
export function readPaseoAccounts(listed: unknown, skip: (sourceId: string) => boolean, now: number): Account[] {
  return listSchema.parse(listed).providers.flatMap((entry): Account[] => {
    if (skip(entry.providerId)) return [];
    const [, sourceLabel = entry.displayName, login] = entry.displayName.match(DISPLAY_NAME) ?? [];
    const omp = OMP_PROVIDER_BY_SOURCE[entry.providerId];
    const available = entry.status === "available";
    return [
      {
        id: hashAccountKey(["paseo", entry.providerId, login ?? ""].join("|")),
        provider: entry.providerId,
        vendor: omp ? providerName(omp) : sourceLabel,
        label: login ?? "Paseo's sign-in",
        organization: null,
        plan: planLabel(entry.planLabel),
        profiles: [],
        fetchedAt: available ? (epoch(entry.fetchedAt) ?? now) : null,
        problem: available ? null : (entry.error ?? "Paseo has no usage report for this login."),
        windows: entry.windows.flatMap(({ id, label, shortLabel, summary, usedPct, resetsAt, durationSeconds, runsOutAt, tone }) =>
          usedPct === null
            ? []
            : [
                {
                  id,
                  label,
                  shortLabel: shortLabel ?? label,
                  usedPct,
                  tone: SDK_TONE[tone ?? toneFromUsedPct(usedPct) ?? "default"],
                  resetsAt: epoch(resetsAt),
                  durationMs: durationSeconds === null || durationSeconds === 0 ? null : durationSeconds * 1_000,
                  runsOutAt: epoch(runsOutAt),
                  modelFamily: summary ? null : (shortLabel ?? label),
                },
              ],
        ),
        balances: entry.balances.map(({ id, label, used, limit, remaining, unit, resetsAt, tone }) => {
          const usedPct = usedPctOf(used, limit);
          return {
            id,
            label,
            usedPct,
            tone: SDK_TONE[tone ?? balanceTone(usedPct, remaining) ?? "default"],
            resetsAt: epoch(resetsAt),
            unit,
            used,
            limit,
            remaining,
          };
        }),
        resets: [],
      },
    ];
  });
}
