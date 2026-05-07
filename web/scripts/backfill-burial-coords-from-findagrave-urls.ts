/**
 * Backfill burial_latitude / burial_longitude from existing findagrave_url rows.
 *
 * IMPORTANT:
 * - This only uses URLs already in your DB. It does NOT search Find A Grave.
 * - Many memorial pages show GPS only after JS runs (Show Map). fetch() won't see that.
 * - Find A Grave rate-limits aggressively (HTTP 429). This script is intentionally slow and polite.
 *
 * Usage:
 *   cd C:\death-atlas\web
 *   npx ts-node scripts\backfill-burial-coords-from-findagrave-urls.ts
 *
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (recommended) OR NEXT_PUBLIC_SUPABASE_ANON_KEY (fallback)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type Row = {
  id: string;
  title: string | null;
  wikidata_id: string | null;
  is_published: boolean | null;
  merged_into_id: string | null;

  findagrave_url: string | null;

  burial_latitude: number | null;
  burial_longitude: number | null;
  burial_address_label: string | null;
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function clampLat(lat: number) {
  return lat >= -90 && lat <= 90;
}
function clampLon(lon: number) {
  return lon >= -180 && lon <= 180;
}
function normalizeCoordPair(lat: number, lon: number): { lat: number; lon: number } | null {
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  if (!clampLat(lat) || !clampLon(lon)) return null;
  return { lat, lon };
}

function extractCoordsFromHtml(html: string): { lat: number; lon: number; method: string } | null {
  // A: "latitude": X, "longitude": Y
  {
    const re = /"latitude"\s*:\s*([-\d.]+)\s*,\s*"longitude"\s*:\s*([-\d.]+)/i;
    const m = html.match(re);
    if (m) {
      const ok = normalizeCoordPair(Number(m[1]), Number(m[2]));
      if (ok) return { ...ok, method: "json_lat_long" };
    }
  }

  // B: "lat": X, "lng": Y
  {
    const re = /"lat"\s*:\s*([-\d.]+)\s*,\s*"(?:lng|lon|long)"\s*:\s*([-\d.]+)/i;
    const m = html.match(re);
    if (m) {
      const ok = normalizeCoordPair(Number(m[1]), Number(m[2]));
      if (ok) return { ...ok, method: "json_lat_lng" };
    }
  }

  // C: meta place:location
  {
    const reLat = /property=["']place:location:latitude["']\s+content=["']([-\d.]+)["']/i;
    const reLon = /property=["']place:location:longitude["']\s+content=["']([-\d.]+)["']/i;
    const mLat = html.match(reLat);
    const mLon = html.match(reLon);
    if (mLat && mLon) {
      const ok = normalizeCoordPair(Number(mLat[1]), Number(mLon[1]));
      if (ok) return { ...ok, method: "meta_place_location" };
    }
  }

  // D: data-lat / data-lng
  {
    const re = /data-lat=["']([-\d.]+)["'][^>]*data-(?:lng|lon|long)=["']([-\d.]+)["']/i;
    const m = html.match(re);
    if (m) {
      const ok = normalizeCoordPair(Number(m[1]), Number(m[2]));
      if (ok) return { ...ok, method: "data_lat_lng" };
    }
  }

  // E: visible text "GPS-Latitude: X, Longitude: Y"
  {
    const re = /GPS-?Latitude:\s*([-\d.]+)[^\d-]+Longitude:\s*([-\d.]+)/i;
    const m = html.match(re);
    if (m) {
      const ok = normalizeCoordPair(Number(m[1]), Number(m[2]));
      if (ok) return { ...ok, method: "gps_text" };
    }
  }

  return null;
}

function extractCemeteryLabel(html: string): string | null {
  const m1 = html.match(/>\s*BURIAL\s*<[\s\S]*?>\s*([^<]{3,120})\s*</i);
  if (m1) return m1[1].trim();

  const m2 = html.match(/>\s*Cemetery\s*<[\s\S]*?>\s*([^<]{3,120})\s*</i);
  if (m2) return m2[1].trim();

  return null;
}

async function fetchHtmlWithBackoff(url: string): Promise<string> {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "DeathAtlas/1.0 (personal research project)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    if (res.status === 429) {
      // Backoff grows each attempt, with jitter
      const waitSec = Math.min(600, 60 * attempt) + randInt(0, 30); // 60s,120s,180s... capped at 10 min
      console.log(`⏳ 429 rate-limited. Waiting ${waitSec}s then retrying... (${attempt}/${maxAttempts})`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${text.slice(0, 200)}`);
    }

    return await res.text();
  }

  throw new Error(`HTTP 429 persisted after retries for ${url}`);
}

async function main() {
  const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabase = createClient(supabaseUrl, key);

  // Tune these:
  const perRequestDelayMsMin = 4000; // 4s
  const perRequestDelayMsMax = 8000; // 8s
  const maxToAttemptThisRun = 40;     // stop after N memorials per run (prevents bans)

  console.log("Backfill burial coords from findagrave_url (published only, polite mode)");
  console.log("Supabase:", supabaseUrl);
  console.log("Auth key:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "SERVICE_ROLE" : "ANON (fallback)");
  console.log(`Rate: ${perRequestDelayMsMin}-${perRequestDelayMsMax}ms between requests, max ${maxToAttemptThisRun} per run`);

  const pageSize = 100;
  let from = 0;

  let scanned = 0;
  let attempted = 0;
  let updated = 0;
  let skippedNoCoords = 0;
  let skippedErrors = 0;

  outer: while (true) {
    const { data, error } = await supabase
      .from("death_locations")
      .select(
        "id,title,wikidata_id,is_published,merged_into_id,findagrave_url,burial_latitude,burial_longitude,burial_address_label"
      )
      .eq("is_published", true)
      .is("merged_into_id", null)
      .not("findagrave_url", "is", null)
      .is("burial_latitude", null)
      .is("burial_longitude", null)
      .range(from, from + pageSize - 1);

    if (error) throw error;
    const rows = (data || []) as Row[];
    if (rows.length === 0) break;

    scanned += rows.length;

    for (const row of rows) {
      if (attempted >= maxToAttemptThisRun) {
        console.log(`🛑 Reached maxToAttemptThisRun=${maxToAttemptThisRun}. Stop now; run again later.`);
        break outer;
      }

      const url = row.findagrave_url!;
      attempted += 1;

      // Polite pacing (randomized)
      await sleep(randInt(perRequestDelayMsMin, perRequestDelayMsMax));

      try {
        const html = await fetchHtmlWithBackoff(url);
        const coords = extractCoordsFromHtml(html);

        if (!coords) {
          skippedNoCoords += 1;
          console.log(`— no coords | ${row.title ?? row.id} | ${url}`);
          continue;
        }

        const patch: Partial<Row> = {
          burial_latitude: coords.lat,
          burial_longitude: coords.lon,
        };

        if (!row.burial_address_label) {
          const label = extractCemeteryLabel(html);
          if (label) patch.burial_address_label = label;
        }

        const { error: upErr } = await supabase.from("death_locations").update(patch).eq("id", row.id);

        if (upErr) {
          skippedErrors += 1;
          console.log(`❌ update failed | ${row.title ?? row.id} | ${upErr.message}`);
          continue;
        }

        updated += 1;
        console.log(`✅ coords(${coords.method}) | ${row.title ?? row.id} | ${coords.lat}, ${coords.lon}`);
      } catch (e: any) {
        skippedErrors += 1;
        console.log(`❌ fetch/parse error | ${row.title ?? row.id} | ${url} | ${e?.message ?? String(e)}`);
      }
    }

    from += pageSize;
  }

  console.log(
    `Done. Scanned=${scanned} Attempted=${attempted} Updated=${updated} NoCoords=${skippedNoCoords} Errors=${skippedErrors}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
