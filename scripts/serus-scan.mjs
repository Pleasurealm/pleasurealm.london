#!/usr/bin/env node
// Exposure-protection agent for Moses Kityamuwesi Kisubika and Pleasurealm Ltd.
//
// Runs in the daily GitHub Action. For each subject in data/serus-watch.json it
// asks Serus (https://serus.ai) to scan for exposed personal data — OSINT
// footprint, data-broker listings and dark-web breach hits — then:
//   * writes a REDACTED aggregate summary to data/exposure.json,
//   * MONITORS: detects new exposures, resolved ones, and removed-then-reappeared
//     regressions vs. the last run, and appends a trend point to
//     data/exposure-history.json,
//   * tracks REMOVAL lifecycle (found -> requested -> in-progress -> removed),
//     re-requesting removal for anything still removable when auto-remove is on,
//   * optionally posts an aggregate alert to a webhook on new high/critical hits.
//
// Three hard privacy rules, because this repo is public:
//   1. data/exposure.json, data/exposure-history.json and data/exposure-state.json
//      are AGGREGATE / HASHED ONLY — counts, severities, categories, and
//      irreversible SHA-256 fingerprints. No names, emails, URLs, source sites or
//      unmasked values are ever committed. The agent must not become the exposure
//      it exists to reduce.
//   2. Raw (still masked) findings are written to $SERUS_RAW_OUT if set — used by
//      the workflow to upload a PRIVATE, retention-limited artifact. Never committed.
//   3. Any webhook alert body is aggregate-only (counts + severities), no PII.
//
// Auth: set the repo secret SERUS_API_KEY (a Serus key, "ak_..."). With no key
// this script exits 0 and changes nothing. Sensitive identifiers can be supplied
// via the SERUS_SUBJECTS_JSON secret (merged in memory, never written to disk).
//
// The API shapes below follow https://docs.serus.ai/ (base https://api.serus.ai/v1,
// bearer auth, POST a scan, poll for results). If Serus changes paths or field
// names, adjust EP and mapFinding() — they are the two things to touch, exactly
// like the PropertyData adapter in fetch-listings.mjs.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const KEY = process.env.SERUS_API_KEY;
if (!KEY) {
  console.log("SERUS_API_KEY not set — leaving data/exposure.json untouched (agent idle).");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const cfg = JSON.parse(readFileSync(join(dataDir, "serus-watch.json"), "utf8"));

// --- config knobs (env overrides win, so nothing is hard-coded to one API shape) ---
const BASE = process.env.SERUS_API_BASE || "https://api.serus.ai/v1";
const EP = {
  verifyKey: `${BASE}/key`,          // GET  — verify key, no credits
  startScan: `${BASE}/scans`,        // POST — start a scan, ~0.25 credits each
  getScan: (id) => `${BASE}/scans/${id}`, // GET — read results, no credits
  removal: `${BASE}/removals`,       // POST — request takedown/opt-out (opt-in only)
};
const AUTO_REMOVE = /^(1|true|yes)$/i.test(process.env.SERUS_AUTO_REMOVE || "");
const REDACTION = (cfg.redaction || "strict").toLowerCase();
const POLL_MS = (cfg.scan?.pollSeconds ?? 20) * 1000;
const TIMEOUT_MS = (cfg.scan?.timeoutSeconds ?? 300) * 1000;
const SCAN_TYPES = cfg.scan?.types?.length ? cfg.scan.types : ["osint", "darkweb"];
const HISTORY_MAX = cfg.historyMax ?? 730;   // ~2 years of daily points
const RESOLVED_MAX = cfg.resolvedMax ?? 5000; // cap on remembered removed fingerprints
const ALERT_WEBHOOK = process.env.SERUS_ALERT_WEBHOOK || "";

const auth = { Authorization: `Bearer ${KEY}`, accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = (...parts) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
const readJSON = (p, fb) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fb; } catch { return fb; } };
const REMOVED = new Set(["removed", "deleted", "opted_out", "opted-out", "suppressed", "resolved"]);
const nowISO = new Date().toISOString();
const today = nowISO.slice(0, 10);

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error || body?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, body });
  }
  return body;
}

// Merge sensitive identifiers from the SERUS_SUBJECTS_JSON secret (never on disk).
function loadSubjects() {
  const subjects = structuredClone(cfg.subjects || []);
  const extraRaw = process.env.SERUS_SUBJECTS_JSON;
  if (!extraRaw) return subjects;
  let extra;
  try { extra = JSON.parse(extraRaw); } catch { console.warn("SERUS_SUBJECTS_JSON is not valid JSON — ignored."); return subjects; }
  for (const e of Array.isArray(extra) ? extra : []) {
    const target = subjects.find((s) => s.id === e.id);
    if (target) {
      target.identifiers = { ...target.identifiers, ...e.identifiers };
      for (const k of ["emails", "phones", "aliases", "domains"]) {
        const a = cfg.subjects.find((s) => s.id === e.id)?.identifiers?.[k] || [];
        const b = e.identifiers?.[k] || [];
        if (a.length || b.length) target.identifiers[k] = [...new Set([...a, ...b])];
      }
    } else {
      subjects.push(e);
    }
  }
  return subjects;
}

// Normalise one raw finding into our shape. Forgiving — providers vary.
function mapFinding(raw) {
  const sevRaw = String(raw.severity ?? raw.risk ?? raw.risk_level ?? "").toLowerCase();
  const severity = ["critical", "high", "medium", "low", "info"].find((s) => sevRaw.includes(s)) || "unknown";
  const category = String(raw.category ?? raw.type ?? raw.kind ?? raw.source_type ?? "other").toLowerCase();
  const source = raw.source ?? raw.site ?? raw.broker ?? raw.domain ?? raw.provider ?? "unknown";
  const status = String(raw.status ?? raw.state ?? "found").toLowerCase();
  const id = String(raw.id ?? raw.finding_id ?? raw.uid ?? `${source}:${category}`);
  const removable = Boolean(raw.removable ?? raw.can_remove ?? raw.optOutAvailable ?? false);
  return { id, severity, category, source: String(source), status, removable };
}

function extractFindings(scan) {
  const arr = scan.findings || scan.results || scan.exposures || scan.data || scan.items || [];
  return (Array.isArray(arr) ? arr : []).map(mapFinding);
}
function scanDone(scan) {
  const s = String(scan.status ?? scan.state ?? "").toLowerCase();
  return !s || ["done", "complete", "completed", "finished", "ready", "succeeded"].some((d) => s.includes(d));
}

async function scanSubject(subject) {
  const findings = [];
  for (const type of SCAN_TYPES) {
    try {
      const started = await api(EP.startScan, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, subject: subject.identifiers }),
      });
      const id = started.id ?? started.scan_id ?? started.scanId;
      let scan = started;
      if (id && !scanDone(started)) {
        const deadline = Date.now() + TIMEOUT_MS;
        do {
          await sleep(POLL_MS);
          scan = await api(EP.getScan(id));
        } while (!scanDone(scan) && Date.now() < deadline);
      }
      const rows = extractFindings(scan);
      findings.push(...rows);
      console.log(`  ${subject.label} · ${type}: ${rows.length} findings`);
    } catch (e) {
      console.warn(`  ${subject.label} · ${type}: ${e.message} — skipped`);
    }
  }
  const seen = new Set();
  return findings.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
}

// Opt-in only: request removal/opt-out for anything removable & not already in a
// removal state. Re-runs each day, so a finding that stays removable is retried.
async function requestRemovals(subject, findings) {
  if (!AUTO_REMOVE) return { requested: 0 };
  let requested = 0;
  for (const f of findings) {
    if (!f.removable) continue;
    if (f.status.includes("remov") || REMOVED.has(f.status) || f.status.includes("progress")) continue;
    try {
      await api(EP.removal, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectId: subject.id, findingId: f.id }),
      });
      f.status = "removal_requested";
      requested++;
    } catch (e) {
      console.warn(`    removal for a ${f.category} finding failed: ${e.message}`);
    }
    await sleep(300);
  }
  if (requested) console.log(`  ${subject.label}: opened ${requested} removal request(s)`);
  return { requested };
}

const tally = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
const removalBucket = (s) => (REMOVED.has(s) ? "removed" : s.includes("progress") ? "inProgress" : s.includes("remov") || s.includes("request") ? "requested" : "found");

function summariseSubject(subject, findings, removals) {
  const s = {
    id: subject.id,
    label: subject.label, // legal/company name only — already public
    kind: subject.kind,
    total: findings.length,
    bySeverity: tally(findings, "severity"),
    byCategory: tally(findings, "category"),
    removable: findings.filter((f) => f.removable).length,
    removalsRequested: removals.requested,
  };
  if (REDACTION !== "strict") s.bySource = tally(findings, "source");
  return s;
}

// GitHub Actions helpers (no-ops off CI).
const gha = { warn: (m) => console.log(`::warning::${m}`), notice: (m) => console.log(`::notice::${m}`) };
function stepSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { appendFileSync(f, md + "\n"); } catch {} }
}

// --- run -----------------------------------------------------------------------
try {
  const who = await api(EP.verifyKey).catch((e) => { throw new Error(`key verification failed: ${e.message}`); });
  console.log(`Serus key OK${who?.plan ? ` (plan: ${who.plan})` : ""}. Redaction: ${REDACTION}. Auto-remove: ${AUTO_REMOVE}.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// Prior monitoring state (hashed fingerprints only) for delta detection.
const statePath = join(dataDir, "exposure-state.json");
const prev = readJSON(statePath, { active: {}, resolved: {} });
const prevActive = prev.active || {};
const prevResolved = prev.resolved || {};

const subjects = loadSubjects();
const perSubject = [];
const rawBySubject = {};
const active = {};             // fingerprint -> { severity, status, firstSeen, lastSeen }
const currentRemoved = new Set(); // fingerprints reported removed this run
const removalStatus = { found: 0, requested: 0, inProgress: 0, removed: 0 };
let grandTotal = 0;

for (const subject of subjects) {
  const findings = await scanSubject(subject);
  const removals = await requestRemovals(subject, findings);
  perSubject.push(summariseSubject(subject, findings, removals));
  rawBySubject[subject.id] = findings; // masked, kept out of the repo
  grandTotal += findings.length;

  for (const f of findings) {
    const h = fp(subject.id, f.source, f.category, f.id);
    removalStatus[removalBucket(f.status)]++;
    if (REMOVED.has(f.status)) { currentRemoved.add(h); continue; }
    const seenBefore = prevActive[h] || prevResolved[h];
    active[h] = { severity: f.severity, status: f.status, firstSeen: seenBefore?.firstSeen || nowISO, lastSeen: nowISO };
  }
}

// --- monitoring deltas ---------------------------------------------------------
const activeHashes = Object.keys(active);
const isNew = activeHashes.filter((h) => !prevActive[h] && !prevResolved[h]);
const reappeared = activeHashes.filter((h) => prevResolved[h]); // removed before, back now
const resolved = Object.keys(prevActive).filter((h) => !active[h]); // gone or reported removed

// Fold newly-resolved into the resolved memory; drop any that reappeared.
const resolvedMem = { ...prevResolved };
for (const h of resolved) resolvedMem[h] = { severity: prevActive[h]?.severity || "unknown", resolvedAt: nowISO };
for (const h of currentRemoved) resolvedMem[h] = { severity: prevActive[h]?.severity || active[h]?.severity || "unknown", resolvedAt: nowISO };
for (const h of reappeared) delete resolvedMem[h];
// Cap resolved memory by most-recent.
const resolvedTrimmed = Object.fromEntries(
  Object.entries(resolvedMem).sort((a, b) => String(b[1].resolvedAt).localeCompare(String(a[1].resolvedAt))).slice(0, RESOLVED_MAX),
);

const sevOf = (hs) => hs.reduce((m, h) => { const s = active[h]?.severity || "unknown"; m[s] = (m[s] || 0) + 1; return m; }, {});
const newHiCrit = isNew.filter((h) => ["critical", "high"].includes(active[h]?.severity)).length;

const allBySeverity = perSubject.reduce((m, s) => {
  for (const [k, v] of Object.entries(s.bySeverity)) m[k] = (m[k] || 0) + v;
  return m;
}, {});
const worst = ["critical", "high", "medium", "low", "info", "unknown"].find((s) => allBySeverity[s]) || "none";

// --- write aggregate summary ---------------------------------------------------
const summary = {
  updated: nowISO,
  source: "serus",
  status: grandTotal === 0 ? "clear" : "exposures-found",
  totalExposures: grandTotal,
  highestSeverity: worst,
  bySeverity: allBySeverity,
  delta: { new: isNew.length, resolved: resolved.length, reappeared: reappeared.length, newHighOrCritical: newHiCrit, newBySeverity: sevOf(isNew) },
  removals: removalStatus,
  autoRemove: AUTO_REMOVE,
  subjects: perSubject,
  note: "Aggregate/hashed only. No personal data is stored in these files by design.",
};
writeFileSync(join(dataDir, "exposure.json"), JSON.stringify(summary, null, 2) + "\n");

// --- persist monitoring state (hashed) ----------------------------------------
writeFileSync(statePath, JSON.stringify({ updated: nowISO, active, resolved: resolvedTrimmed }, null, 2) + "\n");

// --- append trend history (one point/day; replace same-day) -------------------
const histPath = join(dataDir, "exposure-history.json");
const history = readJSON(histPath, []);
const point = {
  date: today, updated: nowISO, total: grandTotal, highestSeverity: worst,
  bySeverity: allBySeverity, new: isNew.length, resolved: resolved.length,
  reappeared: reappeared.length, removalsRequested: removalStatus.requested,
};
const hist = Array.isArray(history) ? history.filter((p) => p.date !== today) : [];
hist.push(point);
writeFileSync(histPath, JSON.stringify(hist.slice(-HISTORY_MAX), null, 2) + "\n");

console.log(`Wrote exposure.json — ${grandTotal} exposure(s), highest ${worst}; +${isNew.length} new, -${resolved.length} resolved, ${reappeared.length} reappeared.`);

// --- surface + alert (aggregate only) -----------------------------------------
stepSummary([
  `### Serus exposure scan — ${today}`,
  ``,
  `- **Total exposures:** ${grandTotal} (highest severity: \`${worst}\`)`,
  `- **New since last run:** ${isNew.length} (${newHiCrit} high/critical)`,
  `- **Resolved:** ${resolved.length} · **Reappeared:** ${reappeared.length}`,
  `- **Removals:** ${removalStatus.requested} requested · ${removalStatus.inProgress} in progress · ${removalStatus.removed} removed${AUTO_REMOVE ? "" : " · _(auto-remove off)_"}`,
].join("\n"));
if (newHiCrit > 0) gha.warn(`${newHiCrit} new high/critical exposure(s) detected by Serus.`);
if (reappeared.length > 0) gha.warn(`${reappeared.length} previously-removed exposure(s) have REAPPEARED.`);

if (ALERT_WEBHOOK && (newHiCrit > 0 || reappeared.length > 0)) {
  try {
    await fetch(ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Aggregate only — deliberately no names, sources, or values.
      body: JSON.stringify({
        text: `Serus exposure alert (${today}): ${newHiCrit} new high/critical, ${reappeared.length} reappeared, ${grandTotal} total. See private artifact for detail.`,
        summary: { date: today, total: grandTotal, newHighOrCritical: newHiCrit, reappeared: reappeared.length, highestSeverity: worst },
      }),
    });
    console.log("Posted aggregate alert to SERUS_ALERT_WEBHOOK.");
  } catch (e) {
    console.warn(`Alert webhook failed: ${e.message}`);
  }
}

// Raw masked findings → private artifact path only (opt-in via env), never committed.
const rawOut = process.env.SERUS_RAW_OUT;
if (rawOut) {
  writeFileSync(rawOut, JSON.stringify({ updated: nowISO, bySubject: rawBySubject }, null, 2) + "\n");
  console.log(`Wrote raw masked findings to ${rawOut} (for private artifact upload).`);
}
