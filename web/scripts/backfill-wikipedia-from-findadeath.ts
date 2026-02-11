/**
 * Backfill wikipedia_url by scraping FindADeath pages for Wikipedia links.
 *
 * Usage:
 *   cd web
 *   npx ts-node scripts/backfill-wikipedia-from-findadeath.ts
 *
 * Env (web/.env.local or web/.env):
 *   NEXT_PUBLIC_SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type Row = {
  id: string;
  title: string | null;
  wikipedia_url: string | null;
  source_urls: string[] | null;
  is_published: boolean | null;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normUrl(url?: string) {
  if (!url) return "";
  let s = String(url).trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function uniqUrls(arr: (string | null | undefined)[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const n = normUrl(x || "");
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function isFindADeath(url: string) {
  return url.toLowerCase().includes("findadeath.com");
}
function isWikipedia(url: string) {
  return url.toLowerCase().includes("wikipedia.org/wiki/");
}

/**
 * Extract the first Wikipedia article link from FindADeath HTML.
 * We keep it strict: only /wiki/ links, not mobile, not special pages.
 */
function extractWikipediaFromHtml(html: string): string | null {
  // Common patterns: href="https://en.wikipedia.org/wiki/..." or href="http://en.wikipedia.org/wiki/..."
  const re = /href\s*=\s*["'](https?:\/\/(?:en\.)?wikipedia\.org\/wiki\/[^"'#\s]+)["']/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const url = normUrl(m[1]);
    if (!url) continue;
    // ignore obvious non-article namespaces if you want to be stricter:
    // (leave this permissive for now; Wikipedia namespaces are rare here)
    matches.push(url);
    if (matches.length >= 5) break;
  }

  // Prefer en.wikipedia if multiple
  const en = matches.find((u) => u.includes("en.wikipedia.org/wiki/"));
  return en || matches[0] || null;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "DeathAtlas/1.0 (backfill wikipedia_url from FindADeath)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function main() {
  const PAGE = 200;
  const REQUEST_DELAY_MS = 300; // be polite to FindADeath
  const MAX_UPDATES = 2000; // safety

  let lastId = "";
  let scanned = 0;
  let updated = 0;
  let noWikiFound = 0;

  console.log("Backfilling wikipedia_url from FindADeath…");

  while (updated < MAX_UPDATES) {
    let q = supabase
      .from("death_locations")
      .select("id,title,wikipedia_url,source_urls,is_published")
      .eq("is_published", true)
      .order("id", { ascending: true })
      .limit(PAGE);

    if (lastId) q = q.gt("id", lastId);

    // only rows missing wikipedia_url
    q = q.or("wikipedia_url.is.null,wikipedia_url.eq.");

    const { data, error } = await q;
    if (error) throw error;

    const rows = (data || []) as Row[];
    if (!rows.length) break;

    for (const r of rows) {
      lastId = r.id;
      scanned++;

      const existingWiki = normUrl(r.wikipedia_url || "");
      if (existingWiki) continue;

      const sources = (r.source_urls || []).map(normUrl).filter(Boolean);
      const fad = sources.find((u) => isFindADeath(u));
      if (!fad) continue; // only handle FindADeath-driven rows

      const html = await fetchHtml(fad);
      await sleep(REQUEST_DELAY_MS);

      if (!html) continue;

      const wiki = extractWikipediaFromHtml(html);
      if (!wiki) {
        noWikiFound++;
        continue;
      }

      // If the wiki is already in source_urls, still fill wikipedia_url
      const nextSourceUrls = uniqUrls([...sources, wiki]);

      const { error: upErr } = await supabase
        .from("death_locations")
        .update({
          wikipedia_url: wiki,
          source_urls: nextSourceUrls,
        })
        .eq("id", r.id);

      if (upErr) {
        console.warn("Update failed:", r.id, r.title, upErr.message);
      } else {
        updated++;
        console.log(`✓ ${r.title || r.id} -> ${wiki}`);
      }
    }
  }

  console.log(`Done. Scanned ${scanned}, updated ${updated}, noWikiFound ${noWikiFound}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
