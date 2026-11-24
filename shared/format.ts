export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** "45m", "3h 54m", "1d 19h"; `largest` keeps the first unit alone: "45m", "3h", "1d". */
export function countdown(ms: number, { largest = false } = {}): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 && !largest ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 && !largest ? `${days}d ${hours % 24}h` : `${days}d`;
}

function startOfDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Named here, not through Intl's weekday and month options, so every app shows the same day whatever Intl its engine carries.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The device's local time, always with its day: "Tue 2:40 PM" within six days, today included,
 * else "Oct 21, 2:40 PM", since a weekday alone would be ambiguous a week or more away.
 */
export function clockTime(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // Rounded: a day crossing a daylight saving change is 23 or 25 hours.
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days >= 0 && days < 7) return `${WEEKDAYS[date.getDay()]} ${time}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${time}`;
}

export function ago(ms: number): string {
  return ms < MINUTE_MS ? "just now" : `${countdown(ms)} ago`;
}

/** "1 pull request", "3 replies". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A whole percentage: "43%". */
export function percent(value: number): string {
  return `${Math.round(value)}%`;
}

/** The parts present, as one line: "3 full · 1 fable". */
export function joinParts(parts: readonly (string | null)[]): string {
  return parts.filter((part) => part !== null).join(" · ");
}

/** What a rejection says, whatever was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** US dollars to the cent: "$74.97". */
export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
