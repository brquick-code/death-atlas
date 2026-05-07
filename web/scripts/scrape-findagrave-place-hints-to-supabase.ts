/**
 * scrape-findagrave-place-hints-to-supabase.ts
 *
 * Find A Grave is great for burial, but sometimes the obituary/narrative mentions a death location.
 * This script mines the page text for "death location hints" and stores them as review-only fields:
 *   - findagrave_place_hint
 *   - findagrave_place_hint_confidence (0..100)
 *
 * It does NOT geocode, does NOT set death coords, does NOT overwrite death_place_text.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   TABLE=death_locations
 *   ID_COL=id
 *   URL_COL=findagrave_url
 *   HINT_COL=findagrave_place_hint
 *   CONF_COL=findagrave_place_hint_confidence
 *
 *   WHERE= (additional filter, simple formats: col=val, col.is.null, col.is.not.null)
 *   LIMIT=0
 *   DB_BATCH=25
 *   CONCURRENCY=2
 *   MIN_DELAY_MS=750
 *   TIMEOUT_MS=25000
 *   RETRIES=2
 *
 * Notes:
 * - FindAGrave may rate-limit/bot-detect. Keep CONCURRENCY low and MIN_DELAY_MS higher.
 * - Script marks attempted pages by writing "" and 0 when no hint is found.
 */

import { createClient } from "@supabase/supabase-js";

type Row = Record<string, any>;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const TABLE = process.env.TABLE || "death_locations";
const ID_COL = process.env.ID_COL || "id";
const URL_COL = process.env.URL_COL || "findagrave_url";
const HINT_COL = process.env.HINT_COL || "findagrave_place_hint";
const CONF_COL = process.env.CONF_COL || "findagrave_place_hint_confidence";

const WHERE = (process.env.WHERE || "").trim();
const LIMIT = Number(process.env.LIMIT || "0");
const DB_BATCH = Number(process.env.DB_BATCH || "25");
const CONCURRENCY = Number(process.env.CONCURRENCY || "2");
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "750");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || "25000");
const RETRIES = Number(process.env.RETRIES || "2");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function abortableFetch(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: controller.signal,
    headers: {
      // Polite UA; don't pretend to be Chrome, just be consistent.
      "User-Agent": "DeathAtlasBot/1.0 (+local research) node-fetch",
      Accept: "text/html,application/xhtml+xml",
    },
  }).finally(() => clearTimeout(t));
}

/**
 * Apply an optional extra WHERE filter.
 * Supported minimal formats:
 *  - "col=val" (string val)
 *  - "col.is.null"
 *  - "col.is.not.null"
 */
function applyWhere(query: any, where: string) {
  const w = where.trim();
  if (!w) return query;

  const isNull = w.match(/^([a-zA-Z0-9_]+)\.is\.null$/);
  if (isNull) return query.is(isNull[1], null);

  const isNotNull = w.match(/^([a-zA-Z0-9_]+)\.is\.not\.null$/);
  if (isNotNull) return query.not(isNotNull[1], "is", null);

  const eq = w.match(/^([a-zA-Z0-9_]+)=(.*)$/);
  if (eq) {
    const col = eq[1];
    let val = eq[2].trim();
    val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    return query.eq(col, val);
  }

  console.warn(`WHERE format not recognized, ignoring: ${w}`);
  return query;
}

function decodeEntities(s: string): string {
  return (s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripScriptsStyles(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
}

function htmlToText(html: string): string {
  const cleaned = stripScriptsStyles(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n");

  const noTags = cleaned.replace(/<\/?[^>]+>/g, " ");
  const decoded = decodeEntities(noTags);

  return decoded
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Try to extract likely obituary/biography region to reduce noise.
 * FindAGrave HTML changes over time, so we do best-effort:
 * - Look for a chunk around words like "Obituary", "Bio", "Details", etc.
 * - If not found, fall back to full text but cap length.
 */
function extractRelevantText(html: string): string {
  const h = stripScriptsStyles(html);

  // Try common section anchors
  const anchors: RegExp[] = [
    /Obituary/i,
    /\bBio(graphy)?\b/i,
    /\bStory\b/i,
    /\bDetails\b/i,
    /\bNotes\b/i,
    /\bMemories\b/i,
  ];

  // Convert to text early to make anchor search easier
  const fullText = htmlToText(h);
  if (!fullText) return "";

  // Find first anchor occurrence in fullText and take window around it
  let idx = -1;
  for (const a of anchors) {
    const m = fullText.match(a);
    if (m?.index !== undefined) {
      idx = m.index;
      break;
    }
  }

  if (idx >= 0) {
    const start = Math.max(0, idx - 800);
    const end = Math.min(fullText.length, idx + 4000);
    return fullText.slice(start, end);
  }

  // fallback: cap to avoid scanning huge page chrome
  return fullText.slice(0, 6000);
}

/**
 * Extract a single best "death location hint" from narrative text.
 *
 * Confidence rubric (rough):
 * - Strong verb + "in/at/near" + specific phrase => 55–80
 * - "passed away in" tends to be decent => 55–75
 * - If includes comma or looks like City, State => +10
 * - If mentions a hospital/facility with city/state => +10
 * - If too generic ("at home") => reject
 */
function extractPlaceHint(text: string): { hint: string; confidence: number } | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length < 120) return null;

  const patterns: Array<{ rx: RegExp; base: number }> = [
    { rx: /\bpassed\s+away\s+(?:in|at|near)\s+([^.;:]{6,140})/i, base: 62 },
    { rx: /\bdied\s+(?:in|at|near)\s+([^.;:]{6,140})/i, base: 60 },
    { rx: /\bwas\s+killed\s+(?:in|at|near)\s+([^.;:]{6,140})/i, base: 70 },
    { rx: /\b(?:killed|shot|stabbed|murdered|strangled|beaten)\s+(?:in|at|near)\s+([^.;:]{6,140})/i, base: 70 },
    { rx: /\bfound\s+(?:dead\s+)?(?:in|at|near)\s+([^.;:]{6,140})/i, base: 58 },
    { rx: /\bdied\s+at\s+([^.;:]{6,140})/i, base: 58 }, // e.g., "died at St. Mary's Hospital in ..."
  ];

  for (const { rx, base } of patterns) {
    const m = t.match(rx);
    if (!m?.[1]) continue;

    let hint = m[1].trim();

    // Trim trailing filler clauses that often follow the location
    hint = hint
      .replace(/\b(?:on|when|after|before|while|during|following)\b.*$/i, "")
      .replace(/\s+\(.*?\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const lower = hint.toLowerCase();

    // Reject overly generic locations
    if (lower === "home" || lower === "his home" || lower === "her home") continue;
    if (lower.startsWith("a ") || lower.startsWith("the ")) {
      // might be "the hospital" / "a hospital" which is too vague
      if (!lower.includes("hospital") && !lower.includes("medical") && !lower.includes("center")) continue;
    }

    if (hint.length < 6) continue;

    let confidence = base;

    // Bonus: city/state-ish formatting
    if (hint.includes(",")) confidence += 10;

    // Bonus: facility keywords
    if (/(hospital|medical|center|clinic|hospice|nursing|rehab)/i.test(hint)) confidence += 10;

    // Bonus: has capitals (proper noun-ish)
    if (/[A-Z]/.test(hint)) confidence += 5;

    // Cap confidence; narrative is never “certain”
    confidence = Math.max(0, Math.min(85, confidence));

    return { hint, confidence };
  }

  return null;
}

async function fetchBatch(offset: number, limit: number): Promise<Row[]> {
  let q = supabase
    .from(TABLE)
    .select(`${ID_COL}, ${URL_COL}, ${HINT_COL}, ${CONF_COL}`)
    .not(URL_COL, "is", null);

  // only rows not yet processed (hint null OR empty)
  q = q.or(`${HINT_COL}.is.null,${HINT_COL}.eq.`);

  q = applyWhere(q, WHERE);

  // deterministic order for restartability
  q = q.order(ID_COL, { ascending: true }).range(offset, offset + limit - 1);

  const { data, error } = await q;
  if (error) throw new Error(`DB fetch error: ${error.message}`);
  return data || [];
}

async function updateHint(id: any, hint: string, conf: number, url: string) {
  const payload: Record<string, any> = {
    [HINT_COL]: hint,
    [CONF_COL]: conf,
  };

  const { error } = await supabase.from(TABLE).update(payload).eq(ID_COL, id);
  if (error) throw new Error(`DB update error id=${id} url=${url}: ${error.message}`);
}

async function processOne(row: Row): Promise<{ ok: boolean; id: any; url: string; hint?: string; conf?: number; error?: string }> {
  const id = row[ID_COL];
  const url = String(row[URL_COL] || "").trim();
  if (!url) return { ok: false, id, url, error: "missing url" };

  await sleep(MIN_DELAY_MS);

  let lastErr: any = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await abortableFetch(url, TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      const relevant = extractRelevantText(html);
      const extracted = extractPlaceHint(relevant);

      // Mark attempted even if none found
      const hint = extracted?.hint ?? "";
      const conf = extracted?.confidence ?? 0;

      await updateHint(id, hint, conf, url);
      return { ok: true, id, url, hint, conf };
    } catch (e: any) {
      lastErr = e;
      await sleep(700 * (attempt + 1));
    }
  }

  return { ok: false, id, url, error: lastErr?.message || String(lastErr) };
}

async function run() {
  console.log("=== Find A Grave: Narrative Place Hints → Supabase ===");
  console.log(
    JSON.stringify(
      { TABLE, ID_COL, URL_COL, HINT_COL, CONF_COL, WHERE: WHERE || null, LIMIT, DB_BATCH, CONCURRENCY, MIN_DELAY_MS, TIMEOUT_MS, RETRIES },
      null,
      2
    )
  );

  let offset = 0;
  let processed = 0;
  let ok = 0;
  let failed = 0;

  const inFlight = new Set<Promise<void>>();
  const add = (p: Promise<void>) => {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  };

  while (true) {
    if (LIMIT > 0 && processed >= LIMIT) break;

    const remaining = LIMIT > 0 ? Math.min(DB_BATCH, LIMIT - processed) : DB_BATCH;
    const batch = await fetchBatch(offset, remaining);

    if (batch.length === 0) {
      console.log("No more rows matched selection. Done.");
      break;
    }

    console.log(`Fetched ${batch.length} row(s) [offset=${offset}]...`);
    offset += batch.length;

    let idx = 0;
    while (idx < batch.length) {
      while (inFlight.size < CONCURRENCY && idx < batch.length) {
        const row = batch[idx++];

        const task = processOne(row)
          .then((r) => {
            processed++;
            if (r.ok) {
              ok++;
              const preview = (r.hint || "").length > 100 ? (r.hint || "").slice(0, 97) + "..." : (r.hint || "");
              console.log(`OK   ${TABLE}.${ID_COL}=${r.id} conf=${r.conf} hint="${preview}"`);
            } else {
              failed++;
              console.log(`FAIL ${TABLE}.${ID_COL}=${r.id} err="${r.error}" url=${r.url}`);
            }
          })
          .catch((e) => {
            processed++;
            failed++;
            console.log(`FAIL (unexpected) err="${e?.message || e}"`);
          });

        add(task);
      }

      if (inFlight.size >= CONCURRENCY) await Promise.race(inFlight);
    }

    while (inFlight.size > 0) await Promise.race(inFlight);

    console.log(`Progress: processed=${processed} ok=${ok} failed=${failed}`);
  }

  console.log("=== Done ===");
  console.log(`processed=${processed} ok=${ok} failed=${failed}`);
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
