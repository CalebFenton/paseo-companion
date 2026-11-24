/** Needle positions: the share used rounds to the nearest of these steps, so each pill re-renders only on a visible move. */
const STEP_PCT = 5;

/** `usedPct` rounded to the needle's step, from 0 to 100. */
export function gaugeStep(usedPct: number): number {
  return Math.min(100, Math.max(0, Math.round(usedPct / STEP_PCT) * STEP_PCT));
}

/**
 * Lucide's Gauge with its needle at `step` (see `gaugeStep`): the dial's left end at 0%, its right
 * end at 100%. The dial is Lucide's own, a 240° arc about (12, 14), so the icon sits with Paseo's
 * other icons. `currentColor` takes the color the pill passes.
 */
export function gaugeSvg(step: number): string {
  const angle = ((210 - 2.4 * step) * Math.PI) / 180;
  const x = (12 + 6 * Math.cos(angle)).toFixed(2);
  const y = (14 - 6 * Math.sin(angle)).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14L${x} ${y}"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>`;
}
