import { supabase } from "./supabase";
import { haversineMeters } from "./geo";

export type DeathRow = {
  id: string;
  title: string | null;
  death_date: string | null;
  date_start: string | null;
  date_end: string | null;
  confidence: string | null;
  coord_source: string | null;

  wikipedia_url: string | null;
  source_url: string | null;
  source_urls: string[] | null;

  pageviews_365d: number | null;
  is_celebrity: boolean | null;

  death_latitude: number | null;
  death_longitude: number | null;
  burial_latitude: number | null;
  burial_longitude: number | null;

  is_published: boolean | null;
  is_hidden: boolean | null;
};

export type MapPoint = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  // used for same-spot grouping
  key: string;
};

function displayLatLng(r: DeathRow): { lat: number | null; lng: number | null; coord_source: "death" | "burial" | null } {
  if (typeof r.death_latitude === "number" && typeof r.death_longitude === "number") {
    return { lat: r.death_latitude, lng: r.death_longitude, coord_source: "death" };
  }
  if (typeof r.burial_latitude === "number" && typeof r.burial_longitude === "number") {
    return { lat: r.burial_latitude, lng: r.burial_longitude, coord_source: "burial" };
  }
  return { lat: null, lng: null, coord_source: null };
}

// Round for “same spot” grouping; adjust decimals to taste
function sameSpotKey(lat: number, lng: number) {
  const r = (v: number) => Math.round(v * 100000) / 100000; // ~1m-ish lat precision
  return `${r(lat)},${r(lng)}`;
}

export async function fetchPointsInBounds(bounds: {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  limit?: number;
}) {
  const limit = Math.max(100, Math.min(bounds.limit ?? 1500, 5000));

  const { data, error } = await supabase
    .from("death_locations")
    .select(
      [
        "id",
        "title",
        "death_latitude",
        "death_longitude",
        "burial_latitude",
        "burial_longitude",
        "is_published",
        "is_hidden",
      ].join(",")
    )
    .eq("is_published", true)
    .eq("is_hidden", false)
    .or(
      // allow rows that have either death coords or burial coords; we’ll display whichever exists
      `and(death_latitude.not.is.null,death_longitude.not.is.null),and(burial_latitude.not.is.null,burial_longitude.not.is.null)`
    )
    .limit(limit);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as DeathRow[];

  // Filter client-side by viewport because we selected broadly above.
  // (You can optimize later with a PostGIS RPC; this is good enough for prototype.)
  const pts: MapPoint[] = [];
  for (const r of rows) {
    const d = displayLatLng(r);
    if (d.lat == null || d.lng == null) continue;
    if (d.lat < bounds.minLat || d.lat > bounds.maxLat) continue;
    if (d.lng < bounds.minLng || d.lng > bounds.maxLng) continue;

    pts.push({
      id: r.id,
      title: r.title ?? "Unknown",
      lat: d.lat,
      lng: d.lng,
      key: sameSpotKey(d.lat, d.lng),
    });
  }

  return pts;
}

export async function fetchOne(id: string) {
  const { data, error } = await supabase
    .from("death_locations")
    .select(
      [
        "id",
        "title",
        "death_date",
        "date_start",
        "date_end",
        "confidence",
        "coord_source",
        "wikipedia_url",
        "source_url",
        "source_urls",
        "pageviews_365d",
        "is_celebrity",
        "death_latitude",
        "death_longitude",
        "burial_latitude",
        "burial_longitude",
      ].join(",")
    )
    .eq("id", id)
    .eq("is_published", true)
    .eq("is_hidden", false)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as DeathRow;
  const d = displayLatLng(row);

  return {
    ...row,
    lat: d.lat,
    lng: d.lng,
  };
}

export async function fetchSameSpotList(anchor: { lat: number; lng: number }, radiusM = 8, limit = 80) {
  // Pull a reasonable bounding box around the anchor and then exact-filter in JS.
  const metersPerDegLat = 111_320;
  const dLat = radiusM / metersPerDegLat;
  const cos = Math.cos((anchor.lat * Math.PI) / 180);
  const metersPerDegLng = metersPerDegLat * Math.max(0.15, cos);
  const dLng = radiusM / metersPerDegLng;

  const minLat = anchor.lat - dLat;
  const maxLat = anchor.lat + dLat;
  const minLng = anchor.lng - dLng;
  const maxLng = anchor.lng + dLng;

  const { data, error } = await supabase
    .from("death_locations")
    .select(
      [
        "id",
        "title",
        "death_date",
        "date_start",
        "date_end",
        "confidence",
        "coord_source",
        "wikipedia_url",
        "source_url",
        "source_urls",
        "pageviews_365d",
        "is_celebrity",
        "death_latitude",
        "death_longitude",
        "burial_latitude",
        "burial_longitude",
      ].join(",")
    )
    .eq("is_published", true)
    .eq("is_hidden", false)
    .or(
      `and(death_latitude.gte.${minLat},death_latitude.lte.${maxLat},death_longitude.gte.${minLng},death_longitude.lte.${maxLng}),and(burial_latitude.gte.${minLat},burial_latitude.lte.${maxLat},burial_longitude.gte.${minLng},burial_longitude.lte.${maxLng})`
    )
    .limit(limit);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as DeathRow[];

  const candidates = rows
    .map((r) => {
      const d = displayLatLng(r);
      if (d.lat == null || d.lng == null) return null;
      const dist = haversineMeters(anchor.lat, anchor.lng, d.lat, d.lng);
      return {
        id: r.id,
        title: r.title ?? "Unknown",
        wikipedia_url: r.wikipedia_url ?? null,
        source_url: r.source_url ?? null,
        source_urls: Array.isArray(r.source_urls) ? r.source_urls : null,
        death_date: r.death_date ?? null,
        date_start: r.date_start ?? null,
        date_end: r.date_end ?? null,
        confidence: r.confidence ?? null,
        coord_source: r.coord_source ?? null,
        pageviews_365d: r.pageviews_365d ?? null,
        is_celebrity: r.is_celebrity ?? null,
        lat: d.lat,
        lng: d.lng,
        _dist: dist,
      };
    })
    .filter(Boolean) as any[];

  // “Same spot” means extremely close; sort nearest first; keep all within radiusM
  candidates.sort((a, b) => a._dist - b._dist);
  return candidates.filter((x) => x._dist <= radiusM).map(({ _dist, ...rest }) => rest);
}
