import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/death-one?id=<uuid>
 * Returns ONE published row by id (death coords preferred, else burial).
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false } }
);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

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
      .not("is_hidden", "is", true)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message, details: error.details ?? null }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const lat = (data as any).death_latitude ?? (data as any).burial_latitude ?? null;
    const lng = (data as any).death_longitude ?? (data as any).burial_longitude ?? null;

    return NextResponse.json({ ...(data as any), lat, lng }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Unhandled error in death-one route", message: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
