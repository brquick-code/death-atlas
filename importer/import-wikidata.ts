/**
 * importer/import-wikidata.ts
 *
 * Month-by-month Wikidata death importer -> public.death_locations
 *
 * Usage:
 *   cd C:\death-atlas\importer
 *   npx tsx import-wikidata.ts 1990 1999
 *
 * Env required:
 *   SCA_SUPABASE_URL
 *   SCA_SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   REQUIRE_ENWIKI=1 (default 1)
 *   MIN_SITELINKS=0 (default 0)
 *   LIMIT=1500 (default 800)   // per SPARQL page
 *   UPSERT_CHUNK=500 (default 250)
 *   PAUSE_MS=900 (default 900) // pause between SPARQL pages
 *   MONTH_PAUSE_MS=600 (default 600) // pause between months
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type WDRow = {
  qid: string;
  label: string;
  deathDate: string; // ISO date or datetime string (often xsd:dateTime)
  sitelinks?: number;

  deathPlaceLabel?: string;
  deathLat?: number;
  deathLng?: number;

  burialPlaceLabel?: string;
  burialLat?: number;
  burialLng?: number;

  enwikiUrl?: string;
  enwikiTitle?: string;
};

type InsertRow = {
  title: string;
  type?: string | null;
  category: string; // NOT NULL in DB (enum)
  summary: string;

  death_date: string | null; // YYYY-MM-DD
  death_year: number | null;

  death_latitude: number | null;
  death_longitude: number | null;

  burial_latitude?: number | null;
  burial_longitude?: number | null;
  burial_place_name?: string | null;

  source_name: string;
  source_url: string;

  wikidata_qid: string | null;
  wikidata_url: string | null;

  wikipedia_url?: string | null;
  enwiki_title?: string | null;

  is_published: boolean;
  is_hidden: boolean;

  coord_source?: string | null;
};

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT =
  "DeathAtlas/1.0 (contact: ben@local; purpose: research + mapping) Node.js script";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SUPABASE_URL = requireEnv("SCA_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SCA_SUPABASE_SERVICE_ROLE_KEY");

const REQUIRE_ENWIKI = String(process.env.REQUIRE_ENWIKI ?? "1") !== "0";
const MIN_SITELINKS = Number(process.env.MIN_SITELINKS ?? "0");

const LIMIT = Number(process.env.LIMIT ?? "800"); // smaller reduces 504s
const UPSERT_CHUNK = Number(process.env.UPSERT_CHUNK ?? "250");
const PAUSE_MS = Number(process.env.PAUSE_MS ?? "900");
const MONTH_PAUSE_MS = Number(process.env.MONTH_PAUSE_MS ?? "600");

const TABLE = "death_locations";
const ON_CONFLICT = "wikidata_qid"; // ✅ must match UNIQUE index on wikidata_qid

// Default for year-based Wikidata imports (cause-of-death unknown)
const DEFAULT_CATEGORY = "natural";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function asNum(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bindingVal(b: any, key: string): string | undefined {
  return b?.[key]?.value ? String(b[key].value) : undefined;
}

function qidFromUri(uri?: string): string | undefined {
  if (!uri) return undefined;
  const m = uri.match(/\/(Q\d+)$/);
  return m ? m[1] : undefined;
}

function parseWKTPoint(wkt?: string): { lat?: number; lng?: number } {
  if (!wkt) return {};
  const m = wkt.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/i);
  if (!m) return {};
  const lng = asNum(m[1]);
  const lat = asNum(m[2]);
  return { lat, lng };
}

function lastDayOfMonth(year: number, month1to12: number) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function buildQueryRange(startISO: string, endISO: string, offset: number) {
  const requireEnwikiClause = REQUIRE_ENWIKI
    ? `
    ?enwikiUrl schema:about ?item ;
              schema:isPartOf <https://en.wikipedia.org/> .
    BIND(REPLACE(STR(?enwikiUrl), "^https://en.wikipedia.org/wiki/", "") AS ?enwikiTitle)
  `
    : `
    OPTIONAL {
      ?enwikiUrl schema:about ?item ;
                schema:isPartOf <https://en.wikipedia.org/> .
      BIND(REPLACE(STR(?enwikiUrl), "^https://en.wikipedia.org/wiki/", "") AS ?enwikiTitle)
    }
  `;

  const sitelinksClause =
    Number.isFinite(MIN_SITELINKS) && MIN_SITELINKS > 0
      ? `
    ?item wikibase:sitelinks ?sitelinks .
    FILTER(?sitelinks >= ${MIN_SITELINKS})
  `
      : `
    OPTIONAL { ?item wikibase:sitelinks ?sitelinks . }
  `;

  return `
SELECT
  ?item ?itemLabel ?deathDate ?sitelinks
  ?deathPlaceLabel ?deathCoord
  ?burialPlaceLabel ?burialCoord
  ?enwikiUrl ?enwikiTitle
WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P570 ?deathDate .

  FILTER(?deathDate >= "${startISO}"^^xsd:dateTime && ?deathDate <= "${endISO}"^^xsd:dateTime)

  ${sitelinksClause}

  OPTIONAL {
    ?item wdt:P20 ?deathPlace .
    ?deathPlace rdfs:label ?deathPlaceLabel .
    FILTER(LANG(?deathPlaceLabel) = "en")
    OPTIONAL { ?deathPlace wdt:P625 ?deathCoord . }
  }

  OPTIONAL {
    ?item wdt:P119 ?burialPlace .
    ?burialPlace rdfs:label ?burialPlaceLabel .
    FILTER(LANG(?burialPlaceLabel) = "en")
    OPTIONAL { ?burialPlace wdt:P625 ?burialCoord . }
  }

  ${requireEnwikiClause}

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?deathDate ?item
LIMIT ${LIMIT}
OFFSET ${offset}
`.trim();
}

async function sparql(query: string) {
  const maxAttempts = 9;
  let attempt = 0;
  let lastErr: any = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/sparql-results+json",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: new URLSearchParams({ format: "json", query }).toString(),
      });

      if (res.ok) return (await res.json()) as any;

      const retryable = [429, 502, 503, 504].includes(res.status);
      const body = await res.text().catch(() => "");
      const msg = `WDQS failed (${res.status}): ${body}`.trim();

      if (!retryable) throw new Error(msg);

      const base = Math.min(45000, 1200 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 700);
      const wait = base + jitter;

      console.warn(
        `⚠️  WDQS ${res.status} attempt ${attempt}/${maxAttempts}. Waiting ${wait}ms...`
      );
      lastErr = new Error(msg);
      await sleep(wait);
    } catch (e: any) {
      const base = Math.min(45000, 1200 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 700);
      const wait = base + jitter;

      console.warn(
        `⚠️  WDQS network attempt ${attempt}/${maxAttempts}: ${
          e?.message ?? e
        }. Waiting ${wait}ms...`
      );
      lastErr = e;
      await sleep(wait);
    }
  }

  throw lastErr ?? new Error("WDQS failed after retries.");
}

async function fetchRange(startISO: string, endISO: string): Promise<WDRow[]> {
  const out: WDRow[] = [];
  let offset = 0;

  while (true) {
    const q = buildQueryRange(startISO, endISO, offset);
    const json = await sparql(q);

    const bindings: any[] = json?.results?.bindings ?? [];
    if (!bindings.length) break;

    for (const b of bindings) {
      const itemUri = bindingVal(b, "item");
      const qid = qidFromUri(itemUri);
      if (!qid) continue;

      const label = bindingVal(b, "itemLabel") ?? "";
      const deathDate = bindingVal(b, "deathDate") ?? "";
      const sitelinks = asNum(bindingVal(b, "sitelinks"));

      const deathPlaceLabel = bindingVal(b, "deathPlaceLabel");
      const deathCoordWkt = bindingVal(b, "deathCoord");
      const d = parseWKTPoint(deathCoordWkt);

      const burialPlaceLabel = bindingVal(b, "burialPlaceLabel");
      const burialCoordWkt = bindingVal(b, "burialCoord");
      const bu = parseWKTPoint(burialCoordWkt);

      const enwikiUrl = bindingVal(b, "enwikiUrl");
      const enwikiTitle = bindingVal(b, "enwikiTitle");

      out.push({
        qid,
        label,
        deathDate,
        sitelinks,
        deathPlaceLabel,
        deathLat: d.lat,
        deathLng: d.lng,
        burialPlaceLabel,
        burialLat: bu.lat,
        burialLng: bu.lng,
        enwikiUrl,
        enwikiTitle: enwikiTitle ? decodeURIComponent(enwikiTitle) : undefined,
      });
    }

    offset += LIMIT;
    await sleep(PAUSE_MS);

    if (bindings.length < LIMIT) break;
  }

  // Dedup within range: keep “best” row per QID
  const dedup = new Map<string, WDRow>();
  const score = (x: WDRow) =>
    (x.deathLat != null && x.deathLng != null ? 2 : 0) +
    (x.burialLat != null && x.burialLng != null ? 2 : 0) +
    (x.enwikiUrl ? 2 : 0) +
    (x.sitelinks != null ? 1 : 0) +
    (x.deathPlaceLabel ? 1 : 0) +
    (x.burialPlaceLabel ? 1 : 0);

  for (const r of out) {
    const prev = dedup.get(r.qid);
    if (!prev || score(r) > score(prev)) dedup.set(r.qid, r);
  }

  return Array.from(dedup.values());
}

function toInsertRow(r: WDRow): InsertRow {
  const wikidataUrl = `https://www.wikidata.org/wiki/${r.qid}`;

  // Normalize to YYYY-MM-DD for DATE columns.
  const deathDate = r.deathDate ? r.deathDate.slice(0, 10) : null;

  const deathYear =
    deathDate && /^\d{4}$/.test(deathDate.slice(0, 4))
      ? Number(deathDate.slice(0, 4))
      : null;

  const hasDeathCoords = r.deathLat != null && r.deathLng != null;

  return {
    title: r.label || r.qid,
    type: "person",
    category: DEFAULT_CATEGORY,
    summary: "",

    death_date: deathDate,
    death_year: deathYear,

    death_latitude: r.deathLat ?? null,
    death_longitude: r.deathLng ?? null,

    burial_latitude: r.burialLat ?? null,
    burial_longitude: r.burialLng ?? null,
    burial_place_name: r.burialPlaceLabel ?? null,

    source_name: "wikidata",
    source_url: wikidataUrl,

    wikidata_qid: r.qid,
    wikidata_url: wikidataUrl,
    wikipedia_url: r.enwikiUrl ?? null,
    enwiki_title: r.enwikiTitle ?? null,

    is_published: false,
    is_hidden: false,

    coord_source: hasDeathCoords ? "death" : null,
  };
}

function looksRetryableSupabaseError(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes("fetch failed") ||
    m.includes("network") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504") ||
    m.includes("bad gateway") ||
    m.includes("<!doctype html") ||
    m.includes("timeout")
  );
}

async function upsertBatch(rows: InsertRow[]) {
  // Guard: remove accidental duplicates by QID in the same call
  const byQid = new Map<string, InsertRow>();
  for (const r of rows) {
    const qid = r.wikidata_qid ?? "";
    if (!qid) continue;
    const prev = byQid.get(qid);
    if (!prev) {
      byQid.set(qid, r);
      continue;
    }
    const score = (x: InsertRow) =>
      (x.death_latitude != null && x.death_longitude != null ? 2 : 0) +
      (x.burial_latitude != null && x.burial_longitude != null ? 2 : 0) +
      (x.wikipedia_url ? 1 : 0) +
      (x.enwiki_title ? 1 : 0);
    if (score(r) >= score(prev)) byQid.set(qid, r);
  }

  const clean = Array.from(byQid.values());
  if (!clean.length) return;

  const maxAttempts = 8;
  let attempt = 0;
  let lastErr: any = null;

  while (attempt < maxAttempts) {
    attempt += 1;

    const { error } = await supabase
      .from(TABLE)
      .upsert(clean as any, { onConflict: ON_CONFLICT });

    if (!error) return;

    const msg = String(error.message || "");

    // Hard schema mismatch: stop immediately with a useful message
    if (msg.includes("no unique or exclusion constraint matching")) {
      throw new Error(
        `Supabase upsert error: ON CONFLICT (${ON_CONFLICT}) has no matching UNIQUE index. ` +
          `Ensure UNIQUE index exists on public.${TABLE}(${ON_CONFLICT}). Actual: ${msg}`
      );
    }

    // If it's a constraint violation that's not transient, stop (don't retry forever)
    const isUniqueViolation = msg.includes(
      "duplicate key value violates unique constraint"
    );
    if (isUniqueViolation && !looksRetryableSupabaseError(msg)) {
      throw new Error(`Supabase upsert error: ${msg}`);
    }

    // Retry transient issues
    if (looksRetryableSupabaseError(msg)) {
      const base = Math.min(30000, 1200 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 800);
      const wait = base + jitter;
      console.warn(
        `⚠️  Supabase upsert transient failure (attempt ${attempt}/${maxAttempts}): ${msg}. Waiting ${wait}ms...`
      );
      lastErr = error;
      await sleep(wait);
      continue;
    }

    // Unknown error: fail fast with message
    throw new Error(`Supabase upsert error: ${msg}`);
  }

  throw new Error(
    `Supabase upsert error: ${String(lastErr?.message ?? lastErr ?? "unknown")}`
  );
}

async function fetchYearByMonthAndUpsert(year: number) {
  let yearTotal = 0;

  for (let m = 1; m <= 12; m++) {
    const dayEnd = lastDayOfMonth(year, m);
    const mm = String(m).padStart(2, "0");
    const startISO = `${year}-${mm}-01T00:00:00Z`;
    const endISO = `${year}-${mm}-${String(dayEnd).padStart(2, "0")}T23:59:59Z`;

    console.log(`  • ${year}-${mm} …`);
    const rows = await fetchRange(startISO, endISO);
    console.log(`    fetched ${rows.length} unique`);

    const inserts = rows.map(toInsertRow);

    for (let i = 0; i < inserts.length; i += UPSERT_CHUNK) {
      const chunk = inserts.slice(i, i + UPSERT_CHUNK);
      await upsertBatch(chunk);
      console.log(
        `    upserted ${Math.min(i + chunk.length, inserts.length)}/${inserts.length}`
      );
      await sleep(150);
    }

    yearTotal += inserts.length;
    await sleep(MONTH_PAUSE_MS);
  }

  console.log(`✅ Year ${year} done (processed ~${yearTotal} rows)\n`);
}

function parseYearsFromArgs(argv: string[]) {
  const start = Number(argv[2]);
  const end = Number(argv[3]);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    console.error("Usage: npx tsx import-wikidata.ts <startYear> <endYear>");
    process.exit(1);
  }
  if (start < 1 || end < 1 || end < start) {
    console.error(`Invalid year range: ${start}..${end}`);
    process.exit(1);
  }
  return { startYear: start, endYear: end };
}

async function main() {
  const { startYear, endYear } = parseYearsFromArgs(process.argv);

  console.log(`Importing years ${startYear}..${endYear} (inclusive)`);
  console.log(
    `Filters: REQUIRE_ENWIKI=${REQUIRE_ENWIKI ? "1" : "0"}  MIN_SITELINKS=${
      MIN_SITELINKS || 0
    }  LIMIT=${LIMIT}  UPSERT_CHUNK=${UPSERT_CHUNK}\n`
  );

  for (let year = startYear; year <= endYear; year++) {
    console.log(`=== Year ${year} ===`);
    await fetchYearByMonthAndUpsert(year);
    await sleep(900);
  }

  console.log("🎉 Import complete.");
}

main().catch((err) => {
  console.error("Importer failed:", err?.message ?? err);
  process.exit(1);
});