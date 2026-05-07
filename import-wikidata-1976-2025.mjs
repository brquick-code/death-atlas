/**
 * import-wikidata-1976-2025.mjs (MONTH-SLICED + RETRIES)
 *
 * Imports humans from Wikidata who died in years 1976..2025 inclusive.
 *
 * Pulls:
 * - P570 date of death
 * - P20  place of death + place coords (P625)
 * - P119 place of burial + place coords (P625) [optional]
 *
 * Writes to Supabase table: death_locations
 *
 * Required env vars (PowerShell):
 *   $env:SUPABASE_URL = "https://xxxx.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY = "..."
 *
 * Run:
 *   node .\import-wikidata-1976-2025.mjs
 */

import process from "node:process";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const START_YEAR = 1976;
const END_YEAR = 2025;

const WDQS = "https://query.wikidata.org/sparql";
const USER_AGENT = "DeathAtlasImporter/1.0 (ben)";

// ---- tuning knobs ----
const YEARS_SLEEP_MS = 600;
const MONTHS_SLEEP_MS = 350;
const UPSERT_SLEEP_MS = 10;

const WDQS_LIMIT = 2000; // per month query. If a month exceeds this, see note below.
const WDQS_RETRIES = 8;
const WDQS_BASE_BACKOFF_MS = 800;

const UPSERT_CHUNK = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function qidFromUri(uri) {
  if (!uri) return null;
  const m = String(uri).match(/\/(Q\d+)$/);
  return m ? m[1] : null;
}

function asNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * coord_source is YOUR internal label (death vs burial vs unknown),
 * independent from the DB enum column `type` (person vs event).
 */
function classifyCoordSource(deathLat, deathLon, burialLat, burialLon) {
  if (deathLat != null && deathLon != null) return "death";
  if (burialLat != null && burialLon != null) return "burial";
  return "unknown";
}

function rowQualityScore(row) {
  const hasDeath = row.latitude != null && row.longitude != null;
  const hasBurial = row.burial_latitude != null && row.burial_longitude != null;

  let score = 0;
  if (hasDeath) score += 100;
  if (hasBurial) score += 50;
  if (row.burial_address_label) score += 5;
  if (row.burial_place_wikidata_id) score += 5;
  if (row.title) score += Math.min(String(row.title).length, 40) / 10;
  return score;
}

function dedupeRowsByWikidataId(rows) {
  const best = new Map();
  for (const r of rows) {
    if (!r?.wikidata_id) continue;
    const prev = best.get(r.wikidata_id);
    if (!prev || rowQualityScore(r) > rowQualityScore(prev)) best.set(r.wikidata_id, r);
  }
  return Array.from(best.values());
}

function bindingValue(b, key) {
  return b?.[key]?.value ?? null;
}
function bindingNumber(b, key) {
  return asNumber(bindingValue(b, key));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthStartISO(year, month1to12) {
  return `${year}-${pad2(month1to12)}-01T00:00:00Z`;
}

function monthEndISO(year, month1to12) {
  // end = first day of next month
  if (month1to12 === 12) return `${year + 1}-01-01T00:00:00Z`;
  return `${year}-${pad2(month1to12 + 1)}-01T00:00:00Z`;
}

/**
 * Month-sliced query avoids large OFFSET timeouts.
 */
function buildSparqlMonth(fromIso, toIso, limit) {
  return `
SELECT
  ?person ?personLabel
  ?deathDate
  ?deathPlace ?deathPlaceLabel ?deathLat ?deathLon
  ?burialPlace ?burialPlaceLabel ?burialLat ?burialLon
WHERE {
  ?person wdt:P31 wd:Q5;
          wdt:P570 ?deathDate;
          wdt:P20  ?deathPlace.

  FILTER(?deathDate >= "${fromIso}"^^xsd:dateTime &&
         ?deathDate <  "${toIso}"^^xsd:dateTime)

  ?deathPlace wdt:P625 ?deathCoord.
  BIND(geof:latitude(?deathCoord)  AS ?deathLat)
  BIND(geof:longitude(?deathCoord) AS ?deathLon)

  OPTIONAL {
    ?person wdt:P119 ?burialPlace.
    OPTIONAL {
      ?burialPlace wdt:P625 ?burialCoord.
      BIND(geof:latitude(?burialCoord)  AS ?burialLat)
      BIND(geof:longitude(?burialCoord) AS ?burialLon)
    }
  }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?person
LIMIT ${limit}
`.trim();
}

async function wdqsFetchText(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  return { res, text };
}

function looksLikeTimeoutText(t) {
  const s = String(t || "").toLowerCase();
  return (
    s.includes("timeout") ||
    s.includes("upstream request timeout") ||
    s.includes("gateway time-out") ||
    s.includes("service unavailable") ||
    s.includes("too many requests")
  );
}

/**
 * Robust WDQS query with retries/backoff for non-JSON, 429, 5xx, timeouts.
 */
async function wdqsQueryWithRetry(query) {
  const url = `${WDQS}?` + new URLSearchParams({ format: "json", query }).toString();

  let lastErr = null;

  for (let attempt = 0; attempt <= WDQS_RETRIES; attempt++) {
    const backoff = WDQS_BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);

    try {
      const { res, text } = await wdqsFetchText(url, {
        headers: {
          Accept: "application/sparql+json",
          "User-Agent": USER_AGENT,
        },
      });

      // WDQS sometimes returns HTML/text even with 200
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON
        if (!res.ok || looksLikeTimeoutText(text)) {
          throw new Error(`WDQS non-JSON (${res.status}): ${text.slice(0, 120)}`);
        }
        throw new Error(`WDQS returned non-JSON: ${text.slice(0, 120)}`);
      }

      if (!res.ok) {
        throw new Error(`WDQS HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      return json;
    } catch (e) {
      lastErr = e;

      // If last attempt, throw
      if (attempt === WDQS_RETRIES) break;

      // Backoff then retry
      console.log(
        `WDQS retry ${attempt + 1}/${WDQS_RETRIES} after error: ${e?.message ?? e} | waiting ${backoff}ms`
      );
      await sleep(backoff);
    }
  }

  throw lastErr ?? new Error("WDQS failed with unknown error");
}

/**
 * Upsert rows into Supabase via REST.
 * Requires UNIQUE constraint on death_locations(wikidata_id)
 */
async function supabaseUpsertRows(rows) {
  if (!rows.length) return;

  const url = `${SUPABASE_URL}/rest/v1/death_locations?on_conflict=wikidata_id`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase upsert failed HTTP ${res.status}\n${text.slice(0, 2000)}`);
  }
}

function toSupabaseRow(b) {
  const personUri = bindingValue(b, "person");
  const qid = qidFromUri(personUri);

  const title = bindingValue(b, "personLabel") ?? qid;

  const deathDate = bindingValue(b, "deathDate");
  const deathPlaceQid = qidFromUri(bindingValue(b, "deathPlace"));
  const burialPlaceQid = qidFromUri(bindingValue(b, "burialPlace"));

  const deathLat = bindingNumber(b, "deathLat");
  const deathLon = bindingNumber(b, "deathLon");
  const burialLat = bindingNumber(b, "burialLat");
  const burialLon = bindingNumber(b, "burialLon");

  const burialPlaceLabel = bindingValue(b, "burialPlaceLabel");

  const coord_source = classifyCoordSource(deathLat, deathLon, burialLat, burialLon);
  const sourceUrl = qid ? `https://www.wikidata.org/wiki/${qid}` : personUri;

  return {
    wikidata_id: qid,
    title,

    // DB enum death_type: person | event
    type: "person",

    // REQUIRED by your schema (NOT NULL)
    source_url: sourceUrl,

    // DEATH coords: place of death coordinates
    latitude: deathLat,
    longitude: deathLon,

    // Burial fallback coords (optional)
    burial_latitude: burialLat,
    burial_longitude: burialLon,
    burial_address_label: burialPlaceLabel ?? null,
    burial_place_wikidata_id: burialPlaceQid ?? null,

    // YOUR classification (death vs burial vs unknown)
    coord_source,

    // Audit trail (you added this column)
    coord_notes: `Wikidata: deathDate=${deathDate ?? "null"} deathPlace=${deathPlaceQid ?? "null"} burialPlace=${burialPlaceQid ?? "null"}`,
  };
}

async function importMonth(year, month1to12) {
  const fromIso = monthStartISO(year, month1to12);
  const toIso = monthEndISO(year, month1to12);

  const query = buildSparqlMonth(fromIso, toIso, WDQS_LIMIT);

  const json = await wdqsQueryWithRetry(query);
  const bindings = json?.results?.bindings ?? [];

  if (bindings.length === 0) return { fetched: 0, upserted: 0, deduped: 0, truncated: false };

  // Convert to rows
  const raw = [];
  for (const b of bindings) {
    const row = toSupabaseRow(b);
    if (!row.wikidata_id) continue;
    raw.push(row);
  }

  const deduped = dedupeRowsByWikidataId(raw);
  const dropped = raw.length - deduped.length;

  // Upsert in chunks
  let upserted = 0;
  for (let i = 0; i < deduped.length; i += UPSERT_CHUNK) {
    const chunk = deduped.slice(i, i + UPSERT_CHUNK);
    await supabaseUpsertRows(chunk);
    upserted += chunk.length;
    await sleep(UPSERT_SLEEP_MS);
  }

  // If month hit the LIMIT, it *might* be truncated.
  // (Rare, but possible in very data-heavy months.)
  const truncated = bindings.length >= WDQS_LIMIT;

  return { fetched: bindings.length, upserted, deduped: dropped, truncated };
}

async function importYear(year) {
  console.log(`\n=== Year ${year} ===`);

  let fetchedTotal = 0;
  let upsertedTotal = 0;
  let dedupedTotal = 0;
  let truncatedMonths = 0;

  for (let m = 1; m <= 12; m++) {
    process.stdout.write(`Month ${pad2(m)}... `);
    const r = await importMonth(year, m);
    fetchedTotal += r.fetched;
    upsertedTotal += r.upserted;
    dedupedTotal += r.deduped;
    if (r.truncated) truncatedMonths++;

    console.log(
      `fetched=${r.fetched} upserted=${r.upserted}` +
        (r.deduped ? ` deduped=${r.deduped}` : "") +
        (r.truncated ? ` ⚠️hit LIMIT(${WDQS_LIMIT})` : "")
    );

    await sleep(MONTHS_SLEEP_MS);
  }

  console.log(
    `Year ${year} done. fetched=${fetchedTotal} upserted=${upsertedTotal}` +
      (dedupedTotal ? ` deduped=${dedupedTotal}` : "") +
      (truncatedMonths ? ` | WARNING: ${truncatedMonths} months hit LIMIT(${WDQS_LIMIT})` : "")
  );

  if (truncatedMonths) {
    console.log(
      `NOTE: Some months hit the LIMIT. If you need 100% completeness, we can automatically split those months into weekly slices.`
    );
  }
}

async function main() {
  console.log("Death Atlas: Wikidata import 1976–2025 (month-sliced) starting...");
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Years: ${START_YEAR}..${END_YEAR} | per-month limit=${WDQS_LIMIT}`);
  console.log("This version retries WDQS timeouts and avoids OFFSET paging.\n");

  for (let y = START_YEAR; y <= END_YEAR; y++) {
    await importYear(y);
    await sleep(YEARS_SLEEP_MS);
  }

  console.log("\nAll years complete.");
}

main().catch((e) => {
  console.error("Fatal error:", e?.message ?? e);
  process.exit(1);
});
