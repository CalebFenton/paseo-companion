import { type UsageAccount, type UsageDetail, type UsageReport, type UsageScope, windowFromUsedPct } from "@getpaseo/plugin/server/usage";
import { countdown, DAY_MS, percent, plural, usd } from "../../shared/format";
import { worstTone } from "../../shared/tone";
import { type AccountView, type AgentRef, resetsText, type Summary, type UsageView, windowState } from "../../shared/usage";
import { type Account, type Balance, type ProfileUsage, readAccounts, type Window } from "./accounts";
import { bindAgents, type DaemonEnv, ompVendorOf, type PinLookup, profileOf } from "./agents";
import { runsOutAt } from "./pace";
import { readPaseoAccounts } from "./paseo";
import { PROVIDERS } from "./providers";
import { accountOutlook, byUseOrder, outlookOf, redeemable, resetScope, weeklyWindows } from "./weekly";

export interface UsageInput {
  /** Every omp profile on disk, default first. */
  profiles: readonly ProfileUsage[];
  /**
   * `paseo.providers.listUsage()`, as Paseo gave it: what its own usage sources read. Absent where
   * only omp's logins are wanted, as for this plugin's own sources.
   */
  paseoUsage?: unknown;
  /** Why `paseo.providers.listUsage()` failed, when it did; null or absent when it did not. */
  paseoError?: string | null;
  /** Paseo's daemon config `providers`, as read; undefined when unread. */
  providers: unknown;
  env: DaemonEnv;
  agents: readonly AgentRef[];
  /** Epoch milliseconds: how soon limits reset and banked resets expire. */
  now: number;
  pinnedIdentity: PinLookup;
}

/**
 * `windowState` plus the time left where it decides what to do, for pills, which have no line of
 * their own for it: "26% ↓ 19h" resetting unused soon, "full, back 8h".
 */
function timedState(window: Window, now: number): string {
  const outlook = outlookOf(window, now);
  const state = windowState({ usedPct: window.usedPct, outlook });
  if (window.resetsAt === null) return state;
  const left = countdown(window.resetsAt - now);
  if (outlook === "reached") return `full, back ${left}`;
  return outlook === "unused" ? `${state} ${left}` : state;
}

/** `timedState` after the limit's short name: "7d 26% ↓ 19h", "5h full, back 30m". */
function timedLimit(window: Window, now: number): string {
  return `${window.shortLabel} ${timedState(window, now)}`;
}

function amount(value: number, unit: Balance["unit"]): string {
  return unit === "usd" ? usd(value) : `${Math.round(value).toLocaleString("en-US")} ${unit}`;
}

function balanceText({ used, limit, remaining, unit }: Pick<Balance, "used" | "limit" | "remaining" | "unit">): string {
  if (used !== null && limit !== null) return `${amount(used, unit)} of ${amount(limit, unit)}`;
  if (remaining !== null) return `${amount(remaining, unit)} left`;
  return "–";
}

/** A banked reset unused at expiry is lost, so a usable one expiring within this long asks for attention. */
const BANKED_EXPIRY_WARNING_MS = DAY_MS;

/** Banked resets grouped by what they clear, full ones first. */
function resetGroups(account: Account, now: number): AccountView["resets"] {
  const groups = new Map<string, AccountView["resets"][number]>();
  for (const reset of account.resets) {
    if (reset.expiresAt !== null && reset.expiresAt <= now) continue;
    const scope = resetScope(reset, account);
    const group = groups.get(scope) ?? { scope, count: 0, usable: 0, expiresAt: null, tone: "ok" };
    group.count += 1;
    if (reset.usable) group.usable += 1;
    if (reset.expiresAt !== null && (group.expiresAt === null || reset.expiresAt < group.expiresAt)) group.expiresAt = reset.expiresAt;
    if (reset.usable && reset.expiresAt !== null && reset.expiresAt - now < BANKED_EXPIRY_WARNING_MS) group.tone = "warning";
    groups.set(scope, group);
  }
  return [...groups.values()].toSorted((a, b) => Number(b.scope === "full") - Number(a.scope === "full") || a.scope.localeCompare(b.scope));
}

/** The part of an email before "@"; any other label as is. */
function localPart(label: string): string {
  return label.slice(0, Math.max(0, label.indexOf("@"))) || label;
}

/** "alice" for alice@example.com, or "alice@example" when another login shares the name; any other label as is. */
function shortName(label: string, labels: readonly string[]): string {
  const name = localPart(label);
  if (name === label || labels.filter((other) => other !== label && localPart(other) === name).length === 0) return name;
  return `${name}@${label.slice(name.length + 1).split(".")[0]}`;
}

/** The limits binding a session on `model`: account-wide windows plus its own model family's pool. */
function bindingWindows(account: Account, model: string | null): Window[] {
  return account.windows.filter((window) => window.modelFamily === null || (model?.includes(window.modelFamily) ?? false));
}

/** Limits besides the weekly ones that stop a session on `model` now: a reached 5h window, or its model's reached pool. */
function blockingWindows(account: Account, model: string | null): Window[] {
  const weekly = weeklyWindows(account);
  return bindingWindows(account, model).filter((window) => !weekly.includes(window) && window.usedPct >= 100);
}

/** Whether a session on `model` could move to this account now. */
function hasRoom(account: Account, model: string | null, now: number): boolean {
  if (account.problem !== null || accountOutlook(account, now) === "reached" || blockingWindows(account, model).length > 0) return false;
  return weeklyWindows(account).length > 0 || account.balances[0]?.tone !== "danger";
}

/** The weekly limits, then any other limit binding `model` that stops it now, by `timedLimit`; else a balance. */
function summarize(account: Account, model: string | null, now: number): Summary {
  if (account.problem !== null) return { text: "no usage data", tone: "warning", accent: false };
  const shown = [...weeklyWindows(account), ...blockingWindows(account, model)];
  const accent = weeklyWindows(account).some((window) => outlookOf(window, now) === "unused");
  if (shown.length > 0) {
    return {
      text: shown.map((window) => timedLimit(window, now)).join(" · "),
      tone: worstTone(shown.map((window) => window.tone)),
      accent,
    };
  }
  const [balance] = account.balances;
  if (balance) return { text: balanceText(balance), tone: balance.tone, accent };
  return { text: "no limits", tone: "ok", accent };
}

/** The fullest weekly limit, the gauge's needle. */
function fullestWeekly(account: Account): Window | undefined {
  return weeklyWindows(account).toSorted((a, b) => b.usedPct - a.usedPct)[0];
}

/** A composer pill's text: see `pillSchema`. */
function pillSummary(account: Account, model: string | null, labels: readonly string[], now: number): Summary {
  const { tone, accent } = summarize(account, model, now);
  const who = shortName(account.label, labels);
  if (account.problem !== null) return { text: `${who} · no usage data`, tone, accent };
  const fullest = fullestWeekly(account);
  const [balance] = account.balances;
  let head = who;
  if (fullest) head = `${who} ${timedState(fullest, now)}`;
  else if (balance) head = `${who} · ${balanceText(balance)}`;
  const stopping = blockingWindows(account, model).map((window) => timedLimit(window, now));
  return { text: [head, ...stopping].join(" · "), tone, accent };
}

/** The vendor when it has one account here, else the login's short name: "Codex", "alice". */
function accountName(account: Account, accounts: readonly Account[], labels: readonly string[]): string {
  const sameVendor = accounts.filter((other) => other.vendor === account.vendor).length;
  return sameVendor === 1 ? account.vendor : shortName(account.label, labels);
}

/**
 * The sidebar row: a short sentence, readable without the screen behind it, of the most pressing of
 * quota about to reset unused, "Codex: 75% expires in 17h"; a full reset worth redeeming, "redeem a
 * reset: alice"; a banked full reset expiring; how many accounts are full; reads that failed;
 * else how many accounts there are. `accounts` are in use order, so the first match is the one to act on.
 */
function overview(accounts: readonly Account[], views: readonly AccountView[], failed: boolean, now: number): Summary {
  const labels = accounts.map((account) => account.label);
  const name = (account: Account) => accountName(account, accounts, labels);
  const wasting = accounts.find((account) => accountOutlook(account, now) === "unused");
  const window = wasting && weeklyWindows(wasting).find((candidate) => outlookOf(candidate, now) === "unused");
  if (wasting && window && window.resetsAt !== null) {
    const text = `${name(wasting)}: ${percent(100 - window.usedPct)} expires in ${countdown(window.resetsAt - now, { largest: true })}`;
    return { text, tone: "ok", accent: true };
  }
  const freeable = accounts.find((account) => redeemable(account, now) !== null);
  if (freeable) return { text: `redeem a reset: ${name(freeable)}`, tone: "ok", accent: true };
  if (views.some((view) => view.resets.some((group) => group.scope === "full" && group.tone === "warning"))) {
    return { text: "a full reset expires within a day", tone: "warning", accent: false };
  }
  const full = accounts.filter((account) => accountOutlook(account, now) === "reached").length;
  if (full > 0) return { text: `${full} of ${accounts.length} accounts full`, tone: "danger", accent: false };
  const unread = views.filter((view) => view.problem !== null).length;
  if (unread > 0) return { text: `${plural(unread, "account")} without data`, tone: "warning", accent: false };
  if (failed) return { text: "a usage read failed", tone: "warning", accent: false };
  return { text: `${plural(views.length, "account")}, all fine`, tone: "ok", accent: false };
}

/** The same vendor's login, wherever it was read. */
function loginKey({ vendor, label }: Account): string {
  return `${vendor}|${label.toLowerCase()}`;
}

/**
 * omp's logins, then those only Paseo's own usage sources read. A login both read is omp's, as
 * omp knows its profiles and banked resets, with Paseo's numbers where omp has none.
 */
function mergeAccounts(omp: readonly Account[], paseo: readonly Account[]): Account[] {
  const byLogin = new Map(omp.map((account) => [loginKey(account), account]));
  const merged = [...omp];
  for (const account of paseo) {
    const twin = byLogin.get(loginKey(account));
    if (!twin) merged.push(account);
    else if (twin.problem !== null && account.problem === null) {
      const { windows, balances, plan, fetchedAt } = account;
      Object.assign(twin, { windows, balances, plan: twin.plan ?? plan, fetchedAt, problem: null });
    }
  }
  merged.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label));
  return merged;
}

/** Whether a Paseo usage source is one of this plugin's own. */
function isOurSource(sourceId: string): boolean {
  return USAGE_SOURCES.some(({ id }) => id === sourceId);
}

/** The usage view from raw reads: omp outputs per profile, Paseo's own sources, Paseo config, agents, and omp's session pins. */
export function buildUsageView(input: UsageInput): UsageView {
  const { now } = input;
  const read = readAccounts(input.profiles);
  // An account its source reports no limits for has nothing to show. Pace counts from the reading, not from now.
  const accounts = mergeAccounts(read.accounts, readPaseoAccounts(input.paseoUsage, isOurSource, now))
    .filter((account) => account.problem !== null || account.windows.length + account.balances.length > 0)
    .map((account) => ({
      ...account,
      windows: account.windows.map((window) => ({ ...window, runsOutAt: runsOutAt(window, account.fetchedAt, now) })),
    }))
    .toSorted(byUseOrder(now));
  const views = accounts.map((account): AccountView => {
    const { id, provider, vendor, label, organization, plan, profiles, fetchedAt, problem } = account;
    const weekly = weeklyWindows(account);
    const stopping = blockingWindows(account, null);
    const fullest = problem === null ? fullestWeekly(account) : undefined;
    const { tone, accent } = summarize(account, null, now);
    return {
      id,
      provider,
      label,
      organization,
      plan,
      profiles,
      fetchedAt,
      problem,
      title: `${vendor} · ${label}`,
      heading: organization ? `${vendor} · ${organization}` : vendor,
      windows: account.windows.map((window) => ({
        id: window.id,
        label: window.label,
        shortLabel: window.shortLabel,
        usedPct: window.usedPct,
        tone: window.tone,
        resetsAt: window.resetsAt,
        durationMs: window.durationMs,
        runsOutAt: window.runsOutAt,
        outlook: outlookOf(window, now),
        weekly: weekly.includes(window),
        stopsNow: stopping.includes(window),
      })),
      balances: account.balances.map((balance) => ({ ...balance, text: balanceText(balance) })),
      resets: resetGroups(account, now),
      redeem: redeemable(account, now),
      tone,
      accent,
      fullestWeekly: fullest?.id ?? null,
      usedPct: problem === null ? (fullest?.usedPct ?? account.balances[0]?.usedPct ?? null) : null,
    };
  });
  const bound = bindAgents(input, read.logins);
  const pills: UsageView["pills"] = {};
  const labels = accounts.map((account) => account.label);
  for (const ref of input.agents) {
    // Paseo's own providers read one sign-in each; only a sole one is surely the agent's.
    const signIns = accounts.filter((account) => account.profiles.length === 0 && account.provider === ref.provider);
    const account = accounts.find((candidate) => candidate.id === bound[ref.agentId]) ?? (signIns.length === 1 ? signIns[0] : undefined);
    if (!account) continue;
    // Same-vendor omp logins with room left, in use order: where this session could move.
    const others = accounts
      .filter(
        (other) =>
          other.provider === account.provider && other.id !== account.id && other.profiles.length > 0 && hasRoom(other, ref.model, now),
      )
      .map((other) => ({ accountId: other.id, ...summarize(other, ref.model, now) }));
    pills[ref.agentId] = { accountId: account.id, ...pillSummary(account, ref.model, labels, now), others };
  }
  const fetched = accounts.flatMap((account) => (account.fetchedAt === null ? [] : [account.fetchedAt]));
  const errors = [
    ...read.errors.map(({ profile, message }) => ({ source: `omp profile ${profile}`, message, profile })),
    ...(input.paseoError ? [{ source: "Paseo", message: input.paseoError }] : []),
  ];
  return {
    accounts: views,
    overview: overview(accounts, views, errors.length > 0, now),
    pills,
    fetchedAt: fetched.length > 0 ? Math.min(...fetched) : null,
    errors,
  };
}

/** One source per named provider on Paseo's Usage screen, then one for every other provider. */
export interface UsageSource {
  id: string;
  label: string;
  /** Whether it reports this omp provider's logins. */
  owns(provider: string): boolean;
}

export const USAGE_SOURCES: readonly UsageSource[] = [
  ...Object.entries(PROVIDERS).map(([provider, { name }]) => ({
    id: `omp-${provider}`,
    label: `${name} (omp)`,
    owns: (id: string) => id === provider,
  })),
  { id: "omp", label: "omp", owns: (id: string) => !(id in PROVIDERS) },
];

/** Vendors whose omp sessions Paseo's built-in sources already report; ours would be a second card. */
const BUILT_IN_SESSION_VENDORS: Record<string, true> = { anthropic: true };

/** The logins a Usage-screen scope lists: those of one omp profile and vendor, every one when both are absent. */
export interface LoginFilter {
  profile?: string;
  vendor?: string;
}

/**
 * Global scopes list every login; an omp session, those of its profile and model vendor; any
 * other session, none (null). A session whose env moves omp's store elsewhere has logins this
 * plugin does not read.
 */
export function scopeLogins(scope: UsageScope, daemonEnv: DaemonEnv): LoginFilter | null {
  if (scope.kind === "global") return {};
  const vendor = scope.provider === "omp" ? ompVendorOf(scope.model ?? null) : null;
  if (vendor === null) return null;
  const { env } = scope;
  const moved = (["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "XDG_DATA_HOME"] as const).some(
    (key) => env[key] !== undefined && env[key] !== daemonEnv[key],
  );
  if (moved || BUILT_IN_SESSION_VENDORS[vendor] === true) return null;
  return { profile: profileOf(env), vendor };
}

/**
 * One entry per profile holding a login: Paseo merges equal keys into one card and falls back
 * through the profiles in order. omp pins one login per session, which the scope does not name.
 */
export function discoverAccounts(source: UsageSource, filter: LoginFilter, accounts: readonly AccountView[]): UsageAccount[] {
  return accounts
    .filter((account) => source.owns(account.provider) && (filter.vendor === undefined || account.provider === filter.vendor))
    .flatMap((account) =>
      account.profiles
        .filter((profile) => filter.profile === undefined || profile === filter.profile)
        .map((profile) => ({
          key: account.id,
          // The catch-all source mixes vendors, so its entries name theirs.
          label: source.id === "omp" ? account.title : account.label,
          harness: "OMP",
          input: { profile, account: account.id },
        })),
    );
}

/** "2026-12-10" for an epoch-millisecond time. */
function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Paseo's Usage screen words resets and pace itself, inline with each limit. Only weekly limits are
 * summary windows, so its sidebar strip pins them alone. Details lead with what to do: use the account
 * before quota resets unused, or redeem a full reset; their times are on the limit's own line.
 */
export function toUsageReport(account: AccountView): UsageReport {
  if (account.problem !== null) {
    return { status: "unavailable", problem: { kind: "no_quota", detail: account.problem } };
  }
  const details: UsageDetail[] = [];
  for (const window of account.windows) {
    if (window.outlook !== "unused") continue;
    const value = `${percent(100 - window.usedPct)} of ${window.label} resets unused`;
    details.push({ id: `use-first-${window.id}`, label: "↓ Use first", value, tone: "warning" });
  }
  if (account.redeem) {
    details.push({ id: "redeem", label: "⟲ Redeem a full reset", value: "weekly limit reached for over a day", tone: "warning" });
  }
  if (account.resets.length > 0) {
    details.push({ id: "banked-resets", label: "Banked resets", value: resetsText(account.resets, isoDate) });
  }
  if (account.organization) {
    details.push({ id: "organization", label: "Organization", value: account.organization });
  }
  return {
    status: "available",
    ...(account.plan === null ? {} : { planLabel: account.plan }),
    // With the window's length and the reading's time, Paseo's Usage screen shows each window's pace.
    ...(account.fetchedAt === null ? {} : { observedAt: new Date(account.fetchedAt).toISOString() }),
    windows: account.windows.map(({ id, label, shortLabel, weekly, usedPct, resetsAt, durationMs, tone }) =>
      windowFromUsedPct({
        id,
        label,
        shortLabel,
        summary: weekly,
        utilizationPct: usedPct,
        resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
        ...(durationMs === null ? {} : { durationSeconds: durationMs / 1_000 }),
        tone,
      }),
    ),
    balances: account.balances.map(({ id, label, unit, used, limit, remaining, resetsAt, tone }) => ({
      id,
      label,
      unit,
      used,
      limit,
      remaining,
      resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
      tone,
    })),
    details,
  };
}
