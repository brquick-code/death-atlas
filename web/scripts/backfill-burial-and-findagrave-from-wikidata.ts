/**
 * Wikidata backfill (published-only):
 * - P119 place of burial (cemetery QID) -> burial_place_wikidata_id + burial_address_label
 * - P625 coords on cemetery -> burial_latitude / burial_longitude (cemetery-level)
 * - P535 Find A Grave memorial ID -> findagrave_memorial_id + findagrave_url
 *
 * Safe rules:
 * - Only updates fields that are currently NULL (won't overwrite manual/scraped values)
 * - Skips merged rows (merged_into_id is not null)
 *
 * Run:
 *   cd C:\death-atlas\web
 *   npx ts-node scripts\backfill-burial-and-findagrave-from-wikidata.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type Row = {
  id: string;
  title: string | null;
  wikidata_id: string | null;

  is_published: boolean | null;
  merged_into_id: string | null;

  burial_latitude: number | null;
  burial_longitude: number | null;
  burial_address_label: string | null;

  burial_place_wikidata_id: string | null;

  findagrave_memorial_id: string | null;
  findagrave_url: string | null;
};

type SparqlBinding = Record<string, { type: string; value: string }>;

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeQid(input: string) {
  const m = input.match(/Q\d+/i);
  return m ? m[0].toUpperCase() : input.toUpperCase();
}

function memorialUrl(memorialId: string) {
  return `https://www.findagrave.com/memorial/${memorialId.trim()}`;
}

function parseWktPoint(wkt: string): { lat: number; lon: number } | null {
  // "Point(lon lat)"
  const m = wkt.match(/Point\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  return { lat, lon };
}

async function sparql(qids: string[]) {
  const values = qids.map((q) => `wd:${normalizeQid(q)}`).join(" ");
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
}`.trim();

  const url =
    "https://query.wikidata.org/sparql?format=json&query=" +
    encodeURIComponent(query);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "DeathAtlas/1.0 (personal project)",
      Accept: "application/sparql-results+json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SPARQL failed: ${res.status} ${res.statusText}\n${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { results: { bindings: SparqlBinding[] } };
  return json.results.bindings;
}

async function main() {
  const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabase = createClient(supabaseUrl, key);

  // knobs
  const PUBLISHED_ONLY = true;
  const PAGE_SIZE = 200;
  const SPARQL_BATCH = 40;
  const SPARQL_DELAY_MS = 250;

  console.log("Wikidata backfill: burial (P119/P625) + Find A Grave (P535)");
  console.log("Supabase:", supabaseUrl);
  console.log("Mode:", PUBLISHED_ONLY ? "published-only" : "all rows");

  let from = 0;
  let scanned = 0;
  let updated = 0;

  while (true) {
    let q = supabase
      .from("death_locations")
      .select(
        "id,title,wikidata_id,is_published,merged_into_id,burial_latitude,burial_longitude,burial_address_label,burial_place_wikidata_id,findagrave_memorial_id,findagrave_url"
      )
      .is("merged_into_id", null)
      .not("wikidata_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (PUBLISHED_ONLY) q = q.eq("is_published", true);

    const { data, error } = await q;
    if (error) throw error;

    const rows = (data || []) as Row[];
    if (rows.length === 0) break;

    scanned += rows.length;

    const needs = rows.filter((r) => {
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
      from += PAGE_SIZE;
      continue;
    }

    const qids = Array.from(new Set(needs.map((r) => normalizeQid(r.wikidata_id!))));

    for (let i = 0; i < qids.length; i += SPARQL_BATCH) {
      const chunk = qids.slice(i, i + SPARQL_BATCH);
      if (i > 0) await sleep(SPARQL_DELAY_MS);

      const bindings = await sparql(chunk);

      const byQid = new Map<string, SparqlBinding[]>();
      for (const b of bindings) {
        const personUrl = b.person?.value || "";
        const qid = personUrl.match(/Q\d+/i)?.[0]?.toUpperCase();
        if (!qid) continue;
        const arr = byQid.get(qid) ?? [];
        arr.push(b);
        byQid.set(qid, arr);
      }

      const rowsInChunk = needs.filter((r) => chunk.includes(normalizeQid(r.wikidata_id!)));

      for (const row of rowsInChunk) {
        const qid = normalizeQid(row.wikidata_id!);
        const bs = byQid.get(qid);
        if (!bs || bs.length === 0) continue;

        let memorialId: string | null = null;
        let burialPlaceQid: string | null = null;
        let burialLabel: string | null = null;
        let address: string | null = null;
        let coordWkt: string | null = null;

        for (const b of bs) {
          if (!memorialId && b.memorialId?.value) memorialId = b.memorialId.value;

          if (!burialPlaceQid && b.burialPlace?.value) {
            burialPlaceQid =
              b.burialPlace.value.match(/Q\d+/i)?.[0]?.toUpperCase() ?? null;
          }

          if (!burialLabel && b.burialPlaceLabel?.value) burialLabel = b.burialPlaceLabel.value;
          if (!address && b.address?.value) address = b.address.value;
          if (!coordWkt && b.coord?.value) coordWkt = b.coord.value;
        }

        const point = coordWkt ? parseWktPoint(coordWkt) : null;
        const labelCombined =
          burialLabel && address ? `${burialLabel} — ${address}` : burialLabel ?? null;

        const patch: Partial<Row> = {};

        if (!row.findagrave_memorial_id && memorialId) patch.findagrave_memorial_id = memorialId;
        if (!row.findagrave_url && memorialId) patch.findagrave_url = memorialUrl(memorialId);

        if (!row.burial_place_wikidata_id && burialPlaceQid)
          patch.burial_place_wikidata_id = burialPlaceQid;

        if (!row.burial_address_label && labelCombined)
          patch.burial_address_label = labelCombined;

        if (row.burial_latitude == null && point) patch.burial_latitude = point.lat;
        if (row.burial_longitude == null && point) patch.burial_longitude = point.lon;

        const keys = Object.keys(patch);
        if (keys.length === 0) continue;

        const { error: upErr } = await supabase
          .from("death_locations")
          .update(patch)
          .eq("id", row.id);

        if (upErr) {
          console.log(`❌ update failed | ${row.title ?? row.id} | ${qid} | ${upErr.message}`);
        } else {
          updated += 1;
          console.log(`✅ ${row.title ?? row.id} | ${qid} | updated: ${keys.join(", ")}`);
        }
      }
    }

    from += PAGE_SIZE;
  }

  console.log(`Done. Scanned=${scanned} Updated=${updated}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
