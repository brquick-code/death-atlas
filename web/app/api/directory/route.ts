import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function getSupabase() {
  const url = process.env.SCA_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SCA_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase env vars. Need SCA_SUPABASE_URL + SCA_SUPABASE_ANON_KEY (or SUPABASE_URL + SUPABASE_ANON_KEY)."
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

function safeInt(v: string | null, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const limit = Math.min(safeInt(searchParams.get("limit"), 500), 2000);
    const sort = (searchParams.get("sort") || "alpha").toLowerCase();

    const supabase = getSupabase();

    let query = supabase
      .from("death_locations")
      .select(
        [
          "id",
          "title",
          "death_latitude",
          "death_longitude",
          "burial_latitude",
          "burial_longitude",
          "missing_latitude",
          "missing_longitude",
          "category",
          "death_type",
          "death_date",
          "created_at",
        ].join(",")
      )
      // Keep these filters even with RLS (defense-in-depth + predictable behavior)
      .eq("is_published", true)
      .neq("is_hidden", true)
      .limit(limit);

    if (sort === "newest") {
      query = query.order("created_at", { ascending: false, nullsFirst: false });
    } else {
      query = query.order("title", { ascending: true, nullsFirst: false });
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data ?? [], { status: 200 });
  } catch (e: any) {
    console.error("[/api/directory] crash:", e);
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}