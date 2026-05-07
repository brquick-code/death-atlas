// web/app/api/death-near/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function num(sp: URLSearchParams, k: string) {
  const v = sp.get(k);
  const x = v == null ? NaN : Number(v);
  return Number.isFinite(x) ? x : null;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

// Haversine distance (km)
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

type Row = {
  id: string;
  title: string | null;
  category?: string | null;
  death_type?: string | null;
  death_date?: string | null;

  death_latitude: number | null;
  death_longitude: number | null;
  address_label?: string | null;

  wikipedia_url?: string | null;
  source_name?: string | null;
  source_url?: string | null;
  source_urls?: string[] | null;

  is_published?: boolean | null;
  is_hidden?: boolean | null;

  created_at?: string | null;
  updated_at?: string | null;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const lat = num(searchParams, "lat");
    const lng = num(searchParams, "lng");
    if (lat == null || lng == null) {
      return NextResponse.json({ error: "Missing lat/lng" }, { status: 400 });
    }

    const radiusKm = clamp(Number(searchParams.get("radiusKm")) || 50, 1, 500);
    const limit = clamp(Number(searchParams.get("limit")) || 200, 1, 2000);

    // Rough bounding box for initial DB filter
    const latDelta = radiusKm / 111; // ~111km per degree latitude
    const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1);

    const south = lat - latDelta;
    const north = lat + latDelta;
    const west = lng - lngDelta;
    const east = lng + lngDelta;

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("death_locations")
      .select(
        `
        id,
        title,
        category,
        death_type,
        death_date,
        death_latitude,
        death_longitude,
        address_label,
        wikipedia_url,
        source_name,
        source_url,
        source_urls,
        is_published,
        is_hidden,
        created_at,
        updated_at
      `
      )
      .eq("is_published", true)
      .neq("is_hidden", true)
      .not("death_latitude", "is", null)
      .not("death_longitude", "is", null)
      .gte("death_latitude", south)
      .lte("death_latitude", north)
      .gte("death_longitude", west)
      .lte("death_longitude", east)
      .limit(limit);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ✅ Type-safe: only treat as array when it is an array
    const rowsIn: Row[] = Array.isArray(data) ? (data as Row[]) : [];

    const rows = rowsIn
      .map((r) => {
        const d =
          r.death_latitude == null || r.death_longitude == null
            ? Number.POSITIVE_INFINITY
            : haversineKm(lat, lng, r.death_latitude, r.death_longitude);

        return {
          ...r,
          name: r.title ?? null, // legacy compatibility
          latitude: r.death_latitude ?? null,
          longitude: r.death_longitude ?? null,
          place_name: r.address_label ?? null,
          distance_km: Number.isFinite(d) ? d : null,
        };
      })
      .filter((r) => r.distance_km != null && r.distance_km <= radiusKm)
      .sort((a, b) => (a.distance_km! - b.distance_km!))
      .slice(0, limit);

    return NextResponse.json(rows, { status: 200 });
  } catch (e: any) {
    console.error("[/api/death-near] crash:", e);
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}