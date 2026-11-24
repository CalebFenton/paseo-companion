import type { Avatar } from "../../shared/usage";

/** Glyphs with no color-emoji form, or forced to text by the U+FE0E selector, so every platform draws them in the avatar's color. */
const SYMBOLS = ["◆", "★", "▲", "●", "■", "♠", "♣", "♥", "♦", "☀", "☾", "✿", "♪", "✚", "⬢", "✦"].map((glyph) => `${glyph}\uFE0E`);
/** Hues that read on light and dark themes and stay apart from each other and from the warning, danger, and use-first blue colors. */
const COLORS = ["#14b8a6", "#8b5cf6", "#ec4899", "#65a30d", "#64748b"];

/** FNV-1a: a stable spread of an account id over the palettes, the same on every host and run. */
function hash(text: string): number {
  let value = 0x81_1c_9d_c5;
  for (const char of text) value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  return value;
}

/**
 * A glyph and color per account id, fixed for the account so its owner learns it: each takes the
 * glyph its id hashes to, or the next one free, so up to 16 accounts never share a glyph. Ids are
 * placed in sorted order, so a new account moves no other unless it takes a slot first.
 */
export function avatars(ids: readonly string[]): Map<string, Avatar> {
  const taken = new Set<string>();
  const result = new Map<string, Avatar>();
  for (const id of ids.toSorted()) {
    const start = hash(id);
    let symbol = SYMBOLS[start % SYMBOLS.length] ?? "●";
    for (let step = 1; taken.has(symbol) && step < SYMBOLS.length; step += 1) symbol = SYMBOLS[(start + step) % SYMBOLS.length] ?? "●";
    taken.add(symbol);
    result.set(id, { symbol, color: COLORS[(start >>> 8) % COLORS.length] ?? "#3b82f6" });
  }
  return result;
}
