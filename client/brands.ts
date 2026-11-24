import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginIcon } from "@getpaseo/plugin/client";
import { siClaude, siCursor, siGithubcopilot, siGoogle, siGooglegemini, siKimi, siOllama, siX } from "simple-icons";

interface Brand {
  icon: PluginIcon;
  /** The brand's own color; null for a black mark, which takes the theme's text color to show on dark themes. */
  color: string | null;
}

/** A simple-icons mark as Paseo's inline SVG; Paseo draws `currentColor` in the color the icon is given. */
function brand({ path, hex }: { path: string; hex: string }): Brand {
  return {
    icon: { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="${path}"/></svg>` },
    color: hex === "000000" ? null : `#${hex}`,
  };
}

/**
 * Logos by vendor name, as `providerName` and Paseo's usage sources word them. simple-icons has no
 * OpenAI mark, at OpenAI's request, so Codex and any vendor missing here get a neutral glyph.
 */
const BRANDS: Record<string, Brand> = {
  Claude: brand(siClaude),
  Gemini: brand(siGooglegemini),
  Antigravity: brand(siGoogle),
  Copilot: brand(siGithubcopilot),
  Grok: brand(siX),
  Cursor: brand(siCursor),
  Ollama: brand(siOllama),
  Kimi: brand(siKimi),
};

const NEUTRAL: Brand = { icon: "Bot", color: null };

export function brandOf(vendor: string, theme: PluginTheme): { icon: PluginIcon; color: string } {
  const { icon, color } = BRANDS[vendor] ?? NEUTRAL;
  return { icon, color: color ?? theme.colors.foreground };
}
