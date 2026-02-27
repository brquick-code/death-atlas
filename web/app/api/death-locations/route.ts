// web/app/api/death-locations/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function n(sp: URLSearchParams, k: string, fallback: number) {
  const v = sp.get(k);
  const x = v == null ? NaN : Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

type Mode = "death" | "burial" | "missing";

function parseBool(v: string | null | undefined): boolean | undefined {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(s)) return false;
  return undefined;
}

function safeStr(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function safeNum(v: any): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const modeRaw = (searchParams.get("mode") || searchParams.get("coord") || "death").toLowerCase();
    const mode = (["death", "burial", "missing"].includes(modeRaw) ? (modeRaw as Mode) : "death") as Mode;

    const sort = (searchParams.get("sort") || "").toLowerCase();
    const limit = clamp(Number(searchParams.get("limit")) || 2000, 1, 5000);

    // support both param styles
    const west = n(searchParams, "west", n(searchParams, "minLng", -180));
    const east = n(searchParams, "east", n(searchParams, "maxLng", 180));
    const south = n(searchParams, "south", n(searchParams, "minLat", -90));
    const north = n(searchParams, "north", n(searchParams, "maxLat", 90));

    const published = parseBool(searchParams.get("published"));
    const includeHidden = parseBool(searchParams.get("include_hidden"));

    const supabase = getSupabase();

    let query = supabase
      .from("death_locations")
      .select(
        `
        id,
        title,
        category,
        death_type,
        death_date,
        coord_source,

        death_latitude,
        death_longitude,
        address_label,

        burial_latitude,
        burial_longitude,
        burial_place_name,
        cemetery_name,
        cemetery_latitude,
        cemetery_longitude,

        missing_latitude,
        missing_longitude,
        missing_place_name,
        missing_date,
        missing_status,

        wikipedia_url,
        source_name,
        source_url,
        source_urls,

        is_published,
        is_hidden,
        created_at,
        updated_at
      `
      );

    // default: published only
    if (published === false) query = query.eq("is_published", false);
    else query = query.eq("is_published", true);

    if (!includeHidden) query = query.neq("is_hidden", true);

    // bbox filter depends on mode
    if (mode === "burial") {
      query = query
        .not("burial_latitude", "is", null)
        .not("burial_longitude", "is", null)
        .gte("burial_latitude", south)
        .lte("burial_latitude", north)
        .gte("burial_longitude", west)
        .lte("burial_longitude", east);
    } else if (mode === "missing") {
      query = query
        .not("missing_latitude", "is", null)
        .not("missing_longitude", "is", null)
        .gte("missing_latitude", south)
        .lte("missing_latitude", north)
        .gte("missing_longitude", west)
        .lte("missing_longitude", east);
    } else {
      query = query
        .not("death_latitude", "is", null)
        .not("death_longitude", "is", null)
        .gte("death_latitude", south)
        .lte("death_latitude", north)
        .gte("death_longitude", west)
        .lte("death_longitude", east);
    }

    if (sort === "newest") query = query.order("created_at", { ascending: false });

    query = query.limit(limit);

    const { data, error } = await query;

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = Array.isArray(data) ? data : [];

    // 🔥 IMPORTANT:
    // Always return lat/lng + coord_kind so mobile can never “guess” wrong.
    const normalized = rows.map((row: any) => {
      let lat: number | null = null;
      let lng: number | null = null;
      let place_name: string | null = null;

      if (mode === "burial") {
        lat = safeNum(row.burial_latitude);
        lng = safeNum(row.burial_longitude);
        place_name = safeStr(row.burial_place_name) ?? safeStr(row.cemetery_name) ?? null;
      } else if (mode === "missing") {
        lat = safeNum(row.missing_latitude);
        lng = safeNum(row.missing_longitude);
        place_name = safeStr(row.missing_place_name) ?? null;
      } else {
        lat = safeNum(row.death_latitude);
        lng = safeNum(row.death_longitude);
        place_name = safeStr(row.address_label) ?? null;
      }

      const title = safeStr(row.title);

      return {
        id: row.id,
        title,
        name: title, // legacy for clients expecting "name"

        // ✅ canonical coordinates for the requested mode
        lat,
        lng,
        coord_kind: mode,

        // ✅ legacy fields some clients still use
        latitude: lat,
        longitude: lng,
        place_name,

        category: row.category ?? row.death_type ?? null,

        // NOTE: if this is timestamptz, the client may shift a day when parsing.
        // We'll fix /api/search next if needed to ensure YYYY-MM-DD only.
        death_date: row.death_date ?? null,

        coord_source: row.coord_source ?? null,

        wikipedia_url: row.wikipedia_url ?? null,
        source_name: row.source_name ?? null,
        source_url: row.source_url ?? null,
        source_urls: row.source_urls ?? null,

        death_latitude: row.death_latitude ?? null,
        death_longitude: row.death_longitude ?? null,

        burial_latitude: row.burial_latitude ?? null,
        burial_longitude: row.burial_longitude ?? null,
        burial_place_name: safeStr(row.burial_place_name) ?? safeStr(row.cemetery_name) ?? null,

        cemetery_name: row.cemetery_name ?? null,
        cemetery_latitude: row.cemetery_latitude ?? null,
        cemetery_longitude: row.cemetery_longitude ?? null,

        missing_latitude: row.missing_latitude ?? null,
        missing_longitude: row.missing_longitude ?? null,
        missing_place_name: row.missing_place_name ?? null,
        missing_date: row.missing_date ?? null,
        missing_status: row.missing_status ?? null,

        is_published: row.is_published ?? null,
        is_hidden: row.is_hidden ?? null,
        created_at: row.created_at ?? null,
        updated_at: row.updated_at ?? null,
      };
    });

    return NextResponse.json(normalized, { status: 200 });
  } catch (e: any) {
    console.error("[/api/death-locations] crash:", e);
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}