# daily-snapshot
Daily traffic + signups email digest for Ryan's sites (EscapeFromUSA, CityPopn, RankLoft, Noozday). HaulTax removed 2026-10-10.

## Stack
- `scripts/daily-snapshot.ts` (copied from EscapeFromUSA/web, standalone): queries each site's Turso analytics tables, R2/Cloudinary usage, emails via Resend.
- GitHub Actions in PUBLIC repo empireofryan/daily-snapshot (public = free minutes). Cron 20:00 UTC (2pm Denver MDT).
- 15 repo secrets (Turso tokens, R2, Cloudinary, Resend, EMAIL_FROM, SNAPSHOT_TO). Set from local .env.local files; never commit values.
- Previous-day numbers for % change persist via actions/cache (key snapshot-state-<run_id>, restore prefix).
- Script output goes to run.log (not printed) so traffic numbers stay out of the public logs.

## Commands
- Manual run: `gh workflow run daily-snapshot.yml -R empireofryan/daily-snapshot`
- Update a secret: `gh secret set NAME -R empireofryan/daily-snapshot`

## Status (2026-10-10)
- Live; verified 2026-10-10 (email sent, % change via cache works, Turso line works via CLI + TURSO_API_TOKEN secret, token "daily-snapshot-ci").
- Old laptop launchd jobs moved to ~/Library/LaunchAgents/disabled/ (efusa-daily-snapshot + watchdog). EscapeFromUSA's own workflow is manual-only.
- Why moved: laptop job died Oct 3 when EscapeFromUSA/web/node_modules got wiped; private-repo GHA minutes are exhausted.

## 2026-10-20
- Fixed EFUSA sign-ups always showing 0: this copy predated EFUSA commit 146bea0 (users.created_at is unix epoch). Ported `signupDateEpoch`. Fixes to EscapeFromUSA/web/scripts/daily-snapshot.ts do NOT reach this repo; port them by hand.
