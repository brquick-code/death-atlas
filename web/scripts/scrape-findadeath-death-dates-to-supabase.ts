/**
 * Scrape death place text from FindADeath person pages and write it into Supabase.
 *
 * Input:
 *   findadeath-people-leads.json
 *
 * Matches rows by:
 *   source_url == lead.url
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   TABLE=death_locations
 *   IN_LEADS=findadeath-people-leads.json
 *   CONCURRENCY=3
 *   MIN_DELAY_MS=350
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

type Lead = {
  name: string;
  url: string;
  birthYear: number | null;
  deathYear: number | null;
  source: "findadeath";
  sourceUrl: string;
};

type Result = {
  url: string;
  name: string;
  ok: boolean;
  status: "updated" | "no_place_found" | "not_found_404" | "supabase_not_found" | "error";
  death_place_text: string | null;
  debug_snippet: string | null;
  error?: string;
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const TABLE = process.env.TABLE || "death_locations";
const IN_LEADS = process.env.IN_LEADS || "findadeath-people-leads.json";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || "3"));
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "350");

const OUT_REPORT = path.join(process.cwd(), "findadeath-deathplace-scrape-report.json");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clean(s: string): string {
  return s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchHtml(url: string): Promise<{ status: number; html: string | null }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "death-atlas-bot/1.0 (findadeath death-place scraper)",
      Accept: "text/html,*/*",
    },
  });

  if (res.status === 404) return { status: 404, html: null };
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);

  return { status: res.status, html: await res.text() };
}

async function detectTableColumns(supabaseUrl: string, serviceKey: string, table: string): Promise<Set<string>> {
  const url = `${supabaseUrl}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    // fallback: assume common
    return new Set(["source_url", "death_place_text", "death_place", "death_location_text"]);
  }

  const json = (await res.json()) as any[];
  if (Array.isArray(json) && json.length && json[0] && typeof json[0] === "object") {
    return new Set(Object.keys(json[0]));
  }

  return new Set(["source_url", "death_place_text", "death_place", "death_location_text"]);
}

function pickDeathPlaceColumn(cols: Set<string>): string | null {
  const candidates = [
    "death_place_text",
    "death_place",
    "death_location_text",
    "death_location",
    "place_of_death_text",
    "place_of_death",
    "death_place_label", // if you already use label columns
  ];
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

/**
 * Extract death place text.
 *
 * Strategy:
 *  1) Look for sentences containing "died" and " in/at " (common on FindADeath)
 *  2) Prefer those that ALSO contain a year or a month name nearby (keeps us from grabbing random "died" mentions)
 *  3) Fallback: pull a short phrase after "died in/at" even without date language
 *
 * Returns a reasonably short place string (no geocoding yet).
 */
function extractDeathPlaceFromPage(html: string): { place: string | null; snippet: string | null } {
  const $ = cheerio.load(html);

  // Use entry content if present; otherwise body
  const scope: any = $(".entry-content, article .entry-content, article, main").first();
  const text = clean((scope && scope.length ? scope.text() : $("body").text()) || "");

  if (!text) return { place: null, snippet: null };

  // Split into sentence-ish chunks (good enough)
  const chunks = text
    .split(/(?<=[\.\!\?])\s+/)
    .map(clean)
    .filter(Boolean)
    .slice(0, 600); // don’t go crazy

  const monthRe =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i;

  const yearRe = /\b(18\d{2}|19\d{2}|20\d{2})\b/;

  const diedRe = /\bdied\b/i;

  const preferred: { place: string; snippet: string; score: number }[] = [];

  for (const s of chunks) {
    if (!diedRe.test(s)) continue;

    // Normalize curly quotes etc.
    const sentence = s;

    // Patterns:
    // "died in Los Angeles"
    // "died at Cedars-Sinai Medical Center in Los Angeles"
    // "died at his home in Brentwood"
    // We'll capture the phrase after "died" up to " on <date>" or end.
    // We then try to peel off the date part.
    const m = sentence.match(/\bdied\b([^\.]{0,220})/i);
    if (!m) continue;

    const tail = clean(m[1]);

    // Must contain " in " or " at " somewhere, otherwise it's often "died of..."
    if (!/\b(in|at)\b/i.test(tail)) continue;

    // Cut off at " on <date>" if present
    let cut = tail;
    cut = cut.replace(/\bon\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b.*$/i, "");
    cut = cut.replace(/\bon\s+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}.*$/i, "");
    cut = cut.replace(/\bon\s+\d{4}.*$/i, "");

    // Also cut off common “cause of death” phrases
    cut = cut.replace(/\bfrom\b.*$/i, "");
    cut = cut.replace(/\bafter\b.*$/i, "");
    cut = cut.replace(/\bof\b.*$/i, "");

    // Now look for last " in " or " at " phrase as the likely place chunk
    // e.g., " at Cedars-Sinai Medical Center in Los Angeles, California"
    // We'll take from the last " in " OR " at " to end.
    const inIdx = cut.toLowerCase().lastIndexOf(" in ");
    const atIdx = cut.toLowerCase().lastIndexOf(" at ");
    const startIdx = Math.max(inIdx, atIdx);

    if (startIdx < 0) continue;

    let place = clean(cut.slice(startIdx + 4)); // +4 works for " in " or " at "
    // Clean leading articles/pronouns
    place = place.replace(/^(his|her|their|the)\s+/i, "");
    // Remove trailing junk punctuation
    place = place.replace(/^[\:\-\—\–\s]+/, "").replace(/[\s,;:\-\—\–]+$/, "");

    // Keep it reasonable length
    if (place.length < 3) continue;
    if (place.length > 140) place = place.slice(0, 140).trim();

    // Score: prefer sentences that include date-ish stuff, which usually correlate with good factual death sentences
    let score = 0;
    if (monthRe.test(sentence)) score += 3;
    if (yearRe.test(sentence)) score += 2;
    if (/\b(hospital|medical center|home|residence)\b/i.test(sentence)) score += 1;

    preferred.push({ place, snippet: sentence, score });
  }

  if (preferred.length) {
    preferred.sort((a, b) => b.score - a.score || a.place.length - b.place.length);
    return { place: preferred[0].place, snippet: preferred[0].snippet };
  }

  // Fallback: try a looser regex on the full text
  const loose = text.match(/\bdied\b.{0,60}\b(?:in|at)\b\s+([^\.]{3,120})/i);
  if (loose) {
    let place = clean(loose[1]);
    place = place.replace(/\bon\s+.*$/i, "").replace(/[\s,;:\-\—\–]+$/, "");
    if (place.length > 140) place = place.slice(0, 140).trim();
    return { place, snippet: clean(loose[0]) };
  }

  return { place: null, snippet: null };
}

async function workerPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length) as any;
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function main() {
  const inPath = path.join(process.cwd(), IN_LEADS);
  const raw = await fs.readFile(inPath, "utf8");
  const leads: Lead[] = JSON.parse(raw);

  console.log(`Loaded ${leads.length} leads from ${path.basename(inPath)}`);
  console.log(`Writing death place text into table="${TABLE}" CONCURRENCY=${CONCURRENCY} MIN_DELAY_MS=${MIN_DELAY_MS}`);

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("Detecting table columns...");
  const cols = await detectTableColumns(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, TABLE);
  console.log(`Detected ${cols.size} column(s).`);

  const placeCol = pickDeathPlaceColumn(cols);
  if (!cols.has("source_url")) {
    console.error(`Your table "${TABLE}" does not appear to have a "source_url" column. This script matches on source_url.`);
    process.exit(1);
  }
  if (!placeCol) {
    console.error(
      `Could not find a death-place column in "${TABLE}".\n` +
      `Add one like: death_place_text TEXT\n` +
      `or tell me your column name and I'll wire it in.`
    );
    process.exit(1);
  }

  console.log(`Using column "${placeCol}" for death place text.`);

  let updated = 0;
  let noPlace = 0;
  let notFound404 = 0;
  let supabaseMissing = 0;
  let errors = 0;

  const results = await workerPool(leads, CONCURRENCY, async (lead, idx) => {
    if (idx % 25 === 0) console.log(`Progress ${idx}/${leads.length}...`);

    try {
      await sleep(MIN_DELAY_MS);
      const fetched = await fetchHtml(lead.url);

      if (fetched.status === 404 || !fetched.html) {
        notFound404++;
        return {
          url: lead.url,
          name: lead.name,
          ok: true,
          status: "not_found_404",
          death_place_text: null,
          debug_snippet: null,
        } satisfies Result;
      }

      const ex = extractDeathPlaceFromPage(fetched.html);

      if (!ex.place) {
        noPlace++;
        return {
          url: lead.url,
          name: lead.name,
          ok: true,
          status: "no_place_found",
          death_place_text: null,
          debug_snippet: null,
        } satisfies Result;
      }

      const patch: Record<string, any> = {};
      patch[placeCol] = ex.place;

      const { data, error } = await supabase
        .from(TABLE)
        .update(patch)
        .eq("source_url", lead.url)
        .select("source_url");

      if (error) throw error;

      if (!data || data.length === 0) {
        supabaseMissing++;
        return {
          url: lead.url,
          name: lead.name,
          ok: true,
          status: "supabase_not_found",
          death_place_text: ex.place,
          debug_snippet: ex.snippet,
        } satisfies Result;
      }

      updated++;
      return {
        url: lead.url,
        name: lead.name,
        ok: true,
        status: "updated",
        death_place_text: ex.place,
        debug_snippet: ex.snippet,
      } satisfies Result;
    } catch (e: any) {
      errors++;
      return {
        url: lead.url,
        name: lead.name,
        ok: false,
        status: "error",
        death_place_text: null,
        debug_snippet: null,
        error: e?.message || String(e),
      } satisfies Result;
    }
  });

  await fs.writeFile(OUT_REPORT, JSON.stringify(results, null, 2), "utf8");

  console.log("Done.");
  console.log(`Updated: ${updated}`);
  console.log(`No place found: ${noPlace}`);
  console.log(`404 dead links: ${notFound404}`);
  console.log(`No matching row in Supabase (by source_url): ${supabaseMissing}`);
  console.log(`Errors: ${errors}`);
  console.log(`Wrote ${path.basename(OUT_REPORT)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
