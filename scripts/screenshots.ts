/**
 * Draws the README's screenshots (`npm run screenshots`): Paseo's own web build, connected to the local
 * daemon, showing this plugin's screens with the views in `fixtures/` instead of live ones.
 *
 * The page never reaches the plugin: every paseo-companion request is answered here, from the fixtures,
 * so no account, pull request, or host of the machine running this can appear. Paseo's own sidebar
 * lists the machine's real workspaces, so each picture is cropped to the plugin's part of the window.
 * Look at every picture before committing it all the same.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import { z } from "zod";
import { PLUGIN_ID } from "../shared/plugin.ts";
import { pullRequestsFeed, pullRequestsRpc } from "../shared/pull-requests.ts";
import { systemFeed } from "../shared/system.ts";
import { usageFeed, usageRpc } from "../shared/usage.ts";
import { installedCli } from "./daemon.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "screenshots");
const WEB_UI = join(installedCli(), "node_modules", "@getpaseo", "server", "dist", "server", "web-ui");
/** Any free origin: the page's files are served from WEB_UI by route, and the app finds the daemon on its own. */
const ORIGIN = "http://127.0.0.1:6768";
const VIEWPORT = { width: 1400, height: 900 };

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, "fixtures", name), "utf8"));
}

const recordedAt = z.object({ now: z.number() });
const recordedPullRequests = pullRequestsRpc.output.parse({
  view: z.object({ view: z.unknown() }).parse(fixture("pull-requests.view.json")).view,
  fetchedAt: recordedAt.parse(fixture("pull-requests.input.json")).now,
  error: null,
});
const systemRanges = z
  .object({ views: z.tuple([z.object({ range: z.string() }), z.object({ range: z.string() })]) })
  .parse(fixture("system.input.json")).views;

/** The views a picture shows: the fixtures', without the read failures the tests put in them, so the screens show their normal state. */
const fixtures = {
  usage: { ...z.object({ view: usageFeed.event }).parse(fixture("usage.view.json")).view, errors: [] },
  pullRequests: { ...recordedPullRequests, view: recordedPullRequests.view && { ...recordedPullRequests.view, error: null } },
  system: z.object({ views: z.tuple([systemFeed.event, systemFeed.event]) }).parse(fixture("system.view.json")).views,
};
type Views = typeof fixtures;

/** What the plugin would have answered to `method`; null for a method the views do not cover. */
function answer(views: Views, method: string, input: unknown): unknown {
  switch (method) {
    case usageFeed.name:
    case usageRpc.name:
      return views.usage;
    case pullRequestsFeed.name:
    case pullRequestsRpc.name:
      return views.pullRequests;
    case systemFeed.name: {
      const { history } = systemFeed.input.parse(input);
      return history?.range === systemRanges[1].range ? views.system[1] : views.system[0];
    }
    default:
      return null;
  }
}

const pluginRequest = z.object({
  type: z.literal("session"),
  message: z.object({
    type: z.enum(["plugin.rpc.subscribe.request", "plugin.rpc.invoke.request"]),
    requestId: z.string(),
    pluginId: z.literal(PLUGIN_ID),
    method: z.string(),
    input: z.unknown(),
  }),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Passes the app's traffic to the daemon, except this plugin's, which it answers with `views`.
 * The daemon is reached from Node rather than through the page: it refuses the page's made-up origin.
 */
function stubPlugin(views: Views, page: WebSocketRoute): void {
  const daemon = new WebSocket(page.url());
  daemon.binaryType = "arraybuffer";
  const queued: (string | Buffer)[] = [];
  daemon.addEventListener("open", () => {
    for (const frame of queued.splice(0)) daemon.send(frame);
  });
  daemon.addEventListener("message", (event: { data: unknown }) => {
    if (typeof event.data === "string") page.send(event.data);
    else if (event.data instanceof ArrayBuffer) page.send(Buffer.from(event.data));
  });
  daemon.addEventListener("close", () => void page.close());
  page.onClose(() => daemon.close());
  const subscriptions = new Set<string>();
  const reply = (message: unknown) => page.send(JSON.stringify({ type: "session", message }));
  page.onMessage((frame) => {
    const text = typeof frame === "string" ? frame : null;
    const request = text === null ? null : pluginRequest.safeParse(parseJson(text));
    if (request?.success) {
      const { type, requestId, method, input } = request.data.message;
      const output = answer(views, method, input);
      if (type === "plugin.rpc.invoke.request") {
        reply({
          type: "plugin.rpc.invoke.response",
          payload: output === null ? { requestId, error: `No fixture for ${method}` } : { requestId, output },
        });
        return;
      }
      const subscriptionId = randomUUID();
      subscriptions.add(subscriptionId);
      reply({ type: "plugin.rpc.subscribe.response", payload: { requestId, subscriptionId } });
      reply(
        output === null
          ? { type: "plugin.rpc.closed", payload: { subscriptionId, error: `No fixture for ${method}` } }
          : { type: "plugin.rpc.event", payload: { subscriptionId, event: output } },
      );
      return;
    }
    // Ending a subscription made here is not the daemon's business.
    if (text !== null && [...subscriptions].some((id) => text.includes(id))) return;
    if (daemon.readyState === WebSocket.OPEN) daemon.send(frame);
    else queued.push(frame);
  });
}

async function openPaseo(page: Page, now: number, views: Views): Promise<void> {
  // The client words times relative to the clock ("Updated 2m ago"), so it reads the fixture's time.
  await page.clock.setFixedTime(now);
  await page.route(`${ORIGIN}/**`, (route) => {
    const file = join(WEB_UI, decodeURIComponent(new URL(route.request().url()).pathname));
    const served = existsSync(file) && statSync(file).isFile() ? file : join(WEB_UI, "index.html");
    return route.fulfill({ body: readFileSync(served), contentType: CONTENT_TYPES[extname(served)] ?? "application/octet-stream" });
  });
  await page.routeWebSocket(/.*/, (route) => stubPlugin(views, route));
  await page.goto(ORIGIN);
}

/** Paseo's footer row for one of this plugin's screens: `pull-requests`, `usage`, or `system`. */
function footerRow(page: Page, screen: string) {
  return page.getByTestId(`plugin-sidebar-footer-${PLUGIN_ID}-${screen}`);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error(`${locator.toString()} is not on screen`);
  return found;
}

/** The plugin's three footer rows only: Paseo's own row above them shows the machine's real accounts. */
async function shootFooter(page: Page, file: string): Promise<void> {
  const sidebar = await box(page.getByTestId("sidebar-footer"));
  const top = (await box(footerRow(page, "pull-requests"))).y - 8;
  const system = await box(footerRow(page, "system"));
  await page.screenshot({
    path: join(OUT, file),
    clip: { x: 0, y: top, width: sidebar.width, height: system.y + system.height + 8 - top },
  });
}

/** Opens the screen behind the footer row `screen` and waits for `text` to show on it. */
async function openScreen(page: Page, screen: string, text: string): Promise<void> {
  await footerRow(page, screen).click();
  await page.getByText(text, { exact: true }).first().waitFor();
}

/** Shoots the window right of the sidebar, where the open screen is. */
async function shootScreen(page: Page, screen: string): Promise<void> {
  // Lets charts lay out and the mark finish a step.
  await page.waitForTimeout(1_500);
  const sidebar = await box(page.getByTestId("sidebar-footer"));
  const left = Math.ceil(sidebar.x + sidebar.width);
  await page.screenshot({
    path: join(OUT, `${screen}.png`),
    clip: { x: left, y: 0, width: VIEWPORT.width - left, height: VIEWPORT.height },
  });
}

async function shoot(now: number, views: Views, take: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    await openPaseo(page, now, views);
    await footerRow(page, "system").waitFor();
    await take(page);
  } finally {
    await context.close();
  }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const usageNow = recordedAt.parse(fixture("usage.input.json")).now;
  await shoot(usageNow, fixtures, async (page) => {
    await page.getByText(fixtures.usage.overview?.text ?? "", { exact: true }).waitFor();
    await shootFooter(page, "sidebar-alert.png");
    await openScreen(page, "usage", fixtures.usage.accounts[0]?.label ?? "");
    await shootScreen(page, "usage");
  });
  // With no quota about to reset unused, the Usage row shows each login's week instead.
  await shoot(usageNow, { ...fixtures, usage: { ...fixtures.usage, overview: null } }, async (page) => {
    await page.waitForTimeout(1_500);
    await shootFooter(page, "sidebar-calm.png");
  });
  await shoot(fixtures.pullRequests.fetchedAt ?? 0, fixtures, async (page) => {
    await openScreen(page, "pull-requests", fixtures.pullRequests.view?.sections[0]?.rows[0]?.title ?? "");
    await shootScreen(page, "pull-requests");
  });
  await shoot(recordedAt.parse(fixture("system.input.json")).now, fixtures, async (page) => {
    await openScreen(page, "system", "CPU");
    // The range the first recorded view covers, so the charts' labels match their bars.
    await page.getByText(systemRanges[0].range, { exact: true }).click();
    await shootScreen(page, "system");
  });
} finally {
  await browser.close();
}
