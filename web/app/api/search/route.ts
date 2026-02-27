// C:\death-atlas\web\app\api\search\route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function getSupabase() {
  // Server-only env vars (set these in Vercel)
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only, bypasses RLS safely
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

type CoordMode = "death" | "burial" | "missing" | "either";

function normalizeSourceUrls(row: any): string[] {
  const arr = Array.isArray(row.source_urls) ? row.source_urls : [];
  const legacy = typeof row.source_url === "string" ? row.source_url.trim() : "";
  const merged = [...arr, ...(legacy ? [legacy] : [])].filter(Boolean);

  const seen = new Set<string>();
  return merged.filter((u) => {
    const k = String(u).trim();
    if (!k) return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Normalize a "date-ish" value to YYYY-MM-DD.
 * IMPORTANT: This prevents timezone shifts (e.g., 1968-06-05T00:00:00Z showing as June 4 in US timezones).
 */
function toDateOnly(v: any): string | null {
  if (v == null) return null;

  // Supabase usually returns strings for date/timestamptz
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;

    // If it's ISO datetime, take the date portion before "T"
    const tIdx = s.indexOf("T");
    const datePart = tIdx >= 0 ? s.slice(0, tIdx) : s;

    // If it starts with YYYY-MM-DD, return that
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
    if (/^\d{4}-\d{2}-\d{2}/.test(datePart)) return datePart.slice(0, 10);

    return s; // fallback: return as-is (better than nuking it)
  }

  // If it somehow came back as a Date
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // Using UTC date avoids local offset changes, but still gives a stable YYYY-MM-DD
    return v.toISOString().slice(0, 10);
  }

  return String(v);
}

function pickLatLng(
  row: any,
  mode: CoordMode
): { lat: number | null; lng: number | null; coord_kind: "death" | "burial" | "missing" | null } {
  const dLat = typeof row.death_latitude === "number" ? row.death_latitude : null;
  const dLng = typeof row.death_longitude === "number" ? row.death_longitude : null;

  const bLat = typeof row.burial_latitude === "number" ? row.burial_latitude : null;
  const bLng = typeof row.burial_longitude === "number" ? row.burial_longitude : null;

  const mLat = typeof row.missing_latitude === "number" ? row.missing_latitude : null;
  const mLng = typeof row.missing_longitude === "number" ? row.missing_longitude : null;

  if (mode === "death") {
    if (dLat != null && dLng != null) return { lat: dLat, lng: dLng, coord_kind: "death" };
    return { lat: null, lng: null, coord_kind: null };
  }

  if (mode === "burial") {
    if (bLat != null && bLng != null) return { lat: bLat, lng: bLng, coord_kind: "burial" };
    return { lat: null, lng: null, coord_kind: null };
  }

  if (mode === "missing") {
    if (mLat != null && mLng != null) return { lat: mLat, lng: mLng, coord_kind: "missing" };
    return { lat: null, lng: null, coord_kind: null };
  }

  // either: prefer death, else burial, else missing
  if (dLat != null && dLng != null) return { lat: dLat, lng: dLng, coord_kind: "death" };
  if (bLat != null && bLng != null) return { lat: bLat, lng: bLng, coord_kind: "burial" };
  if (mLat != null && mLng != null) return { lat: mLat, lng: mLng, coord_kind: "missing" };

  return { lat: null, lng: null, coord_kind: null };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const q = (searchParams.get("q") ?? "").trim();
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "30"), 1), 50);

    const coordParam = (searchParams.get("coord") ?? "either").toLowerCase();
    const coord: CoordMode =
      coordParam === "death"
        ? "death"
        : coordParam === "burial"
        ? "burial"
        : coordParam === "missing"
        ? "missing"
        : "either";

    if (q.length < 2) return NextResponse.json({ data: [] });

    const supabase = getSupabase();

    // ✅ ONLY select columns that actually exist
    let query = supabase
      .from("death_locations")
      .select(
        [
          "id",
          "title",
          "type",
          "category",
          "wikipedia_url",
          "source_url",
          "source_urls",
          "death_date",
          "date_start",
          "date_end",
          "confidence",
          "coord_source",
          "death_latitude",
          "death_longitude",
          "burial_latitude",
          "burial_longitude",
          "burial_place_name",

          // ✅ missing fields
          "missing_latitude",
          "missing_longitude",
          "missing_place_name",
          "missing_date",
          "missing_status",

          "is_published",
          "is_hidden",
          "pageviews_365d",
        ].join(",")
      )
      .eq("is_published", true)
      .not("is_hidden", "is", true)
      .ilike("title", `%${q}%`)
      .order("pageviews_365d", { ascending: false, nullsFirst: false })
      .limit(limit);

    // Optional coord filtering
    if (coord === "death") {
      query = query.not("death_latitude", "is", null).not("death_longitude", "is", null);
    } else if (coord === "burial") {
      query = query.not("burial_latitude", "is", null).not("burial_longitude", "is", null);
    } else if (coord === "missing") {
      query = query.not("missing_latitude", "is", null).not("missing_longitude", "is", null);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const out =
      (data ?? [])
        .map((row: any) => {
          const picked = pickLatLng(row, coord);
          if (picked.lat == null || picked.lng == null) return null;

          return {
            id: row.id,
            title: row.title ?? null,
            name: row.title ?? null,

            type: row.type ?? null,
            category: row.category ?? row.type ?? null,

            wikipedia_url: row.wikipedia_url ?? null,
            source_url: row.source_url ?? null,
            source_urls: normalizeSourceUrls(row),

            // ✅ DATE-ONLY (prevents timezone shifting)
            death_date: toDateOnly(row.death_date),
            date_start: toDateOnly(row.date_start),
            date_end: toDateOnly(row.date_end),

            confidence: row.confidence ?? null,
            coord_source: row.coord_source ?? null,

            // ✅ what mobile needs to jump to it
            lat: picked.lat,
            lng: picked.lng,
            coord_kind: picked.coord_kind,

            // keep raw coord fields too (mobile expects them)
            death_latitude: typeof row.death_latitude === "number" ? row.death_latitude : null,
            death_longitude: typeof row.death_longitude === "number" ? row.death_longitude : null,
            burial_latitude: typeof row.burial_latitude === "number" ? row.burial_latitude : null,
            burial_longitude: typeof row.burial_longitude === "number" ? row.burial_longitude : null,
            burial_place_name: typeof row.burial_place_name === "string" ? row.burial_place_name : null,

            // ✅ missing raw fields for mobile (date-safe too)
            missing_latitude: typeof row.missing_latitude === "number" ? row.missing_latitude : null,
            missing_longitude: typeof row.missing_longitude === "number" ? row.missing_longitude : null,
            missing_place_name: typeof row.missing_place_name === "string" ? row.missing_place_name : null,
            missing_date: toDateOnly(row.missing_date),
            missing_status: typeof row.missing_status === "string" ? row.missing_status : null,
          };
        })
        .filter(Boolean) ?? [];

    return NextResponse.json({ data: out });
  } catch (e: any) {
    console.error("[/api/search] crash:", e);
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}