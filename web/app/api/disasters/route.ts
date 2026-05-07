import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SCA_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SCA_SUPABASE_ANON_KEY!;

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const minLat = num(searchParams.get("minLat"));
    const minLng = num(searchParams.get("minLng"));
    const maxLat = num(searchParams.get("maxLat"));
    const maxLng = num(searchParams.get("maxLng"));
    const limit = num(searchParams.get("limit")) ?? 2000;

    if (
      minLat == null || minLng == null ||
      maxLat == null || maxLng == null
    ) {
      return NextResponse.json(
        { error: "Missing bounds params (minLat,minLng,maxLat,maxLng)" },
        { status: 400 }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase.rpc("disasters_in_bounds", {
      min_lat: minLat,
      min_lng: minLng,
      max_lat: maxLat,
      max_lng: maxLng,
      lim: limit,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ rows: data ?? [] });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}