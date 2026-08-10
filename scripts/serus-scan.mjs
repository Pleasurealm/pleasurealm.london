#!/usr/bin/env node
// Exposure-protection agent for Moses Kityamuwesi Kisubika and Pleasurealm Ltd.
//
// Runs in the daily GitHub Action. For each subject in data/serus-watch.json it
// asks Serus (https://serus.ai) to scan for exposed personal data — OSINT
// footprint, data-broker listings and dark-web breach hits — then writes a
// REDACTED summary to data/exposure.json and (optionally) opens removal requests.
//
// Two hard privacy rules, because this repo is public:
//   1. data/exposure.json is an AGGREGATE ONLY — counts, severities, categories.
//      No names, emails, URLs or unmasked values are ever committed. The point of
//      the agent is to reduce exposure, so it must not become an exposure itself.
//   2. Raw (still masked) findings are written to $SERUS_RAW_OUT if set — used by
//      the workflow to upload a PRIVATE, retention-limited artifact. They are
//      never committed to the repo.
//
// Auth: set the repo secret SERUS_API_KEY (a Serus key, "ak_..."). With no key
// this script exits 0 and changes nothing. Sensitive identifiers can be supplied
// via the SERUS_SUBJECTS_JSON secret (merged in memory, never written to disk).
//
// The API shapes below follow https://docs.serus.ai/ (base https://api.serus.ai/v1,
// bearer auth, POST a scan, poll for results). If Serus changes paths or field
// names, adjust EP and mapFinding() — they are the two things to touch, exactly
// like the PropertyData adapter in fetch-listings.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KEY = process.env.SERUS_API_KEY;
if (!KEY) {
  console.log("SERUS_API_KEY not set — leaving data/exposure.json untouched (agent idle).");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(root, "data", "serus-watch.json"), "utf8"));

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

const auth = { Authorization: `Bearer ${KEY}`, accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // union array fields (emails/phones/aliases/domains) so the secret adds, not replaces
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
  // de-dupe by finding id
  const seen = new Set();
  return findings.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
}

// Opt-in only: request removal/opt-out for anything removable. Outward-facing and
// may cost credits, so it stays off unless SERUS_AUTO_REMOVE is truthy.
async function requestRemovals(subject, findings) {
  if (!AUTO_REMOVE) return { requested: 0 };
  let requested = 0;
  for (const f of findings) {
    if (!f.removable || f.status.includes("remov")) continue;
    try {
      await api(EP.removal, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectId: subject.id, findingId: f.id }),
      });
      f.status = "removal_requested";
      requested++;
    } catch (e) {
      console.warn(`    removal for ${f.source} failed: ${e.message}`);
    }
    await sleep(300);
  }
  if (requested) console.log(`  ${subject.label}: opened ${requested} removal request(s)`);
  return { requested };
}

const tally = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});

// Build the PUBLIC summary. strict = counts only (default). detailed adds the
// list of source sites (never any subject PII) for on-repo triage.
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
  if (REDACTION !== "strict") {
    s.bySource = tally(findings, "source");
  }
  return s;
}

// --- run -----------------------------------------------------------------------
try {
  const who = await api(EP.verifyKey).catch((e) => { throw new Error(`key verification failed: ${e.message}`); });
  console.log(`Serus key OK${who?.plan ? ` (plan: ${who.plan})` : ""}. Redaction: ${REDACTION}. Auto-remove: ${AUTO_REMOVE}.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const subjects = loadSubjects();
const perSubject = [];
const rawBySubject = {};
let grandTotal = 0;

for (const subject of subjects) {
  const findings = await scanSubject(subject);
  const removals = await requestRemovals(subject, findings);
  perSubject.push(summariseSubject(subject, findings, removals));
  rawBySubject[subject.id] = findings; // masked, but kept out of the repo
  grandTotal += findings.length;
}

// Roll up an overall severity picture and a headline status.
const allBySeverity = perSubject.reduce((m, s) => {
  for (const [k, v] of Object.entries(s.bySeverity)) m[k] = (m[k] || 0) + v;
  return m;
}, {});
const worst = ["critical", "high", "medium", "low", "info", "unknown"].find((s) => allBySeverity[s]) || "none";

const summary = {
  updated: new Date().toISOString(),
  source: "serus",
  status: grandTotal === 0 ? "clear" : "exposures-found",
  totalExposures: grandTotal,
  highestSeverity: worst,
  bySeverity: allBySeverity,
  autoRemove: AUTO_REMOVE,
  subjects: perSubject,
  note: "Aggregate only. No personal data is stored in this file by design.",
};

writeFileSync(join(root, "data", "exposure.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`Wrote data/exposure.json — ${grandTotal} exposure(s), highest severity: ${worst}.`);

// Raw masked findings → private artifact path only (opt-in via env), never committed.
const rawOut = process.env.SERUS_RAW_OUT;
if (rawOut) {
  writeFileSync(rawOut, JSON.stringify({ updated: summary.updated, bySubject: rawBySubject }, null, 2) + "\n");
  console.log(`Wrote raw masked findings to ${rawOut} (for private artifact upload).`);
}
