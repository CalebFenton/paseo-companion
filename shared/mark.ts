/**
 * The mark: six corner brackets of a pointy-top hexagon around a ring with an eye. The
 * measurements, colours and motion follow the brand this plugin shares with the author's other
 * projects, in a 100-unit box centred on the origin; keep them equal to that brand's.
 */
const FRAME_R = 46;
const ARM = 13;
const FRAME_W = 3.8;
const CORE_R = 21;
const CORE_W = 5;
const EYE_R = 7.5;

type Point = readonly [number, number];

/** The frame's colours clockwise from the top corner, every 60°, and the ring's and the eye's. */
interface Palette {
  spectrum: readonly [string, string, string, string, string, string];
  ring: string;
  eye: string;
}

const SIGNAL = "#4fd1ff";
const AZURE = "#7a9cff";
const CORTEX = "#a78bfa";
const SYNAPSE = "#f472b6";
export const ON_DARK: Palette = { spectrum: [SIGNAL, AZURE, CORTEX, SYNAPSE, CORTEX, AZURE], ring: "#d6ebff", eye: SIGNAL };
export const ON_LIGHT: Palette = {
  spectrum: ["#0a86b8", "#3d56d6", "#6d45d8", "#c22a7a", "#6d45d8", "#3d56d6"],
  ring: "#0b2a44",
  eye: "#0a86b8",
};

const num = (v: number) => (Math.abs(v) < 0.005 ? "0" : v.toFixed(2));

function corner(k: number): Point {
  const a = ((-90 + 60 * (k % 6)) * Math.PI) / 180;
  return [FRAME_R * Math.cos(a), FRAME_R * Math.sin(a)];
}

function toward(from: Point, to: Point): Point {
  const t = ARM / FRAME_R;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/** Each bracket as its two arm ends and the corner between them, clockwise from the top. */
const BRACKETS: readonly (readonly [Point, Point, Point])[] = [0, 1, 2, 3, 4, 5].map((k) => {
  const v = corner(k);
  return [toward(v, corner(k + 5)), v, toward(v, corner(k + 1))];
});

function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** The spectrum at a point's angle, clockwise from the top, blended between its 60° stops. */
function spectrumAt(palette: Palette, [x, y]: Point): string {
  const deg = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
  const i = Math.floor(deg / 60);
  const t = deg / 60 - i;
  const a = hexToRgb(palette.spectrum[i % 6] ?? SIGNAL);
  const b = hexToRgb(palette.spectrum[(i + 1) % 6] ?? SIGNAL);
  const rgb = a.map((c, j) => Math.round(c + ((b[j] ?? c) - c) * t));
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

interface MarkOptions {
  palette: Palette;
  /** Stroke weight over the brand's; 1.5 below 24 px, as the brand's favicon draws it. */
  weight?: number;
  /** Blend each bracket along the spectrum with gradients named from this prefix; solid without it. */
  gradientId?: string;
}

/** The six brackets: `defs` holds their gradients, `body` their paths. */
export function frameParts({ palette, weight = 1, gradientId }: MarkOptions): { defs: string; body: string } {
  const defs: string[] = [];
  const body = BRACKETS.map(([a, v, b], k) => {
    let stroke = palette.spectrum[k] ?? SIGNAL;
    if (gradientId) {
      const id = `${gradientId}-${k}`;
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(a[0])}" y1="${num(a[1])}" x2="${num(b[0])}" y2="${num(b[1])}">` +
          `<stop offset="0" stop-color="${spectrumAt(palette, a)}"/><stop offset="0.5" stop-color="${spectrumAt(palette, v)}"/>` +
          `<stop offset="1" stop-color="${spectrumAt(palette, b)}"/></linearGradient>`,
      );
      stroke = `url(#${id})`;
    }
    return (
      `<path class="bracket b${k}" d="M${num(a[0])} ${num(a[1])}L${num(v[0])} ${num(v[1])}L${num(b[0])} ${num(b[1])}" fill="none" ` +
      `stroke="${stroke}" stroke-width="${num(FRAME_W * weight)}" stroke-linecap="square" stroke-linejoin="miter"/>`
    );
  });
  return { defs: defs.join(""), body: body.join("") };
}

/** The ring and the eye. */
export function coreParts({ palette, weight = 1 }: MarkOptions): { ring: string; eye: string } {
  return {
    ring: `<circle class="ring" r="${CORE_R}" fill="none" stroke="${palette.ring}" stroke-width="${num(CORE_W * weight)}"/>`,
    eye: `<circle class="eye" r="${num(EYE_R * (1 + (weight - 1) * 0.4))}" fill="${palette.eye}"/>`,
  };
}

/** A self-contained SVG document in the mark's box. */
export function markSvg(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">${content}</svg>`;
}
