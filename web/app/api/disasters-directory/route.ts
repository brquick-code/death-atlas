// web/app/api/disasters-directory/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function num(v: string | null, fallback: number) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const q = (searchParams.get("q") ?? "").trim();
    const limit = Math.min(Math.max(num(searchParams.get("limit"), 50), 1), 200);
    const offset = Math.max(num(searchParams.get("offset"), 0), 0);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    });

    let query = supabase
      .from("disaster_sites")
      .select(
        [
          "id",
          "title",
          "disaster_type",
          "location_name",
          "start_date",
          "end_date",
          "year",
          "deaths_est",
          "deaths_min",
          "deaths_max",
          "latitude",
          "longitude",
        ].join(","),
        { count: "exact" }
      )
      .eq("published", true)
      .order("year", { ascending: false, nullsFirst: false })
      .order("start_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    // Search across title + location + type
    if (q.length >= 2) {
      // Escape for ilike
      const qq = q.replace(/%/g, "\\%").replace(/_/g, "\\_");
      query = query.or(
        `title.ilike.%${qq}%,location_name.ilike.%${qq}%,disaster_type.ilike.%${qq}%`
      );
    }

    const { data, error, count } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      rows: data ?? [],
      count: count ?? null,
      limit,
      offset,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}