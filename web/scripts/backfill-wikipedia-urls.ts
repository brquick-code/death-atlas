/**
 * Backfill wikipedia_url in death_locations using Wikidata sitelinks.
 *
 * Usage:
 *   cd web
 *   npx ts-node scripts/backfill-wikipedia-urls.ts
 *
 * Env needed (web/.env.local or web/.env):
 *   NEXT_PUBLIC_SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type Row = {
  id: string;
  title: string | null;
  wikidata_id: string | null;
  wikipedia_url: string | null;
  source_urls: string[] | null;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normUrl(u: string) {
  let s = String(u || "").trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function uniqUrls(arr: (string | null | undefined)[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!x) continue;
    const n = normUrl(x);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

async function fetchWikidataSitelinkEnwiki(qid: string): Promise<string | null> {
  // Wikidata Special EntityData is simple and stable JSON
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "DeathAtlas/1.0 (backfill wikipedia_url)" },
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const ent = json?.entities?.[qid];
  const title = ent?.sitelinks?.enwiki?.title;
  if (!title) return null;
  // Wikipedia titles use underscores in URLs
  const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, "_"))}`;
  return wikiUrl;
}

async function main() {
  const BATCH = 200; // read size
  const UPDATE_DELAY_MS = 120; // be polite to Wikidata
  let updated = 0;
  let scanned = 0;

  console.log("Backfill wikipedia_url from Wikidata sitelinks…");

  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("death_locations")
      .select("id,title,wikidata_id,wikipedia_url,source_urls")
      .eq("is_published", true) // you can remove this if you want all rows
      .not("wikidata_id", "is", null)
      .or("wikipedia_url.is.null,wikipedia_url.eq.") // null or empty
      .range(offset, offset + BATCH - 1);

    if (error) throw error;

    const rows = (data || []) as Row[];
    if (rows.length === 0) break;

    for (const r of rows) {
      scanned++;

      const qid = (r.wikidata_id || "").trim();
      if (!qid) continue;

      const wikiUrl = await fetchWikidataSitelinkEnwiki(qid);

      if (!wikiUrl) {
        // no enwiki sitelink
        continue;
      }

      const nextSourceUrls = uniqUrls([...(r.source_urls || []), wikiUrl]);

      const { error: upErr } = await supabase
        .from("death_locations")
        .update({
          wikipedia_url: wikiUrl,
          source_urls: nextSourceUrls,
        })
        .eq("id", r.id);

      if (upErr) {
        console.warn("Update failed:", r.id, r.title, upErr.message);
      } else {
        updated++;
        console.log(`✓ ${r.title || r.id} -> ${wikiUrl}`);
      }

      await sleep(UPDATE_DELAY_MS);
    }

    offset += rows.length;
  }

  console.log(`Done. Scanned ${scanned}, updated ${updated}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
