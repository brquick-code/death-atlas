import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function asNum(v: string | null, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickCoord(r: any) {
  const pairs: Array<[string, string, string]> = [
    ["death_latitude", "death_longitude", "death"],
    ["latitude", "longitude", "unknown"],
    ["burial_latitude", "burial_longitude", "burial"],
  ];

  for (const [latK, lngK, src] of pairs) {
    const lat = Number(r?.[latK]);
    const lng = Number(r?.[lngK]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, coord_source: src };
  }

  return { lat: null as any, lng: null as any, coord_source: null as any };
}

function firstNonEmpty(...vals: any[]): string | undefined {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.max(1, Math.min(200, asNum(url.searchParams.get("limit"), 30)));
    const published = (url.searchParams.get("published") || "true").toLowerCase() === "true";

    if (!q) return NextResponse.json({ points: [] });

    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const SUPABASE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY || // preferred on server
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json(
        { error: "Missing Supabase env vars (SUPABASE_URL / SUPABASE_KEY)" },
        { status: 500 }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });

    const pattern = `%${q}%`;

    // ✅ Only ILIKE on TEXT columns. (Your enum death_type cannot ILIKE)
    const or = [
      `title.ilike.${pattern}`,
      `address_label.ilike.${pattern}`,
      `summary.ilike.${pattern}`,
      `enwiki_title.ilike.${pattern}`,
      `death_place_text.ilike.${pattern}`,
    ].join(",");

    let query = supabase
      .from("death_locations")
      .select(
        [
          "id",
          "title",
          "type",
          "category",
          "death_date",
          "date_start",
          "date_end",
          "address_label",
          "burial_address_label",
          "latitude",
          "longitude",
          "death_latitude",
          "death_longitude",
          "burial_latitude",
          "burial_longitude",
          "coord_source",
          "wikipedia_url",
          "findagrave_url",
          "source_url",
          "source_urls",
          "confidence",
          "is_published",
        ].join(",")
      )
      .or(or)
      .limit(limit);

    if (published) query = query.eq("is_published", true);

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = data ?? [];

    const points = rows
      .map((r: any) => {
        const picked = pickCoord(r);
        if (!Number.isFinite(picked.lat) || !Number.isFinite(picked.lng)) return null;

        const place_name = firstNonEmpty(r.address_label, r.burial_address_label, r.death_place_text);
        const death_date = firstNonEmpty(r.death_date, r.date_end, r.date_start);

        return {
          id: String(r.id),
          name: String(firstNonEmpty(r.title) ?? "Unknown"),
          latitude: picked.lat,
          longitude: picked.lng,
          place_name,
          category: firstNonEmpty(r.category, r.type),
          death_date,
          wikipedia_url: firstNonEmpty(r.wikipedia_url),
          source_url: firstNonEmpty(r.source_url, r.wikipedia_url, r.findagrave_url),
          source_urls: Array.isArray(r.source_urls)
            ? r.source_urls.filter(Boolean).map((x: any) => String(x))
            : undefined,
          confidence: r.confidence ?? undefined,
          coord_source: firstNonEmpty(r.coord_source, picked.coord_source),
        };
      })
      .filter(Boolean);

    return NextResponse.json({ points });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Search failed" }, { status: 500 });
  }
}
