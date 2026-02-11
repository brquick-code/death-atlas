import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/death-same-spot?id=<uuid>&eps=0.00008
 * Returns all published entries whose display coordinate matches the given entry,
 * within eps degrees (~9m at equator; smaller in practice).
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

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const eps = Math.max(0.000001, Math.min(toNumber(searchParams.get("eps")) ?? 0.00002, 0.001));
    // default eps=0.00002 ~ 2m-ish latitude

    // 1) load the base row coords
    const { data: base, error: e1 } = await supabase
      .from("death_locations")
      .select("id, death_latitude, death_longitude, burial_latitude, burial_longitude")
      .eq("id", id)
      .eq("is_published", true)
      .not("is_hidden", "is", true)
      .maybeSingle();

    if (e1) return NextResponse.json({ error: e1.message, details: e1.details ?? null }, { status: 500 });
    if (!base) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const lat = (base as any).death_latitude ?? (base as any).burial_latitude ?? null;
    const lng = (base as any).death_longitude ?? (base as any).burial_longitude ?? null;

    if (lat == null || lng == null) {
      return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });
    }

    const minLat = lat - eps;
    const maxLat = lat + eps;
    const minLng = lng - eps;
    const maxLng = lng + eps;

    // 2) find rows with display coords within eps box
    // (We filter death coords OR burial coords; then in JS we compute display coords match)
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
      .not("is_hidden", "is", true)
      .or(
        `and(death_latitude.gte.${minLat},death_latitude.lte.${maxLat},death_longitude.gte.${minLng},death_longitude.lte.${maxLng}),` +
          `and(burial_latitude.gte.${minLat},burial_latitude.lte.${maxLat},burial_longitude.gte.${minLng},burial_longitude.lte.${maxLng})`
      )
      .limit(200);

    if (error) {
      return NextResponse.json({ error: error.message, details: error.details ?? null }, { status: 500 });
    }

    const rows = (data ?? []).map((r: any) => {
      const rLat = r.death_latitude ?? r.burial_latitude ?? null;
      const rLng = r.death_longitude ?? r.burial_longitude ?? null;
      return { ...r, lat: rLat, lng: rLng };
    });

    // 3) exact-ish match within eps
    const same = rows.filter((r: any) => {
      if (r.lat == null || r.lng == null) return false;
      return Math.abs(r.lat - lat) <= eps && Math.abs(r.lng - lng) <= eps;
    });

    return NextResponse.json(same, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Unhandled error in death-same-spot route", message: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
