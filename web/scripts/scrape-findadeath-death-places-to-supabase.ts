/**
 * scrape-findadeath-death-places-to-supabase.ts
 *
 * Scrapes "Place of Death" from FindADeath profile pages and writes it back to Supabase.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env (sane defaults):
 *   TABLE=death_locations                 // Supabase table to read+update
 *   ID_COL=id                             // primary key / unique id column in TABLE
 *   URL_COL=findadeath_url                // column containing the FindADeath profile URL
 *   PLACE_COL=findadeath_death_place_raw  // column to write place-of-death text into
 *   UPDATED_AT_COL=updated_at             // if present, will be set to now() via update payload (optional)
 *
 *   WHERE=                                // extra filter expression (simple "col=val" or "col.is.null", see below)
 *   LIMIT=0                               // 0 = no limit, else cap total processed
 *   DB_BATCH=50                           // number of rows fetched per page
 *   CONCURRENCY=4                         // concurrent fetches
 *   MIN_DELAY_MS=250                      // minimum delay between requests per worker
 *   TIMEOUT_MS=20000                      // fetch timeout
 *   RETRIES=2                             // retries per URL after failure
 *
 * Filtering behavior:
 *   By default, script selects rows where:
 *     - URL_COL is not null
 *     - PLACE_COL is null or empty
 *
 * If WHERE is provided, it is applied in addition to the default selection.
 *
 * Example runs (PowerShell):
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="..."
 *   $env:TABLE="death_locations"
 *   $env:URL_COL="findadeath_url"
 *   $env:PLACE_COL="findadeath_death_place_raw"
 *   npx ts-node scripts\scrape-findadeath-death-places-to-supabase.ts
 */

import { createClient } from "@supabase/supabase-js";

type Row = Record<string, any>;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

const TABLE = process.env.TABLE || "death_locations";
const ID_COL = process.env.ID_COL || "id";
const URL_COL = process.env.URL_COL || "findadeath_url";
const PLACE_COL = process.env.PLACE_COL || "findadeath_death_place_raw";
const UPDATED_AT_COL = process.env.UPDATED_AT_COL || "updated_at";

const WHERE = (process.env.WHERE || "").trim();
const LIMIT = Number(process.env.LIMIT || "0");
const DB_BATCH = Number(process.env.DB_BATCH || "50");
const CONCURRENCY = Number(process.env.CONCURRENCY || "4");
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "250");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || "20000");
const RETRIES = Number(process.env.RETRIES || "2");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampUrl(url: string): string {
  // FindADeath sometimes has whitespace or weird fragments
  return (url || "").trim();
}

function abortableFetch(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: controller.signal,
    headers: {
      // Keep it polite; some sites behave better with a UA
      "User-Agent":
        "DeathAtlasBot/1.0 (+https://example.local) node-fetch (contact: you)",
      Accept: "text/html,application/xhtml+xml",
    },
  }).finally(() => clearTimeout(t));
}

/**
 * Extract "Place of Death" from FindADeath HTML.
 * This is best-effort and uses multiple strategies:
 *  - Label-based: "Place of Death:" followed by text
 *  - Loose: "Place of death" / "Place Of Death" variants
 *  - Table-ish patterns with <b> tags, etc.
 */
function extractPlaceOfDeathFromHtml(html: string): string | null {
  if (!html) return null;

  // Normalize whitespace and <br> tags to help regex
  const brNormalized = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/div>/gi, "\n");

  // Remove scripts/styles for cleaner text scanning
  const stripped = brNormalized
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  // Strategy 1: label in HTML with tags nearby (captures until newline or tag boundary)
  // Example patterns we might see:
  //   Place of Death: Someplace, State
  //   <b>Place of Death:</b> Someplace<br>
  const htmlLabelRegexes: RegExp[] = [
    /Place\s*of\s*Death\s*:\s*(.*?)\n/i,
    /Place\s*of\s*Death\s*:\s*(.*?)</i,
    /Place\s*Of\s*Death\s*:\s*(.*?)\n/i,
    /Place\s*Of\s*Death\s*:\s*(.*?)</i,
    /PLACE\s*OF\s*DEATH\s*:\s*(.*?)\n/i,
    /PLACE\s*OF\s*DEATH\s*:\s*(.*?)</i,
  ];

  for (const rx of htmlLabelRegexes) {
    const m = stripped.match(rx);
    if (m && m[1]) {
      const cleaned = cleanupExtract(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Strategy 2: convert to plain-ish text and scan around label
  const text = stripped
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  // Look for label in text and capture the next chunk
  const textLabelRegexes: RegExp[] = [
    /Place\s*of\s*Death\s*:\s*([^]+?)(?:Place\s*of|Burial|Cemetery|Date\s*of\s*Death|Cause\s*of\s*Death|$)/i,
    /Place\s*of\s*Death\s*-\s*([^]+?)(?:Place\s*of|Burial|Cemetery|Date\s*of\s*Death|Cause\s*of\s*Death|$)/i,
  ];

  for (const rx of textLabelRegexes) {
    const m = text.match(rx);
    if (m && m[1]) {
      const cleaned = cleanupExtract(m[1]);
      if (cleaned) return cleaned;
    }
  }

  return null;
}

function cleanupExtract(raw: string): string | null {
  if (!raw) return null;
  let s = raw;

  // Stop at common separators
  s = s.replace(/\s*(?:\||•|·)\s*.*$/g, ""); // drop " | ..." noise
  s = s.replace(/\s*(?:View|See|Read)\s+.*$/gi, "");

  // Remove leftover tags/entities
  s = s
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  // Sometimes the capture includes trailing labels mashed in
  s = s.replace(/\b(?:Date of Death|Cause of Death|Burial|Cemetery)\b.*$/i, "").trim();

  // If it's too short or looks like a placeholder
  if (!s) return null;
  if (s.toLowerCase() === "unknown") return null;
  if (s.length < 3) return null;

  return s;
}

/**
 * Apply an optional extra WHERE filter.
 * Supported minimal formats:
 *  - "col=val" (string val)
 *  - "col.is.null"
 *  - "col.is.not.null"
 *
 * This keeps it simple; you can still just edit the script if you want complex filters.
 */
function applyWhere(query: any, where: string) {
  const w = where.trim();
  if (!w) return query;

  // col.is.null
  const isNull = w.match(/^([a-zA-Z0-9_]+)\.is\.null$/);
  if (isNull) return query.is(isNull[1], null);

  // col.is.not.null
  const isNotNull = w.match(/^([a-zA-Z0-9_]+)\.is\.not\.null$/);
  if (isNotNull) return query.not(isNotNull[1], "is", null);

  // col=val
  const eq = w.match(/^([a-zA-Z0-9_]+)=(.*)$/);
  if (eq) {
    const col = eq[1];
    let val = eq[2].trim();
    // strip optional quotes
    val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    return query.eq(col, val);
  }

  console.warn(`WHERE format not recognized, ignoring: ${w}`);
  return query;
}

async function fetchBatch(offset: number, limit: number): Promise<Row[]> {
  let q = supabase
    .from(TABLE)
    .select(`${ID_COL}, ${URL_COL}, ${PLACE_COL}`, { count: "exact" })
    .not(URL_COL, "is", null);

  // Only process rows where PLACE_COL is null or empty string
  // Note: Supabase doesn't have an "or empty" helper, so we do OR manually.
  q = q.or(`${PLACE_COL}.is.null,${PLACE_COL}.eq.`);

  q = applyWhere(q, WHERE);

  // Deterministic ordering helps with restartability
  q = q.order(ID_COL, { ascending: true }).range(offset, offset + limit - 1);

  const { data, error } = await q;
  if (error) throw new Error(`DB fetch error: ${error.message}`);
  return data || [];
}

async function updatePlace(id: any, place: string | null, url: string) {
  const payload: Record<string, any> = {
    [PLACE_COL]: place,
  };

  // Only set UPDATED_AT_COL if it exists in your schema; if it doesn't, Supabase will error.
  // To keep this safe by default, we do NOT set it automatically.
  // If you want it, uncomment below and ensure UPDATED_AT_COL exists.
  //
  // payload[UPDATED_AT_COL] = new Date().toISOString();

  const { error } = await supabase.from(TABLE).update(payload).eq(ID_COL, id);
  if (error) {
    throw new Error(
      `DB update error for ${TABLE}.${ID_COL}=${id} url=${url}: ${error.message}`
    );
  }
}

async function processOne(row: Row, workerId: number): Promise<{
  ok: boolean;
  id: any;
  url: string;
  place: string | null;
  error?: string;
}> {
  const id = row[ID_COL];
  const url = clampUrl(row[URL_COL]);

  if (!url) {
    return { ok: false, id, url, place: null, error: "missing url" };
  }

  // rate limit per worker
  await sleep(MIN_DELAY_MS);

  let lastErr: any = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await abortableFetch(url, TIMEOUT_MS);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const html = await res.text();
      const place = extractPlaceOfDeathFromHtml(html);

      // Write something back so we don't re-hit the same page forever.
      // If not found, store "" (empty string) to mark as "attempted".
      await updatePlace(id, place ?? "", url);

      return { ok: true, id, url, place: place ?? "" };
    } catch (err: any) {
      lastErr = err;
      // small backoff
      await sleep(400 * (attempt + 1));
    }
  }

  return {
    ok: false,
    id,
    url,
    place: null,
    error: lastErr?.message || String(lastErr),
  };
}

async function run() {
  console.log("=== FindADeath: Scrape Death Places → Supabase ===");
  console.log(
    JSON.stringify(
      {
        TABLE,
        ID_COL,
        URL_COL,
        PLACE_COL,
        WHERE: WHERE || null,
        LIMIT,
        DB_BATCH,
        CONCURRENCY,
        MIN_DELAY_MS,
        TIMEOUT_MS,
        RETRIES,
      },
      null,
      2
    )
  );

  let offset = 0;
  let processed = 0;
  let ok = 0;
  let failed = 0;

  // Simple worker pool
  const inFlight = new Set<Promise<any>>();

  function addTask(p: Promise<any>) {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  }

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
      // Fill up worker pool
      while (inFlight.size < CONCURRENCY && idx < batch.length) {
        const row = batch[idx++];
        const workerId = (processed + idx) % CONCURRENCY;

        const task = processOne(row, workerId)
          .then((r) => {
            processed++;
            if (r.ok) {
              ok++;
              const preview =
                (r.place || "").length > 80
                  ? (r.place || "").slice(0, 77) + "..."
                  : r.place;
              console.log(
                `OK   ${TABLE}.${ID_COL}=${r.id} place="${preview}"`
              );
            } else {
              failed++;
              console.log(
                `FAIL ${TABLE}.${ID_COL}=${r.id} err="${r.error}" url=${r.url}`
              );
            }
          })
          .catch((e) => {
            processed++;
            failed++;
            console.log(`FAIL (unexpected) err="${e?.message || e}"`);
          });

        addTask(task);
      }

      // Wait for at least one to finish before enqueuing more
      if (inFlight.size >= CONCURRENCY) {
        await Promise.race(inFlight);
      }
    }

    // Drain remaining tasks for this batch
    while (inFlight.size > 0) {
      await Promise.race(inFlight);
    }

    console.log(
      `Progress: processed=${processed} ok=${ok} failed=${failed}`
    );
  }

  console.log("=== Done ===");
  console.log(`processed=${processed} ok=${ok} failed=${failed}`);
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
