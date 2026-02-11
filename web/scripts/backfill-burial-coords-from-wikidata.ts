/**
 * Backfill burial coordinates for PUBLISHED Death Atlas rows using Wikidata.
 *
 * Filters:
 * - is_published = true
 * - burial_latitude IS NULL AND burial_longitude IS NULL
 *
 * Resolution:
 * - Prefer wikidata_id if present (normalize Q####)
 * - Else derive QID from wikipedia_url using Wikidata API (more reliable than SPARQL)
 *
 * Burial logic (SAFE):
 * - Fetch burial place (P119). If missing => count as NoBurial.
 * - If burial place has coords (P625) => use those.
 * - Else (burial place exists but has no coords):
 *     try person's coords (P625) ONLY as a fallback.
 *
 * Usage:
 *   cd C:\death-atlas\web
 *   npx ts-node scripts/backfill-burial-coords-from-wikidata.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type DeathRow = {
  id: string;
  title: string | null;
  wikidata_id: string | null;
  wikipedia_url: string | null;
  is_published: boolean | null;

  burial_latitude: number | null;
  burial_longitude: number | null;
  burial_place_name: string | null;
  burial_source_url: string | null;
  burial_wikidata_id: string | null;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in environment."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const SPARQL_DELAY_MS = Number(process.env.SPARQL_DELAY_MS || 250);

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function isValidNumber(n: any): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function normalizeQid(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/\bQ\d+\b/i);
  return m ? m[0].toUpperCase() : null;
}

function parsePointWktLike(value: string): { lat: number; lon: number } | null {
  // Wikidata SPARQL returns: "Point(LON LAT)"
  const m = value.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/i);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function wikipediaTitleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/wiki/");
    if (parts.length < 2) return null;
    const title = parts[1];
    if (!title) return null;
    return decodeURIComponent(title);
  } catch {
    return null;
  }
}

/**
 * Reliable Wikipedia->Wikidata QID resolution using Wikidata API.
 * Handles redirects and avoids brittle SPARQL schema:name matching.
 */
async function qidFromWikipediaUrl(wikipediaUrl: string): Promise<string | null> {
  const title = wikipediaTitleFromUrl(wikipediaUrl);
  if (!title) return null;

  const apiUrl =
    "https://www.wikidata.org/w/api.php?" +
    new URLSearchParams({
      action: "wbgetentities",
      sites: "enwiki",
      titles: title,
      props: "info",
      format: "json",
      origin: "*",
      redirects: "yes",
    }).toString();

  const resp = await fetch(apiUrl, {
    headers: {
      "User-Agent": "DeathAtlas/1.0 (burial backfill)",
      Accept: "application/json",
    },
  });

  if (!resp.ok) return null;

  const json: any = await resp.json();
  const entities = json?.entities;
  if (!entities || typeof entities !== "object") return null;

  // entities keys are QIDs when found, or "-1" when not found
  const keys = Object.keys(entities);
  const qKey = keys.find((k) => /^Q\d+$/i.test(k));
  return qKey ? qKey.toUpperCase() : null;
}

type SparqlBurialResult = {
  burialPlaceQid: string | null;
  burialPlaceLabel: string | null;

  burialLat: number | null;
  burialLon: number | null;

  // personCoord fallback (only used when burial place exists but no coords)
  personLat: number | null;
  personLon: number | null;

  burialEntityUrl: string | null;
};

async function fetchBurialFromWikidata(qid: string): Promise<SparqlBurialResult> {
  // We fetch:
  // - P119 burial place (+ label)
  // - burial place coords (P625)
  // - person coords (P625) as fallback
  const query = `
SELECT ?burialPlace ?burialPlaceLabel ?burialCoord ?personCoord WHERE {
  wd:${qid} wdt:P119 ?burialPlace .
  OPTIONAL { ?burialPlace wdt:P625 ?burialCoord . }
  OPTIONAL { wd:${qid} wdt:P625 ?personCoord . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 1
`.trim();

  const url =
    "https://query.wikidata.org/sparql?format=json&query=" +
    encodeURIComponent(query);

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "DeathAtlas/1.0 (burial backfill)",
      Accept: "application/sparql-results+json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`SPARQL ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json: any = await resp.json();
  const b = json?.results?.bindings?.[0];
  if (!b) {
    return {
      burialPlaceQid: null,
      burialPlaceLabel: null,
      burialLat: null,
      burialLon: null,
      personLat: null,
      personLon: null,
      burialEntityUrl: null,
    };
  }

  const burialEntityUrl = b?.burialPlace?.value ?? null;
  const burialPlaceLabel = b?.burialPlaceLabel?.value ?? null;
  const burialPlaceQid = normalizeQid(burialEntityUrl);

  let burialLat: number | null = null;
  let burialLon: number | null = null;
  const burialCoordVal = b?.burialCoord?.value ?? null;
  if (typeof burialCoordVal === "string") {
    const p = parsePointWktLike(burialCoordVal);
    if (p) {
      burialLat = p.lat;
      burialLon = p.lon;
    }
  }

  let personLat: number | null = null;
  let personLon: number | null = null;
  const personCoordVal = b?.personCoord?.value ?? null;
  if (typeof personCoordVal === "string") {
    const p = parsePointWktLike(personCoordVal);
    if (p) {
      personLat = p.lat;
      personLon = p.lon;
    }
  }

  return {
    burialPlaceQid,
    burialPlaceLabel,
    burialLat,
    burialLon,
    personLat,
    personLon,
    burialEntityUrl,
  };
}

async function fetchPublishedRowsNeedingBurialBatch(
  offset: number,
  limit: number
): Promise<DeathRow[]> {
  const { data, error } = await supabase
    .from("death_locations")
    .select(
      "id,title,wikidata_id,wikipedia_url,is_published,burial_latitude,burial_longitude,burial_place_name,burial_source_url,burial_wikidata_id"
    )
    .eq("is_published", true)
    .is("burial_latitude", null)
    .is("burial_longitude", null)
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return (data ?? []) as DeathRow[];
}

async function updateRowBurial(
  id: string,
  patch: Partial<DeathRow>
): Promise<void> {
  const { error } = await supabase.from("death_locations").update(patch).eq("id", id);
  if (error) throw error;
}

async function main() {
  console.log("Backfill burial coords from Wikidata (published only)");
  console.log(`Batch size: ${BATCH_SIZE}, SPARQL delay: ${SPARQL_DELAY_MS}ms`);

  let offset = 0;

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalNoQid = 0;
  let totalNoBurial = 0;
  let totalNoCoords = 0;
  let totalErrors = 0;

  let printedNoBurial = 0;

  while (true) {
    const rows = await fetchPublishedRowsNeedingBurialBatch(offset, BATCH_SIZE);
    if (!rows.length) break;

    console.log(`\nFetched ${rows.length} rows (offset ${offset})`);

    for (const r of rows) {
      totalProcessed++;

      // Resolve QID
      let qid = normalizeQid(r.wikidata_id);

      if (!qid && r.wikipedia_url) {
        qid = await qidFromWikipediaUrl(r.wikipedia_url);
        await sleep(SPARQL_DELAY_MS);
      }

      if (!qid) {
        totalNoQid++;
        continue;
      }

      try {
        const burial = await fetchBurialFromWikidata(qid);

        if (!burial.burialPlaceQid) {
          totalNoBurial++;
          if (printedNoBurial < 8) {
            printedNoBurial++;
            console.log(`— No P119 for: ${r.title ?? r.id} (qid=${qid})`);
          }
          await sleep(SPARQL_DELAY_MS);
          continue;
        }

        // Choose coords:
        // 1) burial place coords
        // 2) else (burial place exists) person coords (fallback)
        let chosenLat: number | null = null;
        let chosenLon: number | null = null;
        let chosenSourceUrl: string | null = null;

        if (isValidNumber(burial.burialLat) && isValidNumber(burial.burialLon)) {
          chosenLat = burial.burialLat;
          chosenLon = burial.burialLon;
          chosenSourceUrl = burial.burialEntityUrl;
        } else if (
          isValidNumber(burial.personLat) &&
          isValidNumber(burial.personLon)
        ) {
          chosenLat = burial.personLat;
          chosenLon = burial.personLon;
          chosenSourceUrl = `https://www.wikidata.org/wiki/${qid}`;
        }

        if (!isValidNumber(chosenLat) || !isValidNumber(chosenLon)) {
          totalNoCoords++;

          // Still store burial place info
          await updateRowBurial(r.id, {
            burial_place_name: burial.burialPlaceLabel ?? r.burial_place_name,
            burial_wikidata_id: burial.burialPlaceQid ?? r.burial_wikidata_id,
            burial_source_url: burial.burialEntityUrl ?? r.burial_source_url,
          });

          totalUpdated++;
          await sleep(SPARQL_DELAY_MS);
          continue;
        }

        await updateRowBurial(r.id, {
          burial_latitude: chosenLat,
          burial_longitude: chosenLon,
          burial_place_name: burial.burialPlaceLabel ?? r.burial_place_name,
          burial_wikidata_id: burial.burialPlaceQid ?? r.burial_wikidata_id,
          burial_source_url: chosenSourceUrl ?? r.burial_source_url,
        });

        totalUpdated++;
        console.log(
          `✔ ${r.title ?? r.id} → ${burial.burialPlaceLabel ?? burial.burialPlaceQid} (${chosenLat}, ${chosenLon})`
        );
      } catch (e: any) {
        totalErrors++;
        console.warn(`Error for ${r.title ?? r.id}: ${e?.message ?? e}`);
        await sleep(Math.max(1000, SPARQL_DELAY_MS));
      }

      await sleep(SPARQL_DELAY_MS);
    }

    offset += BATCH_SIZE;
  }

  console.log("\nDone.");
  console.log({
    totalProcessed,
    totalUpdated,
    totalNoQid,
    totalNoBurial,
    totalNoCoords,
    totalErrors,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
