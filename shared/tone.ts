import { z } from "zod";

export const toneSchema = z.enum(["ok", "warning", "danger"]);
export type Tone = z.infer<typeof toneSchema>;

const RANK: Record<Tone, number> = { ok: 0, warning: 1, danger: 2 };

export function worstTone(tones: Iterable<Tone>): Tone {
  let worst: Tone = "ok";
  for (const tone of tones) if (RANK[tone] > RANK[worst]) worst = tone;
  return worst;
}
