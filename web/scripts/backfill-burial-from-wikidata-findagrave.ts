/**
 * Backfill Find A Grave + burial (cemetery-level) data from Wikidata:
 * - P535 Find A Grave memorial ID -> findagrave_memorial_id, findagrave_url
 * - P119 place of burial (cemetery QID) -> burial_place_wikidata_id, burial_address_label
 * - Cemetery P625 coords -> burial_latitude / burial_longitude (cemetery-level)
 *
 * This does NOT scrape Find A Grave. It only uses Wikidata SPARQL.
 *
 * Usage:
 *   cd C:\death-atlas\web
 *   npx ts-node scripts\backfill-burial-from-wikidata-findagrave.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type DeathLocationRow = {
  id: string;
  wikidata_id: string | null;
  is_published: boolean | null;

  merged_into_id?: string | null;

  burial_address_label: string | null;
  burial_latitude: number | null;
  burial_longitude: number | null;

  findagrave_url: string | null;
  burial_place_wikidata_id: string | null;
  findagrave_memorial_id: string | null;
};

type SparqlBinding = {
  [k: string]: { type: string; value: string };
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function qidToWd(qid: string) {
  // normalize "Q123" (already) or full URL
  const m = qid.match(/Q\d+/i);
  return m ? m[0].toUpperCase() : qid.toUpperCase();
}

function parseWktPoint(wkt: string): { lon: number; lat: number } | null {
  // Example: "Point(-118.25 34.05)"
  const m = wkt.match(/Point\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon, lat };
}

async function sparqlQuery(qids: string[]) {
  const values = qids.map((q) => `wd:${qidToWd(q)}`).join(" ");
  const query = `
SELECT ?person ?memorialId ?burialPlace ?burialPlaceLabel ?coord ?address
WHERE {
  VALUES ?person { ${values} }

  OPTIONAL { ?person wdt:P535 ?memorialId . }

  OPTIONAL {
    ?person wdt:P119 ?burialPlace .
    OPTIONAL { ?burialPlace wdt:P625 ?coord . }
    OPTIONAL { ?burialPlace wdt:P969 ?address . }
  }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`.trim();

  const url =
    "https://query.wikidata.org/sparql?format=json&query=" +
    encodeURIComponent(query);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "DeathAtlas/1.0 (personal project; contact: none)",
      Accept: "application/sparql-results+json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SPARQL failed: ${res.status} ${res.statusText}\n${text}`);
  }

  const json = (await res.json()) as {
    results: { bindings: SparqlBinding[] };
  };

  return json.results.bindings;
}

function memorialUrl(memorialId: string) {
  // canonical memorial URL format
  const id = memorialId.trim();
  return `https://www.findagrave.com/memorial/${id}`;
}

async function main() {
  const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabase = createClient(supabaseUrl, supabaseAnon);

  console.log("Backfill: Wikidata (P535 + P119) -> Find A Grave + burial cemetery coords");
  console.log("Supabase:", supabaseUrl);

  const pageSize = 500;
  let from = 0;

  let scanned = 0;
  let updated = 0;

  while (true) {
    // Pull only published rows that have a wikidata_id and are not merged-away
    const { data: rows, error } = await supabase
      .from("death_locations")
      .select(
        "id,wikidata_id,is_published,merged_into_id,burial_address_label,burial_latitude,burial_longitude,findagrave_url,burial_place_wikidata_id,findagrave_memorial_id"
      )
      .eq("is_published", true)
      .is("merged_into_id", null)
      .not("wikidata_id", "is", null)
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!rows || rows.length === 0) break;

    const typedRows = rows as DeathLocationRow[];
    scanned += typedRows.length;

    // Only query Wikidata for rows missing ANY of the target fields (avoid redundant work)
    const needs = typedRows.filter((r) => {
      return (
        !r.findagrave_memorial_id ||
        !r.findagrave_url ||
        !r.burial_place_wikidata_id ||
        !r.burial_address_label ||
        r.burial_latitude == null ||
        r.burial_longitude == null
      );
    });

    if (needs.length === 0) {
      from += pageSize;
      continue;
    }

    const qids = Array.from(
      new Set(needs.map((r) => qidToWd(r.wikidata_id!)))
    );

    // Wikidata endpoint likes smallish batches; 50 is safe
    const batchSize = 50;
    for (let i = 0; i < qids.length; i += batchSize) {
      const chunk = qids.slice(i, i + batchSize);

      // polite delay to reduce SPARQL load
      if (i > 0) await new Promise((r) => setTimeout(r, 250));

      const bindings = await sparqlQuery(chunk);

      // Map by person QID (e.g. "http://www.wikidata.org/entity/Q123")
      const byQid = new Map<string, SparqlBinding[]>();
      for (const b of bindings) {
        const personUrl = b.person?.value;
        const q = personUrl?.match(/Q\d+/i)?.[0]?.toUpperCase();
        if (!q) continue;
        const arr = byQid.get(q) ?? [];
        arr.push(b);
        byQid.set(q, arr);
      }

      // For each row in this chunk, compute the best update
      const rowsInChunk = needs.filter((r) => chunk.includes(qidToWd(r.wikidata_id!)));

      for (const row of rowsInChunk) {
        const q = qidToWd(row.wikidata_id!);
        const bs = byQid.get(q);
        if (!bs || bs.length === 0) continue;

        // There can be multiple bindings (multiple burial places etc.)
        // We'll pick the first non-null values we see.
        let memorialId: string | null = null;
        let burialPlaceQid: string | null = null;
        let burialLabel: string | null = null;
        let coordWkt: string | null = null;
        let address: string | null = null;

        for (const b of bs) {
          if (!memorialId && b.memorialId?.value) memorialId = b.memorialId.value;
          if (!burialPlaceQid && b.burialPlace?.value) {
            burialPlaceQid = b.burialPlace.value.match(/Q\d+/i)?.[0]?.toUpperCase() ?? null;
          }
          if (!burialLabel && b.burialPlaceLabel?.value) burialLabel = b.burialPlaceLabel.value;
          if (!coordWkt && b.coord?.value) coordWkt = b.coord.value;
          if (!address && b.address?.value) address = b.address.value;
        }

        const point = coordWkt ? parseWktPoint(coordWkt) : null;

        // Build burial_address_label: prefer label; optionally include address if present
        const labelCombined =
          burialLabel && address ? `${burialLabel} — ${address}` : burialLabel ?? null;

        // Only write fields that are currently null (avoid overwriting your manual edits)
        const patch: Partial<DeathLocationRow> = {};

        if (!row.findagrave_memorial_id && memorialId) patch.findagrave_memorial_id = memorialId;
        if (!row.findagrave_url && memorialId) patch.findagrave_url = memorialUrl(memorialId);

        if (!row.burial_place_wikidata_id && burialPlaceQid) patch.burial_place_wikidata_id = burialPlaceQid;
        if (!row.burial_address_label && labelCombined) patch.burial_address_label = labelCombined;

        // Cemetery coords -> burial_lat/long (cemetery-level)
        if (row.burial_latitude == null && point) patch.burial_latitude = point.lat;
        if (row.burial_longitude == null && point) patch.burial_longitude = point.lon;

        const keys = Object.keys(patch);
        if (keys.length === 0) continue;

        const { error: upErr } = await supabase
          .from("death_locations")
          .update(patch)
          .eq("id", row.id);

        if (upErr) {
          console.error("❌ Update failed:", row.id, row.wikidata_id, upErr.message);
        } else {
          updated += 1;
          console.log(
            `✅ ${row.wikidata_id} -> updated: ${keys.join(", ")}`
          );
        }
      }
    }

    from += pageSize;
  }

  console.log(`Done. Scanned=${scanned} Updated=${updated}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
