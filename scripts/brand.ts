/**
 * Draws `brand/hero.svg`, the README's banner: the mark beside the wordmark, whose text is
 * outlines so the file needs no font. Run `npm run brand` after a change to the mark
 * (`shared/mark.ts`) or to this layout. The font is Chakra Petch 700, under the SIL Open Font
 * License (`brand/fonts/`).
 *
 * The banner moves the way the mark does at rest: it breathes, its eye glances about, and a
 * bracket winks now and then. It holds still under reduced motion.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { create, type Font } from "fontkit";
import { coreParts, frameParts, ON_DARK } from "../shared/mark.ts";

const ROOT = new URL("../brand/", import.meta.url);
const FONT = new URL("fonts/chakra-petch-700.woff2", ROOT);
const OUT = new URL("hero.svg", ROOT);

const W = 1200;
const H = 340;
const NIGHT = "#03060b";
const DEEP = "#0d1f33";
const FROST = "#d6ebff";
const DIM = "#7894b0";

const MARK_X = 190;
const MARK_SCALE = 2.3;
const TEXT_X = 360;
const TEXT_RIGHT = W - 64;
const TAG_CAP = 22;
const TAG_GAP = 24;

function loadFont(): Font {
  const font = create(readFileSync(FONT));
  if (!("layout" in font)) throw new Error(`${FONT.pathname} is a collection, not one font`);
  return font;
}

/** `text` as one path with its left edge at x 0 and its baseline at y 0, `cap` tall, tracked by `tracking` em. */
function outline(font: Font, text: string, cap: number, tracking: number): { d: string; width: number } {
  const scale = cap / font.capHeight;
  const run = font.layout(text);
  const parts: string[] = [];
  let x = 0;
  run.glyphs.forEach((glyph, i) => {
    parts.push(glyph.path.scale(scale, -scale).translate(x, 0).toSVG());
    x += (run.positions[i]?.xAdvance ?? glyph.advanceWidth) * scale + tracking * font.unitsPerEm * scale;
  });
  return { d: parts.join(""), width: x - tracking * font.unitsPerEm * scale };
}

/** A pointy-top hexagon's outline, `r` from centre to corner. */
function hex(cx: number, cy: number, r: number): string {
  const corners = [0, 1, 2, 3, 4, 5].map((k) => {
    const a = ((-90 + 60 * k) * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  });
  return `M${corners.join("L")}Z`;
}

const STYLE = `
  .frame { transform-box: fill-box; transform-origin: center; animation: breath 6s ease-in-out infinite; }
  .eye { animation: glance 9s cubic-bezier(0.6, 0, 0.2, 1) infinite; }
  .b1 { animation: wink 7s ease-out infinite; }
  @keyframes breath { 50% { transform: scale(1.025); } }
  @keyframes glance {
    0%, 16%, 100% { transform: translate(0, 0); }
    20%, 38% { transform: translate(5px, -3px); }
    42%, 60% { transform: translate(-4.5px, 2px); }
    64%, 84% { transform: translate(0, 0); }
  }
  @keyframes wink { 0%, 88%, 100% { transform: translate(0, 0); } 91% { transform: translate(3px, -1.7px); } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
`;

function hero(font: Font): string {
  const title = outline(font, "PASEO COMPANION", 46, 0.32);
  const fit = Math.min(1, (TEXT_RIGHT - TEXT_X) / title.width);
  const titleCap = 46 * fit;
  const titleWidth = title.width * fit;
  // Large enough to read at the about 0.3 scale GitHub's phone layout gives the banner.
  const tagline = outline(font, "USAGE · PULL REQUESTS · SYSTEM", TAG_CAP, 0.28);
  const tagScale = Math.min(1, titleWidth / tagline.width);
  const tagCap = TAG_CAP * tagScale;
  const frame = frameParts({ palette: ON_DARK, gradientId: "b" });
  const core = coreParts({ palette: ON_DARK });

  const r = 24;
  const cells: string[] = [];
  for (let row = -1; row * r * 1.5 < H + r; row++) {
    for (let col = -1; col * r * Math.sqrt(3) < W + r; col++) {
      cells.push(hex(col * r * Math.sqrt(3) + (row % 2 ? (r * Math.sqrt(3)) / 2 : 0), row * r * 1.5, r - 1.5));
    }
  }

  // The block from the title's cap line to the tagline's baseline, centred on the mark.
  const titleY = (H + titleCap - TAG_GAP - tagCap) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t">
<title id="t">Paseo companion: usage, pull requests, system</title>
<style>${STYLE.replaceAll(/\s+/g, " ").trim()}</style>
<defs>
${frame.defs}
<radialGradient id="glow" cx="${MARK_X}" cy="${H / 2}" r="420" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="${DEEP}" stop-opacity="0.95"/><stop offset="1" stop-color="${NIGHT}" stop-opacity="0"/></radialGradient>
<radialGradient id="fade" cx="${MARK_X}" cy="${H / 2}" r="900" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="${NIGHT}" stop-opacity="0"/><stop offset="1" stop-color="${NIGHT}" stop-opacity="0.9"/></radialGradient>
<clipPath id="card"><rect width="${W}" height="${H}" rx="24"/></clipPath>
</defs>
<g clip-path="url(#card)">
<rect width="${W}" height="${H}" fill="${NIGHT}"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<path d="${cells.join("")}" fill="none" stroke="#4fd1ff" stroke-opacity="0.07" stroke-width="1.2"/>
<rect width="${W}" height="${H}" fill="url(#fade)"/>
</g>
<g transform="translate(${MARK_X} ${H / 2}) scale(${MARK_SCALE})">
<g class="frame">${frame.body}</g>${core.ring}${core.eye}
</g>
<path transform="translate(${TEXT_X} ${titleY.toFixed(2)}) scale(${fit.toFixed(4)})" d="${title.d}" fill="${FROST}"/>
<path transform="translate(${TEXT_X + 2} ${(titleY + TAG_GAP + tagCap).toFixed(2)}) scale(${tagScale.toFixed(4)})" d="${tagline.d}" fill="${DIM}"/>
</svg>
`;
}

writeFileSync(OUT, hero(loadFont()));
console.log(`wrote ${OUT.pathname}`);
