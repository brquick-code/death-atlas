/**
 * web/scripts/import-wikidata-deaths-1990s.ts
 *
 * Fetch Wikidata deaths for 1990–1999 (inclusive), month-by-month (fast + stable),
 * apply optional "fame" filters, and write JSON files.
 *
 * Outputs:
 *   web/data/wikidata_deaths_1990.json ... web/data/wikidata_deaths_1999.json
 *   web/data/wikidata_deaths_1990s.json (combined)
 *
 * Run (PowerShell):
 *   cd web
 *   $env:RESUME_YEAR="1992"         # optional, default 1990
 *   $env:MIN_SITELINKS="10"         # optional, default 0 (no sitelinks filter)
 *   $env:REQUIRE_ENWIKI="1"         # optional, default 1
 *   npx tsx scripts/import-wikidata-deaths-1990s.ts
 */

import fs from "node:fs";
import path from "node:path";

type WDRow = {
  qid: string;
  label: string;
  deathDate: string;

  sitelinks?: number;

  deathPlaceLabel?: string;
  deathLat?: number;
  deathLng?: number;

  burialPlaceLabel?: string;
  burialLat?: number;
  burialLng?: number;

  enwikiTitle?: string;
  enwikiUrl?: string;
};

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT =
  "DeathAtlas/1.0 (contact: ben@local; purpose: research + mapping) Node.js script";

const YEARS = Array.from({ length: 10 }, (_, i) => 1990 + i);

// Smaller pages reduce timeouts.
const LIMIT = 1500;
const PAUSE_MS = 900;

// Output goes under web/data
const OUT_DIR = path.join(process.cwd(), "data");

// Resume support (skip earlier years)
const RESUME_YEAR = Number(process.env.RESUME_YEAR || "1990");

// Fame filters
// - REQUIRE_ENWIKI: default ON (1) – requires EN Wikipedia sitelink
// - MIN_SITELINKS: default 0 – no sitelinks threshold unless you set it
const MIN_SITELINKS = Number(process.env.MIN_SITELINKS || "0");
const REQUIRE_ENWIKI = String(process.env.REQUIRE_ENWIKI || "1") !== "0";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
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
  // Wikidata returns WKT "Point(lon lat)"
  if (!wkt) return {};
  const m = wkt.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/i);
  if (!m) return {};
  const lng = asNum(m[1]);
  const lat = asNum(m[2]);
  return { lat, lng };
}

function lastDayOfMonth(year: number, month1to12: number) {
  // Day 0 of next month = last day of current month
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/**
 * Build query for a specific date range, paginated by OFFSET.
 *
 * SPARQL:
 * - human: P31 Q5
 * - date of death: P570
 * - death place: P20
 * - burial place: P119
 * - coords: P625
 * - sitelinks count: wikibase:sitelinks
 * - EN Wikipedia: schema:isPartOf <https://en.wikipedia.org/>
 */
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
  ?item
  ?itemLabel
  ?deathDate
  ?sitelinks

  ?deathPlaceLabel
  ?deathCoord

  ?burialPlaceLabel
  ?burialCoord

  ?enwikiUrl
  ?enwikiTitle
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

/**
 * SPARQL POST + retries/backoff.
 */
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
        body: new URLSearchParams({
          format: "json",
          query,
        }).toString(),
      });

      if (res.ok) return (await res.json()) as any;

      const retryable = [429, 502, 503, 504].includes(res.status);
      const body = await res.text().catch(() => "");
      const msg = `Wikidata SPARQL failed (${res.status}) ${body}`.trim();

      if (!retryable) throw new Error(msg);

      lastErr = new Error(msg);

      const base = Math.min(45000, 1200 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 700);
      const wait = base + jitter;

      console.warn(`⚠️  ${res.status} attempt ${attempt}/${maxAttempts}. Waiting ${wait}ms...`);
      await sleep(wait);
    } catch (e: any) {
      lastErr = e;

      const base = Math.min(45000, 1200 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 700);
      const wait = base + jitter;

      console.warn(`⚠️  Network error attempt ${attempt}/${maxAttempts}: ${e?.message ?? e}. Waiting ${wait}ms...`);
      await sleep(wait);
    }
  }

  throw lastErr ?? new Error("Wikidata SPARQL failed after retries.");
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

        enwikiTitle: enwikiTitle ? decodeURIComponent(enwikiTitle) : undefined,
        enwikiUrl,
      });
    }

    offset += LIMIT;
    await sleep(PAUSE_MS);

    if (bindings.length < LIMIT) break;
  }

  // Dedup within range, prefer rows with more useful fields
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

async function fetchYearByMonth(year: number): Promise<WDRow[]> {
  const all: WDRow[] = [];

  for (let m = 1; m <= 12; m++) {
    const dayEnd = lastDayOfMonth(year, m);
    const mm = String(m).padStart(2, "0");
    const startISO = `${year}-${mm}-01T00:00:00Z`;
    const endISO = `${year}-${mm}-${String(dayEnd).padStart(2, "0")}T23:59:59Z`;

    console.log(`  • ${year}-${mm} …`);
    const rows = await fetchRange(startISO, endISO);
    console.log(`    ${rows.length} rows`);

    all.push(...rows);

    // breather between months
    await sleep(800);
  }

  // Dedup across the year
  const dedup = new Map<string, WDRow>();
  for (const r of all) dedup.set(r.qid, r);
  return Array.from(dedup.values());
}

function writeJson(filePath: string, data: any) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function main() {
  ensureDir(OUT_DIR);

  console.log(
    `\nFilters: REQUIRE_ENWIKI=${REQUIRE_ENWIKI ? "1" : "0"}  MIN_SITELINKS=${MIN_SITELINKS || 0}  LIMIT=${LIMIT}\n`
  );

  const combined: WDRow[] = [];

  for (const year of YEARS) {
    if (year < RESUME_YEAR) continue;

    console.log(`=== Fetching deaths for ${year} ===`);
    const rows = await fetchYearByMonth(year);
    console.log(`Fetched ${rows.length} unique people for ${year}`);

    const outPath = path.join(OUT_DIR, `wikidata_deaths_${year}.json`);
    writeJson(outPath, rows);

    combined.push(...rows);

    await sleep(1500);
    console.log("");
  }

  // Combine + dedup
  const dedup = new Map<string, WDRow>();
  for (const r of combined) dedup.set(r.qid, r);

  const combinedOut = Array.from(dedup.values()).sort((a, b) => {
    const da = a.deathDate || "";
    const db = b.deathDate || "";
    return da.localeCompare(db) || a.qid.localeCompare(b.qid);
  });

  const combinedPath = path.join(OUT_DIR, "wikidata_deaths_1990s.json");
  writeJson(combinedPath, combinedOut);

  console.log(`✅ Done. Wrote combined: data/wikidata_deaths_1990s.json (${combinedOut.length} unique)`);
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
