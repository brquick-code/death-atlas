// scripts/import-wikidata-deaths.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type SparqlBinding = {
  type: string;
  value: string;
};

type SparqlRow = Record<string, SparqlBinding>;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const WDQS_ENDPOINT = "https://query.wikidata.org/sparql";

// A practical safeguard: WDQS will throttle hard if you go too fast.
const USER_AGENT = "DeathAtlasImporter/1.0 (contact: you@example.com)";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function qidFromEntityUrl(url: string): string {
  const parts = url.split("/");
  return parts[parts.length - 1] || url;
}

function numOrNull(v?: SparqlBinding): number | null {
  if (!v?.value) return null;
  const n = Number(v.value);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v?: SparqlBinding): string | null {
  return v?.value ?? null;
}

function buildFindAGraveUrl(memorialId: string | null): string | null {
  if (!memorialId) return null;
  return `https://www.findagrave.com/memorial/${encodeURIComponent(memorialId)}`;
}

function buildWikidataUrl(qid: string | null): string | null {
  if (!qid) return null;
  return `https://www.wikidata.org/wiki/${encodeURIComponent(qid)}`;
}

// --- SPARQL QUERY ---
// This is “#2” in complete form.
// Notes:
// - Wikipedia link: ?enwiki from schema:isPartOf enwiki
// - Find a Grave memorial id: wdt:P535
// - Death coords optional, burial coords optional (for fallback)
function sparqlQueryForYear(year: number): string {
  return `
PREFIX schema: <http://schema.org/>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>

SELECT
  ?person ?personLabel
  ?deathDate
  ?deathPlace ?deathPlaceLabel ?deathLat ?deathLon
  ?burialPlace ?burialPlaceLabel ?burialLat ?burialLon
  ?enwiki
  ?findAGraveId
WHERE {
  ?person wdt:P31 wd:Q5;
          wdt:P570 ?deathDate.

  FILTER(YEAR(?deathDate) = ${year})

  OPTIONAL {
    ?person wdt:P20 ?deathPlace.
    ?deathPlace wdt:P625 ?deathCoord.
    BIND(geof:latitude(?deathCoord) AS ?deathLat)
    BIND(geof:longitude(?deathCoord) AS ?deathLon)
  }

  OPTIONAL {
    ?person wdt:P119 ?burialPlace.
    ?burialPlace wdt:P625 ?burialCoord.
    BIND(geof:latitude(?burialCoord) AS ?burialLat)
    BIND(geof:longitude(?burialCoord) AS ?burialLon)
  }

  OPTIONAL { ?person wdt:P535 ?findAGraveId. }

  OPTIONAL {
    ?enwiki schema:about ?person ;
            schema:isPartOf <https://en.wikipedia.org/> .
  }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;
}

async function fetchSparqlRows(query: string): Promise<SparqlRow[]> {
  const url = new URL(WDQS_ENDPOINT);
  url.searchParams.set("format", "json");
  url.searchParams.set("query", query);

  // Retry for WDQS timeouts/503/504, etc.
  const maxRetries = 8;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(url.toString(), {
      headers: {
        "Accept": "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
    });

    if (res.ok) {
      const json = await res.json();
      const bindings: SparqlRow[] = json?.results?.bindings ?? [];
      return bindings;
    }

    const status = res.status;
    const text = await res.text().catch(() => "");
    const wait = Math.min(20000, 800 * attempt * attempt);

    console.warn(
      `WDQS attempt ${attempt}/${maxRetries} failed: ${status}. Waiting ${wait}ms. Body: ${text.slice(0, 200)}`
    );
    await sleep(wait);
  }

  throw new Error("WDQS failed after max retries.");
}

type InsertRow = {
  // Adjust these to your actual DB column names if needed:
  name: string | null;
  death_date: string | null;

  // location fields (assumed)
  lat: number;
  lon: number;

  // "death" or "burial_fallback"
  source_type: string;

  // link fields we added
  wikidata_qid: string | null;
  wikidata_url: string | null;
  wikipedia_url: string | null;
  findagrave_memorial_id: string | null;
  findagrave_url: string | null;
};

function transformBindingToInsertRow(b: SparqlRow): InsertRow | null {
  const personUrl = b.person?.value;
  if (!personUrl) return null;

  const qid = qidFromEntityUrl(personUrl);
  const name = strOrNull(b.personLabel);
  const deathDate = strOrNull(b.deathDate);

  const deathLat = numOrNull(b.deathLat);
  const deathLon = numOrNull(b.deathLon);

  const burialLat = numOrNull(b.burialLat);
  const burialLon = numOrNull(b.burialLon);

  // Choose coordinates: prefer death coords, fallback to burial coords
  let lat: number | null = null;
  let lon: number | null = null;
  let source_type = "death";

  if (deathLat != null && deathLon != null) {
    lat = deathLat;
    lon = deathLon;
    source_type = "death";
  } else if (burialLat != null && burialLon != null) {
    lat = burialLat;
    lon = burialLon;
    source_type = "burial_fallback";
  } else {
    // no usable coords, skip
    return null;
  }

  const wikipediaUrl = strOrNull(b.enwiki);
  const findAGraveId = strOrNull(b.findAGraveId);

  return {
    name,
    death_date: deathDate,
    lat,
    lon,
    source_type,
    wikidata_qid: qid,
    wikidata_url: buildWikidataUrl(qid),
    wikipedia_url: wikipediaUrl,
    findagrave_memorial_id: findAGraveId,
    findagrave_url: buildFindAGraveUrl(findAGraveId),
  };
}

async function upsertBatch(rows: InsertRow[]) {
  if (rows.length === 0) return;

  // Choose a conflict key you actually have.
  // If you already use wikidata_qid as unique, add a unique index in Supabase and use it here.
  // If you DO NOT have a unique constraint yet, this will fail.
  //
  // Recommended: create unique constraint on wikidata_qid:
  //   create unique index death_locations_wikidata_qid_uq on public.death_locations(wikidata_qid);
  //
  // Then keep onConflict: "wikidata_qid"
  const { error } = await supabase
    .from("death_locations")
    .upsert(rows, { onConflict: "wikidata_qid" });

  if (error) throw new Error(`Supabase upsert error: ${error.message}`);
}

async function main() {
  const startYear = Number(process.argv[2] ?? "2000");
  const endYear = Number(process.argv[3] ?? "2025");

  if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) {
    console.error("Usage: ts-node scripts/import-wikidata-deaths.ts 2000 2025");
    process.exit(1);
  }

  console.log(`Importing years ${startYear}..${endYear} (inclusive)`);

  for (let year = startYear; year <= endYear; year++) {
    console.log(`\n=== Year ${year} ===`);
    const query = sparqlQueryForYear(year);
    const bindings = await fetchSparqlRows(query);
    console.log(`WDQS rows: ${bindings.length}`);

    const inserts: InsertRow[] = [];
    for (const b of bindings) {
      const row = transformBindingToInsertRow(b);
      if (row) inserts.push(row);
    }

    console.log(`Rows with coordinates (death or burial fallback): ${inserts.length}`);

    // upsert in chunks to avoid payload limits
    const chunkSize = 1000;
    for (let i = 0; i < inserts.length; i += chunkSize) {
      const chunk = inserts.slice(i, i + chunkSize);
      await upsertBatch(chunk);
      console.log(`Upserted ${i + chunk.length}/${inserts.length}`);
      await sleep(250); // small pause to be polite
    }

    await sleep(800); // per-year pause, helps avoid WDQS anger
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Importer failed:", e);
  process.exit(1);
});
