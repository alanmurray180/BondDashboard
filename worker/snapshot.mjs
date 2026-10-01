#!/usr/bin/env node
/**
 * Build-time snapshot of the in-day health panel: writes live.json.
 *
 * The page polls the Worker's GET /live while it is open, but it must still
 * say something when the Worker is unreachable, not deployed, or blocked by
 * Yahoo. This runs the same live.js under Node on the GitHub runner — where
 * Yahoo's chart endpoint is proven to answer, it carries the COMEX gold
 * series — and build_dashboard.py bakes the result into the page.
 *
 * Never fails the build: the curves are the point of the page. Failures are
 * written into live.json and raised as a run annotation instead.
 *
 *   node worker/snapshot.mjs [out.json]
 */
import { writeFileSync } from "node:fs";
import { buildLive } from "./src/live.js";

const out = process.argv[2] || "live.json";
let payload;
try {
  payload = await buildLive("build");
} catch (e) {
  payload = { generated: new Date().toISOString(), source: "build", groups: [],
    errors: [{ symbol: "*", detail: String(e && e.message || e) }] };
}
writeFileSync(out, JSON.stringify(payload));
const n = payload.groups.reduce((a, g) => a + g.items.filter((i) => !i.error).length, 0);
console.error(`live snapshot: ${n} indicators, ${payload.errors.length} symbol error(s) -> ${out}`);
if (payload.errors.length && process.env.GITHUB_ACTIONS) {
  const d = payload.errors.map((e) => `${e.symbol}: ${e.detail}`).join(" · ").slice(0, 900);
  console.log(`::warning title=In-day quotes unavailable::${d}`);
}
