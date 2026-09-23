/**
 * Cloudflare Worker that triggers the bond yield monitor rebuild on a schedule.
 *
 * GitHub's own cron is not dependable enough to carry this page. Through late
 * August 2026 delivery of the `schedule:` trigger in build.yml drifted from
 * ~30 minutes late to 8+ hours late, whole firings went missing, and the page
 * sat three days stale under a green tick. The workflow answered that with
 * seven redundant windows a day, which helps but does not fix a scheduler that
 * can stop delivering altogether. `workflow_dispatch`, by contrast, has
 * succeeded on every attempt, so the schedule lives here and GitHub is only
 * asked to run the build.
 *
 * The seven windows are anchored to London local time rather than UTC. Every
 * publisher the build reads from works to a local clock — the BoE GLC files
 * land around 08:00 London, the Bundesbank posts its same-day curve on CET,
 * the US Treasury posts the day's par curve after its own 16:00 New York
 * close — and London and New York keep a constant 5h offset for all but about
 * three weeks a year. A UTC-pinned schedule therefore sits an hour early
 * against all three every winter, which is what made the evening US window
 * (21:40 UTC = 16:40 New York in GMT) tight enough to miss the Treasury post.
 * Anchoring to London holds every window where it was tuned, year round.
 *
 * Cloudflare cron is UTC-only too, but gating here is safe in a way it was not
 * inside the GitHub workflow: Cloudflare fires punctually, so the gate rejects
 * only the slot it is meant to, not a genuine refresh that arrived late.
 */

/**
 * London hours the page rebuilds on, at :40 past, and what each one is for.
 * The intermediate windows are redundancy, not extra coverage: a build is ~40s
 * and the deploy is idempotent, so a dropped firing is picked up by the next.
 */
export const SLOTS = {
  7: "ahead of the BoE GLC current-month file (~08:00 London), prior session",
  9: "after the BoE GLC publication",
  12: "midday redundancy",
  15: "afternoon redundancy",
  17: "Bundesbank same-day curve, before the US close",
  20: "evening redundancy",
  22: "after the US Treasury close (17:40 New York), the day's par curve",
};

/**
 * Weekday and hour in London, so BST and GMT need no special handling.
 */
export function londonParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const got = {};
  for (const part of parts) got[part.type] = part.value;
  return { weekday: got.weekday, hour: parseInt(got.hour, 10) % 24 };
}

/**
 * The reason this firing should build, or null when it should be skipped.
 */
export function slotFor(date) {
  const { weekday, hour } = londonParts(date);
  if (weekday === "Sat" || weekday === "Sun") return null;
  return SLOTS[hour] || null;
}

/**
 * Ask GitHub to run the build workflow. Returns a plain result object rather
 * than throwing so both entry points can report it the same way.
 */
export async function dispatchWorkflow(env, reason) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const workflow = env.WORKFLOW_FILE;
  const url =
    `https://api.github.com/repos/${owner}/${repo}` +
    `/actions/workflows/${workflow}/dispatches`;

  if (!env.GITHUB_TOKEN) {
    return { ok: false, status: 0, detail: "GITHUB_TOKEN secret is not set" };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects API requests without a User-Agent.
      "User-Agent": `${repo}-refresh-worker`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GIT_REF || "main" }),
  });

  // A successful dispatch is 204 with an empty body.
  if (resp.status === 204) {
    console.log(`dispatched ${workflow} (${reason})`);
    return { ok: true, status: 204, detail: "dispatched" };
  }

  const detail = (await resp.text()).slice(0, 500);
  console.log(`dispatch failed ${resp.status} (${reason}): ${detail}`);
  return { ok: false, status: resp.status, detail };
}

export default {
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    const { weekday, hour } = londonParts(now);
    const slot = slotFor(now);

    if (!slot) {
      console.log(`skipped: ${weekday} ${hour}:40 London is not a build window`);
      return;
    }
    console.log(`firing: ${weekday} ${hour}:40 London — ${slot}`);
    ctx.waitUntil(dispatchWorkflow(env, `cron ${hour}:40 London`));
  },

  /**
   * Manual trigger, for testing the Worker without waiting for the cron.
   * Requires the TRIGGER_KEY secret, so the endpoint being public does not
   * mean anyone can spend your Actions minutes.
   */
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("POST with X-Trigger-Key to rebuild\n", {
        status: 405,
      });
    }
    if (!env.TRIGGER_KEY || request.headers.get("X-Trigger-Key") !== env.TRIGGER_KEY) {
      return new Response("unauthorised\n", { status: 401 });
    }

    const result = await dispatchWorkflow(env, "manual");
    return new Response(JSON.stringify(result, null, 2) + "\n", {
      status: result.ok ? 202 : 502,
      headers: { "Content-Type": "application/json" },
    });
  },
};
