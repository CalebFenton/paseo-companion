/**
 * Gives Paseo projects recognizable icons, from `project-icons.json` beside this script, a local file
 * that git ignores (`project-icons.example.json` shows its form): each project root path maps to a
 * Lucide glyph (a file name in lucide-static's `icons/`, such as "shield-check") and a background color.
 * Each icon is a rounded square in that color with the glyph in white, a 256 px PNG: Paseo takes PNG,
 * JPEG, GIF, or WebP, not SVG. Paseo keeps the uploaded bytes itself; nothing is written here.
 *
 *   npm run icons                     uploads an icon for every project in the spec
 *   npm run icons -- --out <dir>      writes the PNGs to <dir> instead, to look at first
 *   npm run icons -- --reset <root>   puts the project at <root> back on Paseo's automatic icon
 *
 * Projects missing from the spec keep whatever icon they have.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import { connectToDaemon } from "./daemon.ts";

const SIZE = 256;
/** The glyph's share of the icon: Lucide draws in a 24-unit box, with its own 2-unit padding. */
const GLYPH = 160;

const specSchema = z.record(
  z.string(),
  z.object({ glyph: z.string().regex(/^[a-z0-9-]+$/), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
);
type Entry = z.infer<typeof specSchema>[string];

const projectsSchema = z.object({
  projects: z.array(z.object({ projectId: z.string(), projectRootPath: z.string() })),
});

const require = createRequire(import.meta.url);

/** The glyph's drawing, without its own `<svg>` wrapper: its paths and shapes. */
function glyphBody(glyph: string): string {
  const svg = readFileSync(require.resolve(`lucide-static/icons/${glyph}.svg`), "utf8");
  const open = svg.indexOf(">", svg.indexOf("<svg")) + 1;
  return svg.slice(open, svg.lastIndexOf("</svg>"));
}

function iconPng({ glyph, color }: Entry): Buffer {
  const scale = GLYPH / 24;
  const offset = (SIZE - GLYPH) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" rx="${SIZE * 0.22}" fill="${color}"/>
<g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyphBody(glyph)}</g>
</svg>`;
  return new Resvg(svg).render().asPng();
}

const { values } = parseArgs({ options: { out: { type: "string" }, reset: { type: "string" } } });
const spec = specSchema.parse(JSON.parse(readFileSync(new URL("./project-icons.json", import.meta.url), "utf8")));
const icons = Object.entries(spec).map(([root, entry]) => ({ root, png: iconPng(entry) }));

if (values.out === undefined) {
  const client = await connectToDaemon(["listProjects", "setProjectIcon", "close"]);
  try {
    const { projects } = projectsSchema.parse(await client.listProjects());
    const idByRoot = new Map(projects.map(({ projectId, projectRootPath }) => [projectRootPath, projectId]));
    const targets = values.reset === undefined ? icons : [{ root: values.reset, png: null }];
    for (const { root, png } of targets) {
      const projectId = idByRoot.get(root);
      if (projectId === undefined) {
        console.warn(`skipped ${root}: no Paseo project has this root path`);
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- one upload at a time, each logged as it lands
      await client.setProjectIcon(projectId, png ? { type: "upload", data: png.toString("base64") } : { type: "automatic" });
      console.log(`${png ? "set" : "reset"} ${root}${png ? ` (${png.length} bytes)` : ""}`);
    }
  } finally {
    await client.close();
  }
} else {
  mkdirSync(values.out, { recursive: true });
  for (const { root, png } of icons) writeFileSync(join(values.out, `${basename(root)}.png`), png);
  console.log(`Wrote ${icons.length} icons to ${values.out}`);
}
