/**
 * scrape-findadeath-place-hints-to-supabase.ts
 *
 * Find-A-Death rarely has a structured "Place of Death" field.
 * This script instead mines the narrative body text for *hints* like:
 *   "died in ___", "was killed in ___", "shot in ___", etc.
 *
 * It stores results into:
 *   - findadeath_place_hint (text)
 *   - findadeath_place_hint_confidence (smallint 0..100)
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   TABLE=death_locations
 *   ID_COL=id
 *   SOURCE_COL=source
 *   SOURCE_VAL=findadeath
 *   URL_COL=source_url
 *   HINT_COL=findadeath_place_hint
 *   CONF_COL=findadeath_place_hint_confidence
 *
 *   WHERE= (additional filter, simple formats: col=val, col.is.null, col.is.not.null)
 *   LIMIT=0
 *   DB_BATCH=50
 *   CONCURRENCY=3
 *   MIN_DELAY_MS=350
 *   TIMEOUT_MS=20000
 *   RETRIES=2
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
const SOURCE_COL = process.env.SOURCE_COL || "source";
const SOURCE_VAL = process.env.SOURCE_VAL || "findadeath";
const URL_COL = process.env.URL_COL || "source_url";

const HINT_COL = process.env.HINT_COL || "findadeath_place_hint";
const CONF_COL = process.env.CONF_COL || "findadeath_place_hint_confidence";

const WHERE = (process.env.WHERE || "").trim();
const LIMIT = Number(process.env.LIMIT || "0");
const DB_BATCH = Number(process.env.DB_BATCH || "50");
const CONCURRENCY = Number(process.env.CONCURRENCY || "3");
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "350");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || "20000");
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
      "User-Agent": "DeathAtlasBot/1.0 node-fetch",
      Accept: "text/html,application/xhtml+xml",
    },
  }).finally(() => clearTimeout(t));
}

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

function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract one best "place hint" from narrative text.
 * Returns { hint, confidence } or null.
 *
 * Confidence heuristic:
 * - Strong verbs + "in/at/near" + multi-word proper-looking phrase => ~55-75
 * - Weak or ambiguous phrase => ~25-45
 * - If it looks like junk or too generic => null
 */
function extractPlaceHint(text: string): { hint: string; confidence: number } | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length < 80) return null;

  // Common “event verbs”
  const patterns: Array<{ rx: RegExp; base: number }> = [
    { rx: /\b(?:died|dead)\s+(?:in|at|near)\s+([^.;:]{5,120})/i, base: 55 },
    { rx: /\bwas\s+killed\s+(?:in|at|near)\s+([^.;:]{5,120})/i, base: 65 },
    { rx: /\b(?:shot|stabbed|murdered|strangled|beaten)\s+(?:in|at|near)\s+([^.;:]{5,120})/i, base: 65 },
    { rx: /\b(?:crashed|wrecked)\s+(?:in|at|near)\s+([^.;:]{5,120})/i, base: 60 },
    { rx: /\bfound\s+(?:dead\s+)?(?:in|at|near)\s+([^.;:]{5,120})/i, base: 55 },
    { rx: /\b(?:drowned)\s+(?:in|at|near)\s+([^.;:]{5,120})/i, base: 60 },
  ];

  for (const { rx, base } of patterns) {
    const m = t.match(rx);
    if (!m?.[1]) continue;

    let hint = m[1].trim();

    // Trim trailing filler
    hint = hint
      .replace(/\b(?:on|when|after|before)\b.*$/i, "")
      .replace(/\s+\(.*?\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Reject overly generic hits
    const lower = hint.toLowerCase();
    if (lower === "his home" || lower === "her home" || lower === "home") continue;
    if (lower.startsWith("a ")) continue;
    if (hint.length < 6) continue;

    // If it contains a comma, that often indicates city, state/country
    let confidence = base;
    if (hint.includes(",")) confidence += 10;

    // Proper-looking (has capital letters)
    if (/[A-Z]/.test(hint)) confidence += 5;

    // Cap
    confidence = Math.max(0, Math.min(90, confidence));

    return { hint, confidence };
  }

  return null;
}

async function fetchBatch(offset: number, limit: number): Promise<Row[]> {
  let q = supabase
    .from(TABLE)
    .select(`${ID_COL}, ${SOURCE_COL}, ${URL_COL}, ${HINT_COL}, ${CONF_COL}`)
    .eq(SOURCE_COL, SOURCE_VAL)
    .not(URL_COL, "is", null);

  // only rows not yet processed (hint null OR empty)
  q = q.or(`${HINT_COL}.is.null,${HINT_COL}.eq.`);

  q = applyWhere(q, WHERE);
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
      const text = htmlToText(html);

      const extracted = extractPlaceHint(text);

      // Mark as attempted even if null: store "" and 0
      const hint = extracted?.hint ?? "";
      const conf = extracted?.confidence ?? 0;

      await updateHint(id, hint, conf, url);
      return { ok: true, id, url, hint, conf };
    } catch (e: any) {
      lastErr = e;
      await sleep(400 * (attempt + 1));
    }
  }

  return { ok: false, id, url, error: lastErr?.message || String(lastErr) };
}

async function run() {
  console.log("=== FindADeath: Narrative Place Hints → Supabase ===");
  console.log(
    JSON.stringify(
      { TABLE, ID_COL, SOURCE_COL, SOURCE_VAL, URL_COL, HINT_COL, CONF_COL, WHERE: WHERE || null, LIMIT, DB_BATCH, CONCURRENCY },
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
              const preview = (r.hint || "").length > 90 ? (r.hint || "").slice(0, 87) + "..." : (r.hint || "");
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
