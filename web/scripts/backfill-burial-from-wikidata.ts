/**
 * backfill-burial-from-wikidata.ts
 *
 * Wikidata-first burial enrichment (cemetery-level coords OK), Find A Grave as fallback.
 *
 * What it attempts to fill (only if the columns exist in your table):
 * - burial_latitude / burial_longitude
 * - burial_place_name
 * - burial_place_wikidata_id
 * - burial_wikidata_id
 * - burial_source_url
 * - findagrave_memorial_id
 * - findagrave_url
 * - source_urls[] (append helpful links, deduped)
 *
 * How it decides which rows to process:
 * - is_published = true
 * - missing burial coords (burial_latitude or burial_longitude null)
 * - has some kind of Wikidata QID in one of: wikidata_id, wikidata_qid, person_qid, wikidata_entity_id, wd_id
 *
 * Run (PowerShell):
 *   cd C:\death-atlas\web
 *   npx ts-node scripts\backfill-burial-from-wikidata.ts
 *
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing env vars. Need NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

// Tune these if needed
const PAGE_SIZE = 150;
const MAX_UPDATES_PER_RUN = 5000;
const WIKIDATA_DELAY_MS = 250;
const FINDAGRAVE_DELAY_MS = 350;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normQid(value: any): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/(Q\d+)/i);
  if (!m) return null;
  return m[1].toUpperCase();
}

function dedupeUrls(urls: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    const s = String(u).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function wikidataEntityUrl(qid: string) {
  return `https://www.wikidata.org/wiki/${qid}`;
}

function findagraveMemorialUrl(memorialId: string) {
  return `https://www.findagrave.com/memorial/${encodeURIComponent(memorialId)}`;
}

function isMissingBurialCoords(r: any): boolean {
  const lat = r?.burial_latitude;
  const lng = r?.burial_longitude;
  return lat == null || lng == null;
}

function pickPersonQid(r: any): string | null {
  // Try multiple possible column names without requiring any one schema.
  const candidates = [
    r?.wikidata_qid,
    r?.wikidata_id,
    r?.person_qid,
    r?.wikidata_entity_id,
    r?.wd_id,
    r?.qid,
  ];
  for (const c of candidates) {
    const q = normQid(c);
    if (q) return q;
  }
  return null;
}

type WikidataResult = {
  personQid: string;
  burialPlaceQid?: string;
  burialPlaceLabel?: string;
  burialLat?: number;
  burialLng?: number;
  findagraveMemorialId?: string;
};

async function wikidataLookup(personQid: string): Promise<WikidataResult | null> {
  // P119 = place of burial
  // P625 = coordinate location (on the burial place item)
  // P535 = Find a Grave memorial ID (on the person item)

  const query = `
SELECT ?burialPlace ?burialPlaceLabel ?coord ?findagraveId WHERE {
  VALUES ?person { wd:${personQid} }

  OPTIONAL {
    ?person wdt:P119 ?burialPlace .
    OPTIONAL { ?burialPlace wdt:P625 ?coord . }
  }

  OPTIONAL { ?person wdt:P535 ?findagraveId . }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 5
`.trim();

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "DeathAtlas/1.0 (burial backfill; wikidata sparql)",
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`Wikidata failed for ${personQid}: ${res.status} ${txt}`.trim());
    return null;
  }

  const json: any = await res.json();
  const bindings: any[] = json?.results?.bindings ?? [];
  if (!bindings.length) return { personQid };

  const b = bindings.find((x) => x?.burialPlace?.value) ?? bindings[0];

  const burialPlaceUrl = b?.burialPlace?.value
    ? String(b.burialPlace.value)
    : undefined;

  const burialPlaceQid = burialPlaceUrl
    ? (normQid(burialPlaceUrl) ?? undefined)
    : undefined;

  const burialPlaceLabel = b?.burialPlaceLabel?.value
    ? String(b.burialPlaceLabel.value)
    : undefined;

  const coord = b?.coord?.value ? String(b.coord.value) : undefined;

  let burialLat: number | undefined;
  let burialLng: number | undefined;

  // coord comes like: "Point(-80.123 35.456)" (lng lat)
  if (coord) {
    const m = coord.match(/Point\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/);
    if (m) {
      const lng = Number(m[1]);
      const lat = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        burialLat = lat;
        burialLng = lng;
      }
    }
  }

  const findagraveMemorialId = b?.findagraveId?.value
    ? String(b.findagraveId.value).trim()
    : undefined;

  return {
    personQid,
    burialPlaceQid,
    burialPlaceLabel,
    burialLat,
    burialLng,
    findagraveMemorialId,
  };
}

/**
 * Best-effort Find A Grave memorial page parsing for coordinates.
 * Many pages won't expose usable coords; that's OK.
 */
async function tryFindagraveCoords(memorialUrl: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(memorialUrl, {
      headers: {
        "User-Agent": "DeathAtlas/1.0 (burial backfill; findagrave fallback)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Common embedded JSON patterns:
    const m1 = html.match(/"latitude"\s*:\s*([-\d.]+)\s*,\s*"longitude"\s*:\s*([-\d.]+)/i);
    if (m1) {
      const lat = Number(m1[1]);
      const lng = Number(m1[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }

    const m2 = html.match(/"lat"\s*:\s*([-\d.]+)\s*,\s*"lng"\s*:\s*([-\d.]+)/i);
    if (m2) {
      const lat = Number(m2[1]);
      const lng = Number(m2[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }

    return null;
  } catch {
    return null;
  }
}

function hasColumn(r: any, col: string): boolean {
  return r && Object.prototype.hasOwnProperty.call(r, col);
}

async function fetchPage(afterId: string | null): Promise<any[]> {
  let q = supabase
    .from("death_locations")
    .select("*")
    .eq("is_published", true)
    .order("id", { ascending: true })
    .limit(PAGE_SIZE);

  if (afterId) q = q.gt("id", afterId);

  const { data, error } = await q;

  if (error) throw error;
  return (data ?? []) as any[];
}

async function updateRow(id: string, patch: Record<string, any>) {
  const { error } = await supabase.from("death_locations").update(patch).eq("id", id);
  if (error) throw error;
}

async function main() {
  console.log("Burial backfill (Wikidata → Find A Grave fallback)");
  console.log("Supabase:", SUPABASE_URL);

  let afterId: string | null = null;
  let scanned = 0;
  let updated = 0;

  while (updated < MAX_UPDATES_PER_RUN) {
    const rows = await fetchPage(afterId);
    if (!rows.length) break;

    for (const r of rows) {
      afterId = r.id;
      scanned++;

      // Must be missing burial coords
      if (!isMissingBurialCoords(r)) continue;

      // Must have some person QID
      const personQid = pickPersonQid(r);
      if (!personQid) continue;

      await sleep(WIKIDATA_DELAY_MS);

      const wd = await wikidataLookup(personQid);
      if (!wd) continue;

      const patch: Record<string, any> = {};

      // Fill burial place IDs + name
      if (wd.burialPlaceQid) {
        if (hasColumn(r, "burial_place_wikidata_id") && !r.burial_place_wikidata_id) {
          patch.burial_place_wikidata_id = wd.burialPlaceQid;
        }
        if (hasColumn(r, "burial_wikidata_id") && !r.burial_wikidata_id) {
          patch.burial_wikidata_id = wd.burialPlaceQid;
        }
        if (hasColumn(r, "burial_place_name") && (!r.burial_place_name || !String(r.burial_place_name).trim())) {
          if (wd.burialPlaceLabel) patch.burial_place_name = wd.burialPlaceLabel;
        }
        if (hasColumn(r, "burial_source_url") && (!r.burial_source_url || !String(r.burial_source_url).trim())) {
          patch.burial_source_url = wikidataEntityUrl(wd.burialPlaceQid);
        }
      }

      // Fill burial coords from Wikidata (cemetery coords)
      if (wd.burialLat != null && wd.burialLng != null) {
        if (hasColumn(r, "burial_latitude") && r.burial_latitude == null) patch.burial_latitude = wd.burialLat;
        if (hasColumn(r, "burial_longitude") && r.burial_longitude == null) patch.burial_longitude = wd.burialLng;
      }

      // Find A Grave from Wikidata P535
      if (wd.findagraveMemorialId) {
        if (hasColumn(r, "findagrave_memorial_id") && (!r.findagrave_memorial_id || !String(r.findagrave_memorial_id).trim())) {
          patch.findagrave_memorial_id = wd.findagraveMemorialId;
        }
        if (hasColumn(r, "findagrave_url") && (!r.findagrave_url || !String(r.findagrave_url).trim())) {
          patch.findagrave_url = findagraveMemorialUrl(wd.findagraveMemorialId);
        }
      }

      // Fallback: if still missing coords, try Find A Grave coords (best-effort, not required)
      const effectiveFgUrl =
        (patch.findagrave_url as string | undefined) ||
        (typeof r.findagrave_url === "string" ? r.findagrave_url : null) ||
        (typeof r.findagrave_memorial_id === "string" && r.findagrave_memorial_id.trim()
          ? findagraveMemorialUrl(r.findagrave_memorial_id.trim())
          : null);

      const stillMissing =
        (hasColumn(r, "burial_latitude") && (patch.burial_latitude == null && r.burial_latitude == null)) ||
        (hasColumn(r, "burial_longitude") && (patch.burial_longitude == null && r.burial_longitude == null));

      if (stillMissing && effectiveFgUrl) {
        await sleep(FINDAGRAVE_DELAY_MS);
        const fg = await tryFindagraveCoords(effectiveFgUrl);
        if (fg) {
          if (hasColumn(r, "burial_latitude") && r.burial_latitude == null) patch.burial_latitude = fg.lat;
          if (hasColumn(r, "burial_longitude") && r.burial_longitude == null) patch.burial_longitude = fg.lng;

          if (hasColumn(r, "burial_source_url") && (!r.burial_source_url || !String(r.burial_source_url).trim())) {
            patch.burial_source_url = effectiveFgUrl;
          }
        } else {
          // even if no coords, set burial_source_url to Find A Grave when no other burial source exists
          if (hasColumn(r, "burial_source_url") && (!r.burial_source_url || !String(r.burial_source_url).trim())) {
            patch.burial_source_url = effectiveFgUrl;
          }
        }
      }

      // Append links into source_urls[] so the app shows them under "More links"
      if (hasColumn(r, "source_urls")) {
        const existing: string[] = Array.isArray(r.source_urls) ? r.source_urls : [];
        const add: string[] = [];

        if (wd.burialPlaceQid) add.push(wikidataEntityUrl(wd.burialPlaceQid));
        if (patch.findagrave_url) add.push(String(patch.findagrave_url));
        if (effectiveFgUrl) add.push(String(effectiveFgUrl));
        if (patch.burial_source_url) add.push(String(patch.burial_source_url));

        const merged = dedupeUrls([...existing, ...add]);
        if (merged.length && JSON.stringify(merged) !== JSON.stringify(existing)) {
          patch.source_urls = merged;
        }
      }

      if (!Object.keys(patch).length) continue;

      try {
        await updateRow(r.id, patch);
        updated++;
        console.log(
          `✅ ${updated} | ${r.title ?? r.id} | QID=${personQid}` +
            (patch.burial_latitude != null ? " | burial coords" : "") +
            (patch.findagrave_url ? " | findagrave" : "") +
            (patch.burial_place_wikidata_id ? " | burial place QID" : "")
        );
      } catch (e: any) {
        console.warn(`⚠️ Update failed for ${r.title ?? r.id}: ${e?.message ?? e}`);
      }

      if (updated >= MAX_UPDATES_PER_RUN) break;
    }
  }

  console.log(`Done. Scanned=${scanned} Updated=${updated}`);
}

main().catch((e) => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});
