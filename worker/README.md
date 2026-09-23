# Bond monitor refresh Worker

A Cloudflare Worker that triggers the dashboard rebuild on a schedule, because
GitHub's own `schedule:` trigger cannot be relied on to do it.

## Why this exists

The page is only as fresh as its last successful build, and GitHub's scheduler
is best-effort. Through late August 2026 the delay on this repository grew from
about 30 minutes to 8+ hours, whole firings went missing, and the page sat three
days stale under a green tick. The workflow answered that by going from two
windows a day to seven — redundancy that helps, but cannot fix a scheduler that
stops delivering.

`workflow_dispatch` has succeeded on every attempt. So the schedule lives here
and GitHub is only asked to run the build. The `schedule:` block stays in
`build.yml` as a free backstop: duplicate builds are harmless, the `concurrency`
group serialises them, and Actions is free on a public repo.

## What it does

Fires `40 6-22 * * 1-5` UTC and builds on seven of those firings — the windows
below, anchored to **London local time**:

| London | Window |
| --- | --- |
| 07:40 | ahead of the BoE GLC current-month file (~08:00 London) — carries the prior session |
| 09:40 | after the BoE GLC publication |
| 12:40 | redundancy |
| 15:40 | redundancy |
| 17:40 | Bundesbank same-day curve, before the US close |
| 20:40 | redundancy |
| 22:40 | after the US Treasury close — the day's par curve |

**Why London and not UTC.** Every publisher the build reads works to a local
clock: the BoE files land around 08:00 London, the Bundesbank posts on CET, the
US Treasury posts after its own 16:00 New York close — and London and New York
hold a constant 5h offset for all but about three weeks a year. A UTC-pinned
schedule therefore sits an hour early against all three every winter, which made
the evening US window (21:40 UTC = 16:40 New York in GMT) tight enough to miss
the Treasury post. In BST these seven windows are identical to the UTC crons the
workflow has always used; in GMT they hold where they were tuned instead of
sliding forward an hour.

Cloudflare cron is UTC-only too, hence the broad hourly trigger and the gate
inside the Worker. Gating here is safe in a way it was not inside the GitHub
workflow: Cloudflare fires punctually, so the gate rejects only the slot it is
meant to, not a genuine refresh that arrived late. Ten firings a day are
deliberate no-ops and log as `skipped:`.

## Deploy

A Cloudflare account on the free plan is enough, and you do **not** need a
domain — the Worker is reachable on a `workers.dev` subdomain. Sign up at
<https://dash.cloudflare.com/sign-up>.

There are two routes. Connecting the repository is the better default: the
schedule and configuration stay version-controlled instead of living only in
dashboard forms, and a push redeploys.

### Route A — connect the repository (Workers Builds)

> **Set the root directory to `worker`.** This is the one setting that matters
> and the one that is easy to miss. Everything else is read from
> `wrangler.toml`.

> **Keep `name` in `wrangler.toml` equal to the Worker's name in Cloudflare.**
> The cron trigger and the secrets attach to a named Worker, so if the two
> disagree, `wrangler deploy` creates a second Worker under the other name —
> leaving the cron firing on one and `GITHUB_TOKEN` set on the other. Each looks
> healthy on its own and nothing ever dispatches. It is currently
> `bonddashboard`; rename both together or neither.

In the Cloudflare dashboard, create a Worker from your Git repository, then
under the Worker's **Settings → Build** (labels move around; the field is
sometimes behind an "Advanced" toggle):

| Setting | Value |
| --- | --- |
| Root directory | `worker` |
| Build command | *(leave empty — no dependencies to install)* |
| Deploy command | `npx wrangler deploy` |

Without the root directory, the build runs at the repository root, wrangler
finds no `wrangler.toml`, assumes you meant a static site, and fails with
`Could not detect a directory containing static files`. That error names the
wrong problem — nothing is wrong with the Worker, wrangler simply never saw it.
A giveaway in the log is the build running `pip install`: that is Cloudflare
finding the Python toolkit at the root, which has nothing to do with this Worker.

Because `wrangler.toml` is committed, this route applies **`[vars]` and the cron
trigger automatically**. Only the secrets below need adding by hand.

### Route B — deploy from a local machine

```bash
cd worker
npm install -g wrangler      # or use `npx wrangler` throughout
wrangler login               # opens a browser, stores a token locally
wrangler deploy              # deploy first, so the Worker exists
```

If the account has more than one Cloudflare account attached, wrangler will ask
which to use; add the chosen `account_id` to `wrangler.toml` to stop it asking
again. For CI instead of a laptop, skip `wrangler login` and set
`CLOUDFLARE_API_TOKEN` from an API token built on Cloudflare's **Edit Cloudflare
Workers** template.

Deploy before setting secrets either way: `wrangler secret put` against a Worker
that does not exist yet prompts to create one, which is confusing. Until the
secrets are set the Worker runs and logs `GITHUB_TOKEN secret is not set` on
each firing rather than failing — harmless.

### The GitHub token, for either route

A fine-grained personal access token at
<https://github.com/settings/personal-access-tokens/new>:

- Repository access: **only** `alanmurray180/BondDashboard`
- Permissions → Repository → **Actions: Read and write**
- Nothing else. That permission is all `workflow_dispatch` needs — it cannot
  read code or touch other repositories.
- Note the expiry date — see *If it stops working* below.

### The secrets, for either route

They never go in the repo, and they take effect immediately without
redeploying. From the dashboard, add them under **Settings → Variables and
Secrets** as the encrypted/secret type; from a terminal:

```bash
wrangler secret put GITHUB_TOKEN     # paste the token
wrangler secret put TRIGGER_KEY      # optional: any long random string
```

`TRIGGER_KEY` is only for the manual endpoint. Leaving it unset does not open
the endpoint up — it makes it answer `401` to everything, which is the safe
default.

## Verify

Trigger it by hand without waiting for the cron — this is also the "rebuild now"
button that a public static page cannot safely have:

```bash
curl -X POST https://bonddashboard.<your-subdomain>.workers.dev/ \
     -H "X-Trigger-Key: <your TRIGGER_KEY>"
```

Expect `202` and `{"ok": true, "status": 204, "detail": "dispatched"}`, then a
new run in the repo's Actions tab within seconds. Without the header you get
`401`, so the public URL cannot be used to spend your Actions minutes.

Watch scheduled firings live with `wrangler tail`, or in the dashboard under the
Worker's **Logs → Begin log stream** if you are not working from a terminal.
Each firing logs either `firing: Wed 09:40 London — after the BoE GLC
publication` or `skipped: Wed 10:40 London is not a build window` — the second
is correct behaviour on the ten non-window firings, not a fault.

## Cost

Cloudflare's free plan covers 100,000 Worker requests a day and cron triggers
are included. This uses seventeen invocations a working day.

## If it stops working

- **Build fails with `Could not detect a directory containing static files`** →
  the root directory is not set to `worker`. See Route A above. The build log
  will also show it running `pip install`, which is the tell.
- `401` or `403` from GitHub → the token expired or lacks **Actions: Read and
  write**. Fine-grained tokens expire; set a calendar reminder.
- `404` → the token cannot see the repo, or `WORKFLOW_FILE` is wrong.
- Nothing in the logs at all → the cron trigger did not deploy. On Route A it
  comes from `[triggers]` in `wrangler.toml`, so check the build actually
  succeeded; on Route B check the Worker's Settings → Triggers.
- `GITHUB_TOKEN secret is not set` → the secret never landed, or was added to a
  different Worker than the one the cron is attached to.
- Dispatches succeed but the page is still stale → the failure is in the build,
  not the trigger. Check the Actions run: `fetch_rates.py` exits non-zero if any
  market drops out, and the page is not deployed when it does.
