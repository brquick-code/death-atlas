// enrich-burials.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/**
 * Enrich burial info for existing rows in death_locations using wikidata_id (Q####).
 *
 * Requires in .env:
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional in .env:
 *  - BURIAL_BATCH_SIZE (default 50)
 *  - BURIAL_MAX_ROWS   (default 500)
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BATCH_SIZE = Number(process.env.BURIAL_BATCH_SIZE ?? 50);
const MAX_ROWS = Number(process.env.BURIAL_MAX_ROWS ?? 500);

type DeathLocationRow = {
  id: string;
  title: string | null;
  wikidata_id: string | null; // Q####
  source_name: string | null;
  external_id: string | null; // also Q#### in your importer
  burial_address_label: string | null;
  burial_latitude: number | null;
  burial_longitude: number | null;
};

type BurialResult = {
  qid: string;
  burial_label: string | null;
  burial_lat: number | null;
  burial_lon: number | null;
  burial_place_qid: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parsePointWKT(point: string): { lat: number; lon: number } | null {
  // Wikidata returns: "Point(lon lat)"
  const m = point.match(/^Point\(([-\d.]+)\s+([-\d.]+)\)$/i);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function burialSparqlForQids(qids: string[]): string {
  const values = qids.map((q) => `wd:${q}`).join(" ");

  return `
SELECT ?person ?burialPlace ?burialPlaceLabel ?burialCoord WHERE {
  VALUES ?person { ${values} }

  OPTIONAL {
    ?person wdt:P119 ?burialPlace.
    OPTIONAL { ?burialPlace wdt:P625 ?burialCoord. }
  }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`.trim();
}

async function fetchBurialInfoForBatch(qids: string[]): Promise<BurialResult[]> {
  const endpoint = "https://query.wikidata.org/sparql";
  const query = burialSparqlForQids(qids);

  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent": "DeathAtlasBurialEnricher/1.0 (local-script)",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/sparql-results+json",
        },
        body: `format=json&query=${encodeURIComponent(query)}`,
      });

      if (!res.ok) {
        const text = await res.text();
        if ([429, 502, 503, 504].includes(res.status) && attempt < maxAttempts) {
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          console.log(
            `Wikidata ${res.status} — retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw new Error(`Wikidata burial query failed: ${res.status} ${res.statusText}\n${text}`);
      }

      const data = (await res.json()) as any;
      const bindings = (data?.results?.bindings ?? []) as any[];

      const byQid = new Map<string, BurialResult>();

      for (const b of bindings) {
        const personUrl: string | undefined = b.person?.value;
        const qid = personUrl?.match(/\/entity\/(Q\d+)\b/i)?.[1]?.toUpperCase();
        if (!qid) continue;

        const burialPlaceUrl: string | undefined = b.burialPlace?.value;
        const burialPlaceQid =
          burialPlaceUrl?.match(/\/entity\/(Q\d+)\b/i)?.[1]?.toUpperCase() ?? null;

        const burialLabel: string | null = b.burialPlaceLabel?.value ?? null;

        let burialLat: number | null = null;
        let burialLon: number | null = null;

        const coordVal: string | undefined = b.burialCoord?.value;
        if (coordVal) {
          const parsed = parsePointWKT(coordVal);
          if (parsed) {
            burialLat = parsed.lat;
            burialLon = parsed.lon;
          }
        }

        const existing = byQid.get(qid);
        const existingHasCoords = !!(existing?.burial_lat != null && existing?.burial_lon != null);
        const newHasCoords = burialLat != null && burialLon != null;

        if (!existing) {
          byQid.set(qid, {
            qid,
            burial_label: burialLabel,
            burial_lat: burialLat,
            burial_lon: burialLon,
            burial_place_qid: burialPlaceQid,
          });
        } else if (!existingHasCoords && newHasCoords) {
          byQid.set(qid, {
            qid,
            burial_label: burialLabel ?? existing.burial_label,
            burial_lat: burialLat,
            burial_lon: burialLon,
            burial_place_qid: burialPlaceQid ?? existing.burial_place_qid,
          });
        } else if (!existing.burial_label && burialLabel) {
          byQid.set(qid, {
            ...existing,
            burial_label: burialLabel,
            burial_place_qid: burialPlaceQid ?? existing.burial_place_qid,
          });
        }
      }

      // Ensure every requested QID returns a result object (even if empty)
      return qids.map(
        (qid) =>
          byQid.get(qid.toUpperCase()) ?? {
            qid: qid.toUpperCase(),
            burial_label: null,
            burial_lat: null,
            burial_lon: null,
            burial_place_qid: null,
          }
      );
    } catch (err) {
      if (attempt < maxAttempts) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        console.log(
          `Wikidata request error — retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }

  return [];
}

function needsAnyBurialField(r: DeathLocationRow): boolean {
  // row is a candidate if ANY burial fields are missing
  return (
    r.burial_address_label == null ||
    r.burial_latitude == null ||
    r.burial_longitude == null
  );
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  console.log(`Loading up to ${MAX_ROWS} rows that need burial enrichment…`);

  const { data: rows, error } = await supabase
    .from("death_locations")
    .select(
      "id,title,wikidata_id,source_name,external_id,burial_address_label,burial_latitude,burial_longitude"
    )
    .not("wikidata_id", "is", null)
    .or("burial_address_label.is.null,burial_latitude.is.null,burial_longitude.is.null")
    .limit(MAX_ROWS);

  if (error) throw error;

  const need = ((rows ?? []) as DeathLocationRow[]).filter(needsAnyBurialField);
  console.log(`Found ${need.length} candidate rows.`);

  const qids = Array.from(
    new Set(
      need
        .map((r) => r.wikidata_id)
        .filter((x): x is string => !!x && /^Q\d+$/i.test(x))
        .map((x) => x.toUpperCase())
    )
  );

  if (qids.length === 0) {
    console.log("No valid QIDs found to enrich. Done.");
    return;
  }

  // Build index: QID -> rows in your table that need enrichment
  const rowsByQid = new Map<string, DeathLocationRow[]>();
  for (const r of need) {
    const qid = (r.wikidata_id ?? "").toUpperCase();
    if (!/^Q\d+$/.test(qid)) continue;
    const arr = rowsByQid.get(qid) ?? [];
    arr.push(r);
    rowsByQid.set(qid, arr);
  }

  console.log(`Enriching ${qids.length} unique QIDs in batches of ${BATCH_SIZE}…`);

  const batches = chunk(qids, BATCH_SIZE);
  let totalUpdates = 0;
  let totalWithLabel = 0;
  let totalWithCoords = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Batch ${i + 1}/${batches.length}: querying Wikidata…`);

    const results = await fetchBurialInfoForBatch(batch);

    // update counters (QID-level)
    for (const r of results) {
      if (r.burial_label) totalWithLabel++;
      if (r.burial_lat != null && r.burial_lon != null) totalWithCoords++;
    }

    // Build payload (ROW-level). One payload item per death_locations row that should be updated.
    const payload: Partial<DeathLocationRow & { id: string }>[] = [];

    for (const br of results) {
      const targetRows = rowsByQid.get(br.qid) ?? [];
      if (targetRows.length === 0) continue;

      // Only set fields that are present from Wikidata (avoid overwriting with nulls)
      const setLabel = br.burial_label ?? null;
      const setLat = br.burial_lat ?? null;
      const setLon = br.burial_lon ?? null;

      // If Wikidata gave us *nothing*, skip
      const hasAnything = !!setLabel || (setLat != null && setLon != null);
      if (!hasAnything) continue;

      for (const row of targetRows) {
        const update: any = { id: row.id };

        // Only fill missing fields in your DB
        if (row.burial_address_label == null && setLabel) update.burial_address_label = setLabel;
        if (row.burial_latitude == null && setLat != null) update.burial_latitude = setLat;
        if (row.burial_longitude == null && setLon != null) update.burial_longitude = setLon;

        // If this row wouldn’t change, don’t send it
        if (Object.keys(update).length > 1) payload.push(update);
      }
    }

    console.log(`Batch ${i + 1}: upserting ${payload.length} burial updates…`);

    if (payload.length === 0) {
      console.log(`Batch ${i + 1}: nothing to update.`);
      continue;
    }

    // Recommended: update by primary key id
    const { data, error: upsertError } = await supabase
      .from("death_locations")
      .upsert(payload, { onConflict: "id" })
      .select("id");

    if (upsertError) throw upsertError;

    const updatedCount = data?.length ?? 0;
    totalUpdates += updatedCount;
    console.log(`Batch ${i + 1}: updated ${updatedCount} rows.`);
  }

  console.log("Done.");
  console.log(`Total rows updated: ${totalUpdates}`);
  console.log(`QIDs with burial label found (may include null coords): ${totalWithLabel}`);
  console.log(`QIDs with burial coords found: ${totalWithCoords}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
