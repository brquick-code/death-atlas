import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/death-near?lat=&lng=&radiusM=&limit=
 * Returns nearest published entries near a point (death coords preferred, else burial).
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false } }
);

function toNumber(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

type Row = {
  id: string;
  title: string | null;

  death_date: string | null;
  date_start: string | null;
  date_end: string | null;

  confidence: string | null;
  coord_source: string | null;

  death_latitude: number | null;
  death_longitude: number | null;
  burial_latitude: number | null;
  burial_longitude: number | null;

  wikipedia_url: string | null;
  source_url: string | null;
  source_urls: string[] | null;

  pageviews_365d: number | null;
  is_celebrity: boolean | null;
};

function pickCoords(r: Row): { lat: number; lng: number; coord_kind: "death" | "burial" } | null {
  if (r.death_latitude != null && r.death_longitude != null) {
    return { lat: Number(r.death_latitude), lng: Number(r.death_longitude), coord_kind: "death" };
  }
  if (r.burial_latitude != null && r.burial_longitude != null) {
    return { lat: Number(r.burial_latitude), lng: Number(r.burial_longitude), coord_kind: "burial" };
  }
  return null;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const lat = toNumber(searchParams.get("lat"));
    const lng = toNumber(searchParams.get("lng"));
    const radiusMRaw = toNumber(searchParams.get("radiusM"));
    const limitRaw = toNumber(searchParams.get("limit"));

    if (lat == null || lng == null) {
      return NextResponse.json({ error: "Missing lat/lng" }, { status: 400 });
    }

    const radiusM = clamp(Math.round(radiusMRaw ?? 1500), 10, 250000);
    const limit = clamp(Math.round(limitRaw ?? 12), 1, 80);

    // bbox prefilter
    const metersPerDegLat = 111_320;
    const deltaLat = radiusM / metersPerDegLat;
    const cos = Math.cos((lat * Math.PI) / 180);
    const metersPerDegLng = metersPerDegLat * Math.max(0.15, cos);
    const deltaLng = radiusM / metersPerDegLng;

    const minLat = lat - deltaLat;
    const maxLat = lat + deltaLat;
    const minLng = lng - deltaLng;
    const maxLng = lng + deltaLng;

    const candidateLimit = clamp(limit * 25, 80, 2000);

    const bboxDeath = `and(death_latitude.gte.${minLat},death_latitude.lte.${maxLat},death_longitude.gte.${minLng},death_longitude.lte.${maxLng})`;
    const bboxBurial = `and(burial_latitude.gte.${minLat},burial_latitude.lte.${maxLat},burial_longitude.gte.${minLng},burial_longitude.lte.${maxLng})`;

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
          "death_latitude",
          "death_longitude",
          "burial_latitude",
          "burial_longitude",
          "wikipedia_url",
          "source_url",
          "source_urls",
          "pageviews_365d",
          "is_celebrity",
        ].join(",")
      )
      .eq("is_published", true)
      .not("is_hidden", "is", true) // allow false OR NULL
      .or(`${bboxDeath},${bboxBurial}`)
      .limit(candidateLimit);

    if (error) {
      return NextResponse.json({ error: error.message, details: error.details ?? null }, { status: 500 });
    }

    const rowsIn = (data ?? []) as Row[];

    const rows = rowsIn
      .map((r) => {
        const c = pickCoords(r);
        if (!c) return null;

        const dist = haversineMeters(lat, lng, c.lat, c.lng);

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

          lat: Number.isFinite(c.lat) ? c.lat : null,
          lng: Number.isFinite(c.lng) ? c.lng : null,
          coord_kind: c.coord_kind,

          _dist: dist,
          _pv: typeof r.pageviews_365d === "number" ? r.pageviews_365d : 0,
          _celebrity: r.is_celebrity ? 1 : 0,
        };
      })
      .filter(Boolean) as any[];

    const filtered = rows.filter((r) => Number.isFinite(r._dist) && r._dist <= radiusM);

    filtered.sort((a, b) => {
      if (a._dist !== b._dist) return a._dist - b._dist;
      if (a._celebrity !== b._celebrity) return b._celebrity - a._celebrity;
      if (a._pv !== b._pv) return b._pv - a._pv;
      return String(a.title).localeCompare(String(b.title));
    });

    const out = filtered.slice(0, limit).map(({ _dist, _pv, _celebrity, ...rest }) => rest);

    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Unhandled error in death-near route", message: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
