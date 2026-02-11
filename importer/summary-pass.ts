import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const BATCH_SIZE = Number(process.env.SUMMARY_BATCH_SIZE ?? 100);
const SLEEP_MS = Number(process.env.SUMMARY_SLEEP_MS ?? 350);
const MAX_SUMMARY_CHARS = Number(process.env.SUMMARY_MAX_CHARS ?? 750);

type DeathLocationRow = {
  id: string;
  title: string;
  type: "person" | "event";
  category: string;
  summary: string;
  source_url: string;
  source_name: string;
  external_id: string | null;
  is_published: boolean;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function wikipediaTitleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("wikipedia.org")) return null;
    const parts = u.pathname.split("/wiki/");
    if (parts.length < 2) return null;
    const raw = parts[1];
    if (!raw) return null;
    return decodeURIComponent(raw).replace(/_/g, " ");
  } catch {
    return null;
  }
}

function cleanSummary(text: string): string {
  let t = text.replace(/\s+/g, " ").replace(/\[[^\]]*]/g, "").trim();

  if (t.length > MAX_SUMMARY_CHARS) {
    const cut = t.slice(0, MAX_SUMMARY_CHARS);
    const lastPeriod = cut.lastIndexOf(". ");
    t = lastPeriod > 120 ? cut.slice(0, lastPeriod + 1) : cut.trimEnd() + "…";
  }

  return t;
}

function inferCategory(title: string, summary: string): string {
  const s = (title + " " + summary).toLowerCase();

  if (/\bassassin(?:ated|ation)\b/.test(s)) return "assassination";
  if (/\bmurder(?:ed|)\b/.test(s)) return "murder";
  if (/\bexecut(?:ed|ion)\b/.test(s)) return "execution";
  if (/\bsuicid(?:e|al)\b/.test(s)) return "suicide";

  if (/\b(crash|collision|wreck|plane crash|air crash|traffic accident|car accident)\b/.test(s))
    return "accident";
  if (/\b(overdose|drug overdose)\b/.test(s)) return "overdose";
  if (/\b(heart attack|cardiac arrest|stroke)\b/.test(s)) return "medical";
  if (/\b(war|battle|killed in action|kia|combat)\b/.test(s)) return "war";
  if (/\b(fire|explosion|bombing)\b/.test(s)) return "disaster";

  return "unknown";
}

async function fetchWikipediaSummary(pageTitle: string): Promise<string | null> {
  const endpoint = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
    pageTitle
  )}?redirect=true`;

  const res = await fetch(endpoint, {
    headers: {
      "User-Agent": "DeathAtlasSummaryPass/1.0 (local-script)",
      Accept: "application/json",
    },
  });

  if (!res.ok) return null;

  const data = (await res.json()) as any;
  if (typeof data?.extract === "string" && data.extract.trim().length > 0) {
    return data.extract.trim();
  }
  return null;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: rows, error } = await supabase
    .from("death_locations")
    .select("id,title,type,category,summary,source_url,source_name,external_id,is_published")
    .eq("type", "person")
    .eq("is_published", false)
    .or("summary.is.null,summary.eq.")
    .limit(BATCH_SIZE);

  if (error) throw error;

  const items = (rows ?? []) as DeathLocationRow[];
  console.log(`Found ${items.length} rows needing summaries (batch size ${BATCH_SIZE}).`);

  let updated = 0;
  let skipped = 0;

  for (const row of items) {
    const wikiTitle = wikipediaTitleFromUrl(row.source_url);
    if (!wikiTitle) {
      skipped++;
      continue;
    }

    const raw = await fetchWikipediaSummary(wikiTitle);
    await sleep(SLEEP_MS);

    if (!raw) {
      skipped++;
      continue;
    }

    const summary = cleanSummary(raw);
    const inferred = inferCategory(row.title, summary);

    const nextCategory = row.category && row.category !== "unknown" ? row.category : inferred;

    const { error: upErr } = await supabase
      .from("death_locations")
      .update({ summary, category: nextCategory })
      .eq("id", row.id);

    if (upErr) {
      console.warn(`Update failed for ${row.title}: ${upErr.message}`);
      continue;
    }

    updated++;
    console.log(`✓ ${row.title} -> category=${nextCategory}`);
  }

  console.log(`Done. Updated: ${updated}. Skipped: ${skipped}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
