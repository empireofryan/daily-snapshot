#!/usr/bin/env npx tsx
/**
 * Daily project snapshot — emails a single digest covering all active projects.
 *
 * Metrics per project:
 *   - Pageviews (yesterday), unique sessions, top 5 pages
 *   - Bot hits by category
 *   - Day-over-day deltas for all metrics
 *
 * Infrastructure (EscapeFromUSA only):
 *   - Turso DB reads + storage
 *   - Cloudinary credits (% of plan)
 *   - R2 reel storage (% of 10GB free)
 *
 * Outreach (HaulTax only):
 *   - Cold-email sends/opens/clicks (last 24h + all-time), from the
 *     outreach_sends / outreach_events tables in the carriers-app DB
 *
 * Usage:
 *   npx tsx scripts/daily-snapshot.ts                  # send email
 *   SNAPSHOT_EMAIL=0 npx tsx scripts/daily-snapshot.ts # dry run, log only
 *
 * Wired to .github/workflows/daily-snapshot.yml (daily 15:00 UTC = 9am Denver)
 */

import { createClient } from '@libsql/client'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const STATE_FILE = process.env.SNAPSHOT_STATE_FILE || path.join(process.cwd(), 'content/data/.snapshot-state.json')

// Local-timezone YYYY-MM-DD. Must match the cron wrapper's `date +%Y-%m-%d` —
// toISOString() is UTC and rolls over at 5/6pm Denver time, which would make an
// evening watchdog retry think "today" hadn't been sent yet and double-send.
function localDate(): string {
  return new Date().toLocaleDateString('en-CA')
}

// ── Project configs ──────────────────────────────────────────────
// All projects now on Turso (Cockroach decommissioned 2026-05-15).
// EscapeFromUSA reads its own TURSO_DATABASE_URL env; others have explicit
// libsql:// URLs + auth tokens for CityPopn's DB (citypopn.com, DB/env var
// still named vibefind — pre-rename artifact) + RankLoft's rankloft DB +
// Noozday's news-aggregator DB + HaulTax's carriers-app DB (haultax.com,
// DB/env var still named carriers-app — pre-rename artifact; also has the
// leads signup table + outreach_sends/outreach_events tables used by the
// HaulTax-only outreach sub-block, see getOutreachMetrics()).
interface ProjectConfig {
  name: string
  domain: string
  dbUrl?: string         // for EscapeFromUSA, falls back to process.env.TURSO_DATABASE_URL
  dbAuthToken?: string   // for EscapeFromUSA, falls back to process.env.TURSO_AUTH_TOKEN
  urlColumn?: string     // analytics_pageviews path/url column name (default 'url'; noozday uses 'path')
  signupTable?: string   // table of registered users/signups; omit to skip the signup metric
  signupDateCol?: string // created-at column on signupTable (default 'created_at'; CityPopn uses 'createdAt')
  signupDateEpoch?: boolean // date column is unix seconds (INTEGER); SQLite sorts INTEGER below TEXT, so comparing it to datetime() text always counts 0
}

const PROJECTS: ProjectConfig[] = [
  {
    name: 'EscapeFromUSA',
    domain: 'escapefromusa.com',
    signupTable: 'users',
    signupDateEpoch: true,  // users.created_at DEFAULT unixepoch()
    // uses TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from process.env
  },
  {
    name: 'CityPopn',
    domain: 'citypopn.com',
    dbUrl: 'libsql://vibefind-empireofryan.aws-us-east-2.turso.io',
    dbAuthToken: process.env.VIBEFIND_TURSO_AUTH_TOKEN,
    signupTable: 'User',
    signupDateCol: 'createdAt',
  },
  {
    name: 'RankLoft',
    domain: 'rankloft.com',
    dbUrl: 'libsql://rankloft-empireofryan.aws-us-east-2.turso.io',
    dbAuthToken: process.env.RANKLOFT_TURSO_AUTH_TOKEN,
    // no user/signup table — signup metric is skipped
  },
  {
    name: 'Noozday',
    domain: 'noozday.com',
    dbUrl: 'libsql://news-aggregator-empireofryan.aws-us-east-2.turso.io',
    dbAuthToken: process.env.NOOZDAY_TURSO_AUTH_TOKEN,
    urlColumn: 'path',   // NewsAggregator's analytics_pageviews uses `path`, not `url`
    signupTable: 'users',
  },
  // HaulTax removed from the digest 2026-10-10 (Ryan's call).
]

// ── DB helpers ───────────────────────────────────────────────────
const _clients = new Map<string, ReturnType<typeof createClient>>()
function getClientFor(proj: ProjectConfig) {
  const url = proj.dbUrl || process.env.TURSO_DATABASE_URL!
  const authToken = proj.dbAuthToken || process.env.TURSO_AUTH_TOKEN!
  const key = url
  if (!_clients.has(key)) {
    _clients.set(key, createClient({ url, authToken }))
  }
  return _clients.get(key)!
}

interface TrafficStats {
  pageviews: number
  sessions: number
  topPages: { url: string; views: number }[]
  botHits: number
  botBreakdown: { category: string; count: number }[]
  topReferrers: { source: string; views: number }[]
  avgSessionSec: number      // avg total time_on_page summed per session
  pagesPerSession: number
  signups: number | null     // null when the project has no signup table
}

// Turn a raw referrer URL into a human label; return null for internal (self) refs.
function classifyReferrer(raw: string | null | undefined, selfDomain: string): string | null {
  if (!raw || !raw.trim()) return 'Direct / none'
  let host: string
  try { host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase() }
  catch { return 'Direct / none' }
  if (host === selfDomain || host.endsWith('.' + selfDomain)) return null // internal navigation
  const pretty: Record<string, string> = {
    'google.com': 'Google', 'google.co.uk': 'Google', 'bing.com': 'Bing', 'duckduckgo.com': 'DuckDuckGo',
    'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT', 'perplexity.ai': 'Perplexity',
    'reddit.com': 'Reddit', 'out.reddit.com': 'Reddit', 'old.reddit.com': 'Reddit',
    't.co': 'X/Twitter', 'x.com': 'X/Twitter', 'twitter.com': 'X/Twitter',
    'facebook.com': 'Facebook', 'l.facebook.com': 'Facebook', 'm.facebook.com': 'Facebook',
    'instagram.com': 'Instagram', 'l.instagram.com': 'Instagram', 'lm.facebook.com': 'Facebook',
    'youtube.com': 'YouTube', 'linkedin.com': 'LinkedIn', 'news.ycombinator.com': 'Hacker News',
    'tiktok.com': 'TikTok', 'pinterest.com': 'Pinterest',
  }
  return pretty[host] || host
}

// @libsql/client has no request timeout — a query issued during a network
// transition can hang forever. 2026-08-13: the RankLoft query hung for 3 days,
// holding the cron wrapper's snapshot.lock, so no email went out 08-13..08-15.
// Every per-project query goes through this so a hang becomes a rejection the
// caller's existing catch path turns into a red "Query failed" row.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}
const PROJECT_QUERY_TIMEOUT_MS = 120_000

async function queryTursoTraffic(proj: ProjectConfig, daysAgo: number): Promise<TrafficStats> {
  const since = `datetime('now', '-${daysAgo} days')`
  const urlCol = proj.urlColumn || 'url'
  const db = getClientFor(proj)
  const empty = (fallback: any) => Promise.resolve({ rows: fallback } as any)
  const [pvRes, sessRes, topRes, botRes, botCatRes, refRes, engRes, signupRes] = await Promise.all([
    db.execute(`SELECT COUNT(*) as c FROM analytics_pageviews WHERE created_at >= ${since}`),
    db.execute(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_pageviews WHERE created_at >= ${since}`),
    // Group by raw url (top 200), then normalize to bare paths in JS — the raw column
    // mixes full URLs / bare paths / paths with query strings, so grouping on the raw
    // value alone was splitting the same page into several "/" rows (2026-07-03 fix).
    db.execute(`SELECT ${urlCol} as url, COUNT(*) as c FROM analytics_pageviews WHERE created_at >= ${since} GROUP BY ${urlCol} ORDER BY c DESC LIMIT 200`),
    db.execute(`SELECT COUNT(*) as c FROM analytics_bots WHERE created_at >= ${since}`).catch(() => empty([{ c: 0 }])),
    db.execute(`SELECT bot_category, COUNT(*) as c FROM analytics_bots WHERE created_at >= ${since} GROUP BY bot_category ORDER BY c DESC`).catch(() => empty([])),
    // Group by raw referrer (top 100), then normalize to hosts in JS.
    db.execute(`SELECT referrer, COUNT(*) as c FROM analytics_pageviews WHERE created_at >= ${since} GROUP BY referrer ORDER BY c DESC LIMIT 100`).catch(() => empty([])),
    // Avg total dwell per session (seconds), only sessions with recorded time.
    // Cap per-page dwell at 600s so a single idle/left-open tab can't dominate a small sample.
    db.execute(`SELECT AVG(dur) as avg_dur FROM (SELECT session_id, SUM(MIN(time_on_page, 600)) as dur FROM analytics_pageviews WHERE created_at >= ${since} AND time_on_page IS NOT NULL AND time_on_page > 0 GROUP BY session_id)`).catch(() => empty([{ avg_dur: 0 }])),
    // Signups (new registered users) since window — only when the project has a table.
    proj.signupTable
      ? db.execute(`SELECT COUNT(*) as c FROM ${proj.signupTable} WHERE ${proj.signupDateEpoch ? `datetime(${proj.signupDateCol || 'created_at'}, 'unixepoch')` : proj.signupDateCol || 'created_at'} >= ${since}`).catch(() => empty([{ c: null }]))
      : empty([{ c: null }]),
  ])

  const pageviews = Number(pvRes.rows[0]?.c ?? 0)
  const sessions = Number(sessRes.rows[0]?.c ?? 0)

  // Fold raw referrers into host-level buckets, drop internal, keep top 5.
  const refBuckets = new Map<string, number>()
  for (const r of refRes.rows as any[]) {
    const label = classifyReferrer(r.referrer, proj.domain)
    if (label === null) continue
    refBuckets.set(label, (refBuckets.get(label) || 0) + Number(r.c))
  }
  const topReferrers = [...refBuckets.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([source, views]) => ({ source, views }))

  // Normalize raw url/path values to a bare path (strips domain + query string)
  // and consolidate before ranking — same host-bucketing pattern as referrers above.
  const pageBuckets = new Map<string, number>()
  for (const r of topRes.rows as any[]) {
    let p: string
    try { p = new URL(String(r.url), `https://${proj.domain}`).pathname } catch { p = String(r.url) }
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
    pageBuckets.set(p, (pageBuckets.get(p) || 0) + Number(r.c))
  }
  const topPages = [...pageBuckets.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([url, views]) => ({ url, views }))

  const rawSignups = (signupRes.rows[0] as any)?.c
  return {
    pageviews,
    sessions,
    topPages,
    botHits: Number(botRes.rows[0]?.c ?? 0),
    botBreakdown: botCatRes.rows.map((r: any) => ({ category: String(r.bot_category), count: Number(r.c) })),
    topReferrers,
    avgSessionSec: Math.round(Number((engRes.rows[0] as any)?.avg_dur ?? 0)),
    pagesPerSession: sessions > 0 ? pageviews / sessions : 0,
    signups: rawSignups == null ? null : Number(rawSignups),
  }
}

// ── Outreach metrics (HaulTax only) ──────────────────────────────
// Cold-email outreach lives in the same carriers-app Turso DB as the
// leads table: outreach_sends (one row per send) + outreach_events
// (open/click pixel + link hits, keyed by outreach_sends.token).
// These tables are new (2026-07) and may not exist yet on a given day —
// every query below is individually .catch()'d to zero/empty so a missing
// table degrades to "0 sent / 0 opened / 0 clicked" instead of crashing
// the whole snapshot run.
interface OutreachRecipient {
  company: string
  city: string | null
  state: string | null
  clicked: boolean
}

interface OutreachMetrics {
  sent24h: number
  opened24h: number
  clicked24h: number
  recipients24h: OutreachRecipient[]
  totalSent: number
  totalOpened: number
  totalClicked: number
}

async function getOutreachMetrics(proj: ProjectConfig): Promise<OutreachMetrics | null> {
  const db = getClientFor(proj)
  const empty = (fallback: any) => Promise.resolve({ rows: fallback } as any)
  try {
    const [sent24Res, open24Res, click24Res, recipRes, totalSentRes, totalOpenRes, totalClickRes] = await Promise.all([
      db.execute(`SELECT COUNT(*) as c FROM outreach_sends WHERE sent_at >= datetime('now', '-1 days')`)
        .catch(() => empty([{ c: 0 }])),
      db.execute(`SELECT COUNT(DISTINCT token) as c FROM outreach_events WHERE event_type = 'open' AND created_at >= datetime('now', '-1 days')`)
        .catch(() => empty([{ c: 0 }])),
      db.execute(`SELECT COUNT(DISTINCT token) as c FROM outreach_events WHERE event_type = 'click' AND created_at >= datetime('now', '-1 days')`)
        .catch(() => empty([{ c: 0 }])),
      // Last 24h: one row per token that had any open/click, "clicked" wins over "opened".
      db.execute(`
        SELECT s.company as company, s.email as email, s.city as city, s.state as state,
               MAX(CASE WHEN e.event_type = 'click' THEN 1 ELSE 0 END) as clicked,
               MAX(e.created_at) as last_event
        FROM outreach_events e
        JOIN outreach_sends s ON s.token = e.token
        WHERE e.created_at >= datetime('now', '-1 days') AND e.event_type IN ('open', 'click')
        GROUP BY s.token
        ORDER BY clicked DESC, last_event DESC
        LIMIT 10
      `).catch(() => empty([])),
      db.execute(`SELECT COUNT(*) as c FROM outreach_sends`).catch(() => empty([{ c: 0 }])),
      db.execute(`SELECT COUNT(DISTINCT token) as c FROM outreach_events WHERE event_type = 'open'`).catch(() => empty([{ c: 0 }])),
      db.execute(`SELECT COUNT(DISTINCT token) as c FROM outreach_events WHERE event_type = 'click'`).catch(() => empty([{ c: 0 }])),
    ])

    return {
      sent24h: Number(sent24Res.rows[0]?.c ?? 0),
      opened24h: Number(open24Res.rows[0]?.c ?? 0),
      clicked24h: Number(click24Res.rows[0]?.c ?? 0),
      recipients24h: (recipRes.rows as any[]).map(r => ({
        company: String(r.company || r.email || 'Unknown'),
        city: r.city ? String(r.city) : null,
        state: r.state ? String(r.state) : null,
        clicked: Number(r.clicked) === 1,
      })),
      totalSent: Number(totalSentRes.rows[0]?.c ?? 0),
      totalOpened: Number(totalOpenRes.rows[0]?.c ?? 0),
      totalClicked: Number(totalClickRes.rows[0]?.c ?? 0),
    }
  } catch (e: any) {
    // Whole-block failure (e.g. neither table exists yet) — skip the block entirely.
    console.warn(`[HaulTax] outreach metrics unavailable — skipping outreach block: ${e.message}`)
    return null
  }
}

function renderOutreachHtml(m: OutreachMetrics | null): string {
  if (!m) return ''
  if (m.sent24h === 0 && m.totalSent === 0) return '' // nothing sent yet — nothing useful to show

  const rateStr = (num: number, den: number) => den > 0 ? `${((num / den) * 100).toFixed(0)}%` : '—'

  const recipRows = m.recipients24h.length > 0
    ? m.recipients24h.map(r => {
        const loc = [r.city, r.state].filter(Boolean).join(', ')
        const status = r.clicked
          ? '<span style="color:#2a7">clicked</span>'
          : '<span style="color:#357edd">opened</span>'
        return `<tr>
          <td style="padding:3px 12px 3px 0;font-size:13px;color:#333">${r.company}</td>
          <td style="padding:3px 12px 3px 0;font-size:13px;color:#666">${loc || '—'}</td>
          <td style="text-align:right;font-size:13px">${status}</td>
        </tr>`
      }).join('')
    : '<tr><td style="color:#888;font-size:13px">No opens or clicks in the last 24h</td></tr>'

  return `
    <div style="margin-top:10px;padding-top:8px;border-top:1px dashed #eee">
      <p style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px">Outreach — last 24h</p>
      <table style="border-collapse:collapse;margin:4px 0 8px">
        <tr>
          <td style="padding:4px 20px 4px 0;font-size:13px"><strong>${fmtNum(m.sent24h)}</strong> emails sent</td>
          <td style="padding:4px 20px 4px 0;font-size:13px"><strong>${fmtNum(m.opened24h)}</strong> unique opens <span style="color:#aaa;font-size:11px">(approx., Gmail proxy)</span></td>
          <td style="padding:4px 0;font-size:13px"><strong>${fmtNum(m.clicked24h)}</strong> unique clicks</td>
        </tr>
      </table>
      <table style="width:100%;margin:4px 0 8px">${recipRows}</table>
      <p style="font-size:11px;color:#999;margin:4px 0 0">
        All-time: ${fmtNum(m.totalSent)} sent · ${fmtNum(m.totalOpened)} opened (${rateStr(m.totalOpened, m.totalSent)}) · ${fmtNum(m.totalClicked)} clicked (${rateStr(m.totalClicked, m.totalSent)})
      </p>
    </div>
  `
}

// ── Infra metrics (EscapeFromUSA only) ───────────────────────────
interface InfraMetrics {
  tursoReads: number | null
  tursoStorage: string | null
  cloudinaryPct: number | null
  cloudinaryUsed: number | null
  r2GB: number | null
  r2Pct: number | null
}

async function getInfraMetrics(): Promise<InfraMetrics> {
  const result: InfraMetrics = {
    tursoReads: null, tursoStorage: null,
    cloudinaryPct: null, cloudinaryUsed: null,
    r2GB: null, r2Pct: null,
  }

  // Turso
  try {
    const tursoPath = `${process.env.HOME}/.turso/turso`
    if (fs.existsSync(tursoPath)) {
      const out = execSync(`${tursoPath} db inspect escapefromusa`, { encoding: 'utf8', timeout: 15000 })
      result.tursoReads = Number((out.match(/Number of rows read:\s*(\d+)/) || [])[1] || 0)
      result.tursoStorage = (out.match(/Total space used:\s*([^\n]+)/) || [])[1]?.trim() || null
    }
  } catch {}

  // Cloudinary
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME
    const key = process.env.CLOUDINARY_API_KEY
    const secret = process.env.CLOUDINARY_API_SECRET
    if (cloud && key && secret) {
      const auth = Buffer.from(`${key}:${secret}`).toString('base64')
      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/usage`, {
        headers: { Authorization: `Basic ${auth}` },
      })
      if (res.ok) {
        const d = await res.json() as any
        if (d.credits?.limit) {
          result.cloudinaryUsed = d.credits.usage
          result.cloudinaryPct = d.credits.usage / d.credits.limit
        }
      }
    }
  } catch {}

  // R2
  try {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
    const endpoint = process.env.R2_ENDPOINT
    const accessKeyId = process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
    const bucket = process.env.R2_REELS_BUCKET || 'escapefromusa-reels'
    if (endpoint && accessKeyId && secretAccessKey) {
      const s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } })
      let totalBytes = 0, token: string | undefined
      do {
        const r: any = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
        for (const o of r.Contents || []) totalBytes += o.Size || 0
        token = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (token)
      result.r2GB = totalBytes / (1024 ** 3)
      result.r2Pct = result.r2GB / 10 // 10GB free
    }
  } catch {}

  return result
}

// ── Deltas ───────────────────────────────────────────────────────
interface SnapshotState {
  [project: string]: { pageviews: number; sessions: number; botHits: number; signups?: number | null }
  _infra?: { tursoReads: number; cloudinaryUsed: number; r2GB: number }
}

function loadState(): SnapshotState {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function saveState(s: SnapshotState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

function fmtDelta(curr: number, prev: number | undefined): string {
  if (prev === undefined || prev === 0) return curr > 0 ? '(new)' : ''
  const d = ((curr - prev) / prev) * 100
  const sign = d >= 0 ? '+' : ''
  return `<span style="color:${d > 0 ? '#2a7' : d < 0 ? '#d33' : '#888'}">${sign}${d.toFixed(0)}%</span>`
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return '—'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

// ── Email ────────────────────────────────────────────────────────
// Retries transient connect failures and 5xx with real backoff (15/30/60/120s).
// Returns true only when Resend accepted the email — the caller exits nonzero
// otherwise so the cron wrapper's job-level retry loop re-runs the whole
// snapshot later. (2026-07-02: ENOTFOUND mid-run, single send attempt failed;
// 2026-07-05: network out 16+ min, 3 quick retries all failed, rc=0 → no email
// and nothing ever retried.)
async function sendEmail(html: string, maxAttempts = 5): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM
  const to = process.env.SNAPSHOT_TO
  if (!apiKey || !from || !to) { console.warn('[email] missing creds — skipping'); return false }

  const today = localDate()
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to,
          subject: `Daily snapshot — ${today}`,
          html,
        }),
      })
      if (r.ok) { console.log(`[email] sent to ${to}`); return true }
      const body = await r.text()
      if (r.status >= 500) throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`)
      console.error('[email] failed (non-retryable):', r.status, body)
      return false
    } catch (e: any) {
      if (attempt === maxAttempts) { console.error(`[email] failed after ${maxAttempts} attempts:`, e.message); return false }
      const wait = 15 * 2 ** (attempt - 1)
      console.log(`[email] send attempt ${attempt}/${maxAttempts} failed (${e.message}) — retry in ${wait}s`)
      await new Promise(res => setTimeout(res, wait * 1000))
    }
  }
  return false
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const prevState = loadState()
  const newState: SnapshotState = {}
  const today = localDate()

  let projectSections = ''
  let okProjects = 0

  for (const proj of PROJECTS) {
    console.log(`[${proj.name}] querying...`)
    let today1d: TrafficStats
    try {
      // Two attempts: a single timeout is often just transient Turso load
      // (2026-08-26: EFUSA timed out while the morning data-gen run was
      // hammering the same DB; a retry 30s later would have succeeded).
      try {
        today1d = await withTimeout(queryTursoTraffic(proj, 1), PROJECT_QUERY_TIMEOUT_MS, `${proj.name} traffic query`)
      } catch (first: any) {
        console.log(`[${proj.name}] first attempt failed (${first.message}) — retrying in 30s`)
        await new Promise(r => setTimeout(r, 30_000))
        today1d = await withTimeout(queryTursoTraffic(proj, 1), PROJECT_QUERY_TIMEOUT_MS, `${proj.name} traffic query (retry)`)
      }
    } catch (e: any) {
      console.error(`[${proj.name}] query failed:`, e.message)
      projectSections += `<h3 style="margin:24px 0 8px">${proj.name} <span style="color:#888;font-size:13px">${proj.domain}</span></h3><p style="color:#d33">Query failed: ${e.message}</p>`
      continue
    }

    okProjects++
    const prev = prevState[proj.name] as any
    newState[proj.name] = { pageviews: today1d.pageviews, sessions: today1d.sessions, botHits: today1d.botHits, signups: today1d.signups }

    const topPagesHtml = today1d.topPages.length > 0
      ? today1d.topPages.map(p => {
          // p.url is already a normalized bare path (see queryTursoTraffic)
          let label = p.url
          if (label.length > 40) label = label.slice(0, 37) + '...'
          const href = `https://${proj.domain}${p.url}`
          return `<tr><td style="padding:3px 12px 3px 0;color:#666;font-size:13px"><a href="${href}" style="color:#357edd;text-decoration:none">${label}</a></td><td style="text-align:right;font-size:13px;color:#333">${p.views}</td></tr>`
        }).join('')
      : '<tr><td style="color:#888;font-size:13px">No pageviews</td></tr>'

    const topRefHtml = today1d.topReferrers.length > 0
      ? today1d.topReferrers.map(r => {
          let s = r.source
          if (s.length > 28) s = s.slice(0, 25) + '...'
          return `<tr><td style="padding:3px 12px 3px 0;color:#666;font-size:13px">${s}</td><td style="text-align:right;font-size:13px;color:#333">${r.views}</td></tr>`
        }).join('')
      : '<tr><td style="color:#888;font-size:13px">No referrers</td></tr>'

    const botLine = today1d.botBreakdown.length > 0
      ? today1d.botBreakdown.map(b => `${b.category}: ${b.count}`).join(' · ')
      : 'none'

    const signupCell = today1d.signups !== null
      ? `<td style="padding:4px 20px 4px 0"><strong>${fmtNum(today1d.signups)}</strong> sign-ups ${fmtDelta(today1d.signups, prev?.signups ?? undefined)}</td>`
      : ''

    projectSections += `
      <h3 style="margin:24px 0 8px;font-family:Georgia,serif">${proj.name} <span style="color:#888;font-weight:normal;font-size:13px">${proj.domain}</span></h3>
      <table style="border-collapse:collapse;margin:8px 0">
        <tr>
          <td style="padding:4px 20px 4px 0"><strong>${fmtNum(today1d.pageviews)}</strong> pageviews ${fmtDelta(today1d.pageviews, prev?.pageviews)}</td>
          <td style="padding:4px 20px 4px 0"><strong>${fmtNum(today1d.sessions)}</strong> unique visitors ${fmtDelta(today1d.sessions, prev?.sessions)}</td>
          ${signupCell}
          <td style="padding:4px 0"><strong>${fmtNum(today1d.botHits)}</strong> bot hits ${fmtDelta(today1d.botHits, prev?.botHits)}</td>
        </tr>
      </table>
      <p style="font-size:12px;color:#666;margin:4px 0">
        Avg time on site <strong>${fmtDuration(today1d.avgSessionSec)}</strong> ·
        <strong>${today1d.pagesPerSession.toFixed(1)}</strong> pages/visit ·
        <span style="color:#888">Bots: ${botLine}</span>
      </p>
      <table style="width:100%;margin:8px 0"><tr>
        <td style="vertical-align:top;width:50%;padding-right:16px">
          <p style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 2px">Top pages</p>
          <table style="width:100%">${topPagesHtml}</table>
        </td>
        <td style="vertical-align:top;width:50%">
          <p style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 2px">Top sources</p>
          <table style="width:100%">${topRefHtml}</table>
        </td>
      </tr></table>
    `

    // HaulTax-only: cold-outreach send/open/click sub-block, appended inside
    // this project's section (same special-casing pattern as the
    // EscapeFromUSA-only infra block below, just scoped per-project instead
    // of global).
    if (proj.name === 'HaulTax') {
      try {
        const outreach = await withTimeout(getOutreachMetrics(proj), PROJECT_QUERY_TIMEOUT_MS, `${proj.name} outreach query`)
        projectSections += renderOutreachHtml(outreach)
        if (outreach) {
          console.log(`  outreach: ${outreach.sent24h} sent/24h, ${outreach.opened24h} opened/24h, ${outreach.clicked24h} clicked/24h (all-time ${outreach.totalSent} sent)`)
        } else {
          console.log('  outreach: tables not available yet — skipped')
        }
      } catch (e: any) {
        console.warn(`[HaulTax] outreach block failed, continuing without it: ${e.message}`)
      }
    }

    console.log(`  ${today1d.pageviews} pv, ${today1d.sessions} sessions, ${today1d.botHits} bots, ${today1d.signups ?? '—'} signups, ${fmtDuration(today1d.avgSessionSec)} avg, ${today1d.pagesPerSession.toFixed(1)} pg/visit`)
    console.log(`  sources: ${today1d.topReferrers.map(r => `${r.source}(${r.views})`).join(', ') || 'none'}`)
  }

  // If every project query failed the network is down (or all tokens broke) —
  // an email full of red "Query failed" rows is useless. Exit nonzero WITHOUT
  // saving state so the cron wrapper retries the whole run later.
  if (okProjects === 0) {
    console.error('[fatal] all project queries failed — exiting 1 so the cron wrapper retries')
    process.exit(1)
  }

  // Infra metrics (EscapeFromUSA only)
  console.log('[infra] checking...')
  const infra = await withTimeout(getInfraMetrics(), PROJECT_QUERY_TIMEOUT_MS, 'infra metrics')
    .catch((e: any): InfraMetrics => {
      console.warn(`[infra] ${e.message} — continuing with nulls`)
      return { tursoReads: null, tursoStorage: null, cloudinaryUsed: null, cloudinaryPct: null, r2GB: null, r2Pct: null }
    })
  const prevInfra = prevState._infra as any
  newState._infra = {
    // Preserve yesterday's values when a probe returns null (partial outage) —
    // writing zeros corrupts tomorrow's day-over-day deltas (2026-07-05).
    tursoReads: infra.tursoReads ?? prevInfra?.tursoReads ?? 0,
    cloudinaryUsed: infra.cloudinaryUsed ?? prevInfra?.cloudinaryUsed ?? 0,
    r2GB: infra.r2GB ?? prevInfra?.r2GB ?? 0,
  } as any

  let infraHtml = '<h3 style="margin:24px 0 8px;font-family:Georgia,serif">Infrastructure</h3><table style="border-collapse:collapse">'
  if (infra.tursoReads !== null) {
    infraHtml += `<tr><td style="padding:4px 16px 4px 0;font-size:13px">Turso reads</td><td style="font-size:13px"><strong>${fmtNum(infra.tursoReads)}</strong> ${fmtDelta(infra.tursoReads, prevInfra?.tursoReads)}</td></tr>`
  }
  if (infra.tursoStorage) {
    infraHtml += `<tr><td style="padding:4px 16px 4px 0;font-size:13px">Turso storage</td><td style="font-size:13px">${infra.tursoStorage}</td></tr>`
  }
  if (infra.cloudinaryPct !== null) {
    const color = infra.cloudinaryPct >= 1 ? '#d33' : infra.cloudinaryPct >= 0.8 ? '#e85' : '#2a7'
    infraHtml += `<tr><td style="padding:4px 16px 4px 0;font-size:13px">Cloudinary</td><td style="font-size:13px"><strong style="color:${color}">${(infra.cloudinaryPct * 100).toFixed(0)}%</strong> of plan ${fmtDelta(infra.cloudinaryUsed!, prevInfra?.cloudinaryUsed)}</td></tr>`
  }
  if (infra.r2GB !== null) {
    infraHtml += `<tr><td style="padding:4px 16px 4px 0;font-size:13px">R2 reels</td><td style="font-size:13px">${infra.r2GB.toFixed(2)} GB / 10 GB (${((infra.r2Pct || 0) * 100).toFixed(0)}%)</td></tr>`
  }
  infraHtml += '</table>'

  console.log(`  turso: ${infra.tursoReads} reads, ${infra.tursoStorage}`)
  console.log(`  cloudinary: ${infra.cloudinaryPct !== null ? (infra.cloudinaryPct * 100).toFixed(0) + '%' : 'n/a'}`)
  console.log(`  r2: ${infra.r2GB !== null ? infra.r2GB.toFixed(2) + ' GB' : 'n/a'}`)

  // Build email
  const html = `<div style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto">
<h2 style="color:#1a1714;font-family:Georgia,serif;margin-bottom:4px">Daily Snapshot</h2>
<p style="color:#888;font-size:13px;margin-top:0">${today} · Last 24 hours</p>
<hr style="border:none;border-top:1px solid #eee;margin:16px 0">
${projectSections}
<hr style="border:none;border-top:1px solid #eee;margin:16px 0">
${infraHtml}
<p style="font-size:11px;color:#aaa;margin-top:24px">Generated by <code>scripts/daily-snapshot.ts</code></p>
</div>`

  if (process.env.SNAPSHOT_HTML_OUT) {
    fs.writeFileSync(process.env.SNAPSHOT_HTML_OUT, html)
    console.log(`[html] wrote preview to ${process.env.SNAPSHOT_HTML_OUT}`)
  }

  if (process.env.SNAPSHOT_EMAIL !== '0') {
    const sent = await sendEmail(html)
    if (!sent) {
      console.error('[fatal] email not sent — state not saved; exiting 1 so the cron wrapper retries')
      process.exit(1)
    }
    // State + sent-marker are written ONLY after Resend accepted the email, so a
    // failed run leaves yesterday's baseline intact for the retry, and merged over
    // prevState so a project whose query failed keeps its last known values.
    saveState({ ...prevState, ...newState })
    if (process.env.SNAPSHOT_SENT_MARKER) {
      fs.writeFileSync(process.env.SNAPSHOT_SENT_MARKER, today)
    }
  } else {
    console.log('\n[dry run] email not sent, state not saved (SNAPSHOT_EMAIL=0)')
  }
}

// Explicit exit: a timed-out libsql request leaves a pending socket that would
// otherwise keep the event loop (and the cron wrapper's lock) alive forever.
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
