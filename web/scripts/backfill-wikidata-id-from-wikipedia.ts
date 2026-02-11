/**
 * Backfill wikidata_id from Wikipedia URLs (published-only)
 * - Batched (avoids timeouts)
 * - Duplicate-safe (merges into existing keeper row when QID already exists)
 * - Uses wikidata_checked_at to avoid infinite loops
 *
 * ONE-TIME SQL:
 *   alter table public.death_locations
 *   add column if not exists wikidata_checked_at timestamptz;
 *
 * Run:
 *   cd C:\death-atlas\web
 *   npx ts-node scripts\backfill-wikidata-id-from-wikipedia.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type Row = {
  id: string;
  title: string | null;

  is_published: boolean | null;
  merged_into_id: string | null;

  wikidata_id: string | null;

  wikipedia_url?: string | null;
  source_url?: string | null;
  source_urls?: string[] | null;

  wikidata_checked_at?: string | null;
};

type KeeperRow = {
  id: string;
  wikidata_id: string;
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function pickWikipediaUrl(r: Row): string | null {
  const candidates: (string | null | undefined)[] = [
    r.wikipedia_url,
    r.source_url,
    ...(r.source_urls ?? []),
  ];

  for (const u of candidates) {
    if (!u) continue;
    const low = u.toLowerCase();
    if (low.includes("wikipedia.org/wiki/")) return u;
  }
  return null;
}

function extractWikipediaTitle(url: string): string | null {
  const m = url.match(/wikipedia\.org\/wiki\/([^#?]+)/i);
  if (!m) return null;
  return m[1];
}

async function fetchWikibaseItemFromWikipediaTitle(titleEncoded: string): Promise<string | null> {
  const api =
    `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&prop=pageprops&titles=${encodeURIComponent(decodeURIComponent(titleEncoded))}`;

  const res = await fetch(api, {
    headers: {
      "User-Agent": "DeathAtlas/1.0 (personal project)",
      Accept: "application/json",
    },
  });

  if (!res.ok) return null;

  const json = await res.json();
  const pages = json?.query?.pages;
  if (!pages) return null;

  const firstKey = Object.keys(pages)[0];
  const page = pages[firstKey];
  const qid = page?.pageprops?.wikibase_item;

  if (typeof qid === "string" && /^Q\d+$/i.test(qid)) return qid.toUpperCase();
  return null;
}

async function markChecked(supabase: any, id: string) {
  await supabase
    .from("death_locations")
    .update({ wikidata_checked_at: nowIso() })
    .eq("id", id)
    .is("wikidata_id", null)
    .is("merged_into_id", null);
}

async function main() {
  const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  // Cast to any to avoid "never" type issues without generated DB types
  const supabase: any = createClient(supabaseUrl, key);

  console.log("Backfill wikidata_id from Wikipedia URLs (published only) — batched + checked");
  console.log("Supabase:", supabaseUrl);
  console.log("Auth key:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "SERVICE_ROLE" : "ANON (fallback)");

  // knobs
  const DB_BATCH = 50;
  const WIKI_DELAY_MS = 250;
  const MAX_ACTIONS_PER_RUN = 500;

  let scanned = 0;
  let actions = 0;

  let setQid = 0;
  let merged = 0;
  let checkedOnly = 0;
  let skippedNoWiki = 0;
  let skippedNoQid = 0;

  while (true) {
    if (actions >= MAX_ACTIONS_PER_RUN) {
      console.log(`?? Reached MAX_ACTIONS_PER_RUN=${MAX_ACTIONS_PER_RUN}. Stop now; run again later.`);
      break;
    }

    const { data, error } = await supabase
      .from("death_locations")
      .select(
        "id,title,is_published,merged_into_id,wikidata_id,wikipedia_url,source_url,source_urls,wikidata_checked_at"
      )
      .eq("is_published", true)
      .is("merged_into_id", null)
      .is("wikidata_id", null)
      .is("wikidata_checked_at", null)
      .order("id", { ascending: true })
      .limit(DB_BATCH);

    if (error) throw error;

    const rows = (data || []) as Row[];
    if (rows.length === 0) break;

    scanned += rows.length;

    // Resolve QIDs
    const resolved = new Map<string, { row: Row; qid: string }>();
    const qids: string[] = [];

    for (const r of rows) {
      const wikiUrl = pickWikipediaUrl(r);
      if (!wikiUrl) {
        skippedNoWiki += 1;
        await markChecked(supabase, r.id);
        checkedOnly += 1;
        continue;
      }

      const titleEnc = extractWikipediaTitle(wikiUrl);
      if (!titleEnc) {
        skippedNoWiki += 1;
        await markChecked(supabase, r.id);
        checkedOnly += 1;
        continue;
      }

      await sleep(WIKI_DELAY_MS);

      const qid = await fetchWikibaseItemFromWikipediaTitle(titleEnc);
      if (!qid) {
        skippedNoQid += 1;
        console.log(`— no QID | ${r.title ?? r.id} | ${wikiUrl}`);
        await markChecked(supabase, r.id);
        checkedOnly += 1;
        continue;
      }

      resolved.set(r.id, { row: r, qid });
      qids.push(qid);
    }

    const uniqueQids = Array.from(new Set(qids));
    if (uniqueQids.length === 0) {
      console.log("No resolvable QIDs in this batch; continuing.");
      continue;
    }

    // Find existing keepers for those QIDs (single query)
    const { data: keepers, error: keepErr } = await supabase
      .from("death_locations")
      .select("id,wikidata_id")
      .in("wikidata_id", uniqueQids)
      .is("merged_into_id", null);

    if (keepErr) throw keepErr;

    const keeperByQid = new Map<string, string>();
    for (const k of (keepers || []) as KeeperRow[]) {
      keeperByQid.set(String(k.wikidata_id).toUpperCase(), k.id);
    }

    // Apply updates/merges
    for (const [rowId, info] of resolved.entries()) {
      if (actions >= MAX_ACTIONS_PER_RUN) break;

      const qid = info.qid;
      const keeperId = keeperByQid.get(qid);

      if (keeperId && keeperId !== rowId) {
        const { error: mergeErr } = await supabase
          .from("death_locations")
          .update({
            merged_into_id: keeperId,
            merged_at: nowIso(),
            wikidata_checked_at: nowIso(),
          })
          .eq("id", rowId)
          .is("wikidata_id", null)
          .is("merged_into_id", null);

        if (mergeErr) {
          console.log(`? merge failed | ${info.row.title ?? rowId} -> ${keeperId} | ${qid} | ${mergeErr.message}`);
          await markChecked(supabase, rowId);
          checkedOnly += 1;
        } else {
          merged += 1;
          actions += 1;
          console.log(`?? merged | ${info.row.title ?? rowId} -> ${keeperId} | qid=${qid}`);
        }
        continue;
      }

      const { error: setErr } = await supabase
        .from("death_locations")
        .update({
          wikidata_id: qid,
          wikidata_checked_at: nowIso(),
        })
        .eq("id", rowId)
        .is("wikidata_id", null)
        .is("merged_into_id", null);

      if (setErr) {
        console.log(`? set QID failed | ${info.row.title ?? rowId} | ${qid} | ${setErr.message}`);
        await markChecked(supabase, rowId);
        checkedOnly += 1;
      } else {
        setQid += 1;
        actions += 1;
        console.log(`? set wikidata_id=${qid} | ${info.row.title ?? rowId}`);
      }
    }
  }

  console.log(
    `Done. Scanned=${scanned} Actions=${actions} SetQid=${setQid} Merged=${merged} CheckedOnly=${checkedOnly} NoWiki=${skippedNoWiki} NoQid=${skippedNoQid}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
