import { balanceToneFromRemaining, hashAccountKey, toneFromUsedPct, type UsageWindow, usedPctOf } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { DAY_MS, HOUR_MS } from "../../shared/format";
import { type Tone, worstTone } from "../../shared/tone";
import { type BalanceUnit, balanceUnitSchema } from "../../shared/usage";
import { PROVIDERS, providerName } from "./providers";

// omp's JSON is parsed leniently: one odd field or entry must not hide a whole profile.
const optionalText = z.string().min(1).optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

export function lenientArray<Item extends z.ZodType>(item: Item) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((values) =>
      values.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

const identityShape = {
  email: optionalText,
  accountId: optionalText,
  projectId: optionalText,
  orgId: optionalText,
  orgName: optionalText,
};

const limitSchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.object({ accountId: optionalText, projectId: optionalText, orgId: optionalText, tier: optionalText }).catch({}),
  window: z.object({ id: z.string(), durationMs: optionalNumber, resetsAt: optionalNumber }).optional().catch(undefined),
  amount: z.object({
    used: optionalNumber,
    limit: optionalNumber,
    remaining: optionalNumber,
    usedFraction: optionalNumber,
    remainingFraction: optionalNumber,
    unit: z.string(),
  }),
  status: optionalText,
});
type Limit = z.infer<typeof limitSchema>;

const reportSchema = z.object({
  provider: z.string(),
  fetchedAt: z.number(),
  limits: lenientArray(limitSchema),
  metadata: z.object({ ...identityShape, planType: optionalText }).catch({}),
  resetCredits: z
    .object({
      credits: lenientArray(
        z.object({
          usable: z.boolean().optional().catch(undefined),
          expiresAt: optionalText,
          /** Window ids redeeming it clears: "anthropic:7d", "anthropic:7d:fable". Absent from Codex's. */
          clears: z.array(z.string()).optional().catch(undefined),
          remainingCount: optionalNumber,
          /** "available", "unavailable" (not its turn yet), "redeemed", "expired". */
          status: optionalText,
        }),
      ),
    })
    .optional()
    .catch(undefined),
});
type Report = z.infer<typeof reportSchema>;

const identitySchema = z.object({ provider: z.string(), ...identityShape });
type Identity = z.infer<typeof identitySchema>;

const loginSchema = identitySchema.extend({ cause: optionalText });

const outputSchema = z.object({
  reports: lenientArray(reportSchema),
  accountsWithoutUsage: lenientArray(loginSchema),
  disabledCredentials: lenientArray(loginSchema),
});

/** A login stored in one profile that omp can draw quota from. */
export interface ProfileLogin extends Identity {
  /** Id of the merged account. */
  account: string;
}

export interface Window {
  id: string;
  label: string;
  shortLabel: string;
  usedPct: number;
  tone: Tone;
  resetsAt: number | null;
  durationMs: number | null;
  /** Epoch milliseconds when it reaches 100% before resetting, at its pace so far; the source's estimate until the view's. */
  runsOutAt: number | null;
  /** Set when the window is one model family's own pool. */
  modelFamily: string | null;
}

export interface Balance {
  id: string;
  label: string;
  usedPct: number | null;
  tone: Tone;
  resetsAt: number | null;
  unit: BalanceUnit;
  used: number | null;
  limit: number | null;
  remaining: number | null;
}

/** One banked limit reset: redeeming it clears the windows it names at once. */
export interface BankedReset {
  /** Window ids it clears; null where the source does not say, as Codex's, whose resets clear its only limit. */
  clears: string[] | null;
  /** Redeemable now; others wait their turn, or for a limit to be reached. */
  usable: boolean;
  /** Epoch milliseconds. */
  expiresAt: number | null;
}

export interface Account {
  id: string;
  provider: string;
  vendor: string;
  label: string;
  organization: string | null;
  plan: string | null;
  profiles: string[];
  fetchedAt: number | null;
  problem: string | null;
  windows: Window[];
  balances: Balance[];
  /** One per reset still banked. */
  resets: BankedReset[];
}

export interface ProfileUsage {
  profile: string;
  /** Last successful `omp usage --json` output; absent until omp has answered once. */
  usage?: unknown;
  /** Why the latest omp run failed; null when it succeeded. */
  error: string | null;
}

export interface Accounts {
  accounts: Account[];
  /** Usable logins by profile, for working out which one a session draws from. */
  logins: Record<string, ProfileLogin[]>;
  errors: { profile: string; message: string }[];
}

/**
 * Stable id for the quota a login meters: shared by the same login in several profiles and kept
 * across token rotation. Logins without any identity stay unique to their profile, numbered
 * among themselves so adding another login does not renumber them.
 */
function accountKey(identity: Identity, anonymous: () => string): string {
  const who = identity.email?.toLowerCase() ?? identity.accountId ?? identity.projectId ?? anonymous();
  return hashAccountKey([identity.provider, who, identity.orgId ?? ""].join("|"));
}

/** omp's own order: report metadata, then the first limit scope that names the account. */
function reportIdentity({ provider, metadata, limits }: Report): Identity {
  const scoped = (key: "accountId" | "projectId" | "orgId") => limits.find((limit) => limit.scope[key])?.scope[key];
  return {
    provider,
    email: metadata.email,
    accountId: metadata.accountId ?? scoped("accountId"),
    projectId: metadata.projectId ?? scoped("projectId"),
    orgId: metadata.orgId ?? scoped("orgId"),
    orgName: metadata.orgName,
  };
}

function organizationOf({ provider, email, orgName }: Identity): string | null {
  // Anthropic names every personal organization "<email>'s Organization".
  if (!orgName || orgName === `${email}'s Organization` || PROVIDERS[provider]?.orgNameIsPlan) return null;
  return orgName;
}

/** omp's precedence for the used fraction of a limit. */
function resolveUsedFraction({ used, limit, unit, usedFraction, remainingFraction }: Limit["amount"]): number | null {
  if (usedFraction !== undefined) return usedFraction;
  if (used !== undefined && limit !== undefined && limit > 0) return used / limit;
  if (unit === "percent" && used !== undefined) return used / 100;
  if (remainingFraction !== undefined) return Math.max(0, 1 - remainingFraction);
  return null;
}

export const SDK_TONE: Record<NonNullable<UsageWindow["tone"]>, Tone> = { default: "ok", ok: "ok", warning: "warning", danger: "danger" };

/** Paseo's usage thresholds, or omp's own verdict when that is worse. */
function toneOf(paseo: UsageWindow["tone"], status: string | undefined): Tone {
  const tone = SDK_TONE[paseo ?? "default"];
  if (status === "exhausted") return "danger";
  return status === "warning" ? worstTone([tone, "warning"]) : tone;
}

/** Paseo's tone for a balance: by its share used, or, without a limit, only by whether it ran out. */
export function balanceTone(usedPct: number | null, remaining: number | null | undefined): UsageWindow["tone"] {
  return usedPct === null ? balanceToneFromRemaining(remaining) : toneFromUsedPct(usedPct);
}

/** Epoch milliseconds of an ISO time; null when absent or unreadable. */
export function epoch(at: string | null | undefined): number | null {
  const parsed = Date.parse(at ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/** A plan as its source names it, spaced: "max 20x" for "max_20x". */
export function planLabel(plan: string | null | undefined): string | null {
  return plan?.replaceAll("_", " ") ?? null;
}

/** One unit for every window, "7d" whether omp calls it "7d" or "1w"; omp's own id without a duration. */
function windowLabel(id: string, durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs <= 0) return id;
  if (durationMs % DAY_MS === 0) return `${durationMs / DAY_MS}d`;
  return durationMs % HOUR_MS === 0 ? `${durationMs / HOUR_MS}h` : id;
}

function readLimits(limits: readonly Limit[], modelPools: boolean): Pick<Account, "windows" | "balances"> {
  const windows: Window[] = [];
  const balances: Balance[] = [];
  for (const { id, label, scope, window, amount, status } of limits) {
    // A cap of zero grants nothing to use, such as Codex's spend cap without purchased credits, which omp reports as 100% used.
    if (amount.limit === 0) continue;
    const fraction = resolveUsedFraction(amount);
    const unit = balanceUnitSchema.safeParse(amount.unit).data;
    // Money and counts are balances unless omp meters them over a window.
    if (unit && !(window && fraction !== null)) {
      const { used, limit, remaining } = amount;
      const usedPct = usedPctOf(used, limit);
      balances.push({
        id,
        label,
        usedPct,
        tone: toneOf(balanceTone(usedPct, remaining), status),
        resetsAt: window?.resetsAt ?? null,
        unit,
        used: used ?? null,
        limit: limit ?? null,
        remaining: remaining ?? null,
      });
    } else if (fraction !== null) {
      const usedPct = fraction * 100;
      const modelFamily = modelPools ? (scope.tier ?? null) : null;
      windows.push({
        id,
        label,
        shortLabel: modelFamily ?? (window ? windowLabel(window.id, window.durationMs) : id.slice(id.indexOf(":") + 1)),
        usedPct,
        tone: toneOf(toneFromUsedPct(usedPct), status),
        resetsAt: window?.resetsAt ?? null,
        durationMs: window?.durationMs ?? null,
        runsOutAt: null,
        modelFamily,
      });
    }
  }
  return { windows, balances };
}

/** Credits a login no longer holds. */
const SPENT_CREDITS: Record<string, true> = { redeemed: true, expired: true };

/** One entry per reset still banked: a credit can hold several. */
function readResets(credits: Report["resetCredits"]): BankedReset[] {
  return (credits?.credits ?? []).flatMap((credit) => {
    if (SPENT_CREDITS[credit.status ?? ""]) return [];
    const reset: BankedReset = {
      clears: credit.clears ?? null,
      usable: credit.usable !== false,
      expiresAt: epoch(credit.expiresAt),
    };
    return Array.from({ length: Math.max(0, credit.remainingCount ?? 1) }, () => reset);
  });
}

/** Turns per-profile `omp usage --json` outputs into one list of accounts. */
export function readAccounts(profiles: readonly ProfileUsage[]): Accounts {
  const accounts = new Map<string, Account>();
  const logins: Accounts["logins"] = {};
  const errors: Accounts["errors"] = [];

  for (const { profile, usage, error } of profiles) {
    if (error) errors.push({ profile, message: error });
    if (usage === undefined) continue;
    const output = outputSchema.safeParse(usage);
    if (!output.success) {
      errors.push({ profile, message: "omp usage output was not recognized" });
      continue;
    }
    let anonymous = 0;
    const accountFor = (identity: Identity) => {
      const id = accountKey(identity, () => `${profile}#${anonymous++}`);
      const account: Account = accounts.get(id) ?? {
        id,
        provider: identity.provider,
        vendor: providerName(identity.provider),
        label: identity.email ?? identity.accountId ?? identity.projectId ?? profile,
        organization: null,
        plan: null,
        profiles: [],
        fetchedAt: null,
        problem: null,
        windows: [],
        balances: [],
        resets: [],
      };
      accounts.set(id, account);
      account.organization ??= organizationOf(identity);
      if (!account.profiles.includes(profile)) account.profiles.push(profile);
      return account;
    };
    const usable: ProfileLogin[] = [];

    for (const report of output.data.reports) {
      const identity = reportIdentity(report);
      const account = accountFor(identity);
      usable.push({ ...identity, account: account.id });
      // The same login in several profiles: show the freshest report.
      if (account.fetchedAt !== null && account.fetchedAt >= report.fetchedAt) continue;
      Object.assign(account, {
        ...readLimits(report.limits, PROVIDERS[report.provider]?.modelPools === true),
        plan: planLabel(report.metadata.planType),
        resets: readResets(report.resetCredits),
        fetchedAt: report.fetchedAt,
        problem: null,
      } satisfies Partial<Account>);
    }

    for (const login of output.data.accountsWithoutUsage) {
      const account = accountFor(login);
      usable.push({ ...login, account: account.id });
      if (account.fetchedAt === null) account.problem ??= "omp has no usage report for this login.";
    }

    for (const login of output.data.disabledCredentials) {
      const account = accountFor(login);
      if (account.fetchedAt !== null) continue;
      const cause = login.cause ? ` (${login.cause})` : "";
      account.problem = `omp disabled this login${cause}. Sign in again with \`omp --profile ${profile}\`.`;
    }

    logins[profile] = usable;
  }

  return { accounts: [...accounts.values()], logins, errors };
}
