// web/scripts/backfill-oddstops-wikipedia-urls.ts
//
// Backfill Wikipedia links for OddStops records using Wikidata sitelinks.
// - Finds rows where source='oddstops' AND wikipedia_url is empty AND wikidata_qid is present
// - Fetches enwiki sitelink from Wikidata (wbgetentities)
// - Updates wikipedia_url
// - Appends the Wikipedia URL to source_urls[] (deduped)
//
// Run (PowerShell):
//   $env:SUPABASE_URL="https://xxxx.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY="xxxxx"
//   npx ts-node scripts\backfill-oddstops-wikipedia-urls.ts
//
// Optional env:
//   $env:BATCH_SIZE="500"         (default 250)
//   $env:CONCURRENCY="6"          (default 6)
//   $env:MIN_DELAY_MS="120"       (default 120)  // per-request pacing to Wikidata
//   $env:MAX_RETRIES="3"          (default 3)
//   $env:DRY_RUN="1"              (default 0)    // do not write updates
//   $env:LOG_EVERY="50"           (default 50)

import { createClient } from "@supabase/supabase-js";

type DeathLocationRow = {
  id: string;
  title: string | null;
  source: string | null;
  wikidata_qid: string | null;
  wikipedia_url: string | null;
  source_urls: string[] | null;
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing env vars. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
  );
  process.exit(1);
}

const BATCH_SIZE = clampInt(process.env.BATCH_SIZE, 1, 5000, 250);
const CONCURRENCY = clampInt(process.env.CONCURRENCY, 1, 25, 6);
const MIN_DELAY_MS = clampInt(process.env.MIN_DELAY_MS, 0, 5000, 120);
const MAX_RETRIES = clampInt(process.env.MAX_RETRIES, 0, 10, 3);
const DRY_RUN = truthy(process.env.DRY_RUN);
const LOG_EVERY = clampInt(process.env.LOG_EVERY, 1, 1000, 50);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function clampInt(
  v: string | undefined,
  min: number,
  max: number,
  fallback: number
) {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truthy(v: string | undefined) {
  if (!v) return false;
  return ["1", "true", "yes", "y", "on"].includes(v.toLowerCase().trim());
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(u: string) {
  return u.trim();
}

function hasWikipediaUrl(urls: string[] | null | undefined) {
  if (!urls?.length) return false;
  return urls.some((u) => {
    const x = normalizeUrl(u).toLowerCase();
    return x.includes("wikipedia.org/wiki/");
  });
}

function dedupeUrls(urls: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const nu = normalizeUrl(u);
    if (!nu) continue;
    if (seen.has(nu)) continue;
    seen.add(nu);
    out.push(nu);
  }
  return out;
}

async function fetchJsonWithRetry(url: string, maxRetries: number) {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (MIN_DELAY_MS > 0) await sleep(MIN_DELAY_MS);

      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "DeathAtlasBot/1.0 (https://example.invalid; contact=none)",
          "Accept": "application/json",
        },
      });

      if (!res.ok) {
        // Retry on 429/5xx
        if (
          (res.status === 429 || (res.status >= 500 && res.status <= 599)) &&
          attempt < maxRetries
        ) {
          const backoff = 400 * Math.pow(2, attempt);
          await sleep(backoff);
          continue;
        }
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
      }

      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const backoff = 400 * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr ?? new Error("Unknown fetch error");
}

async function getEnwikiUrlFromWikidata(qid: string): Promise<string | null> {
  const clean = qid.trim().toUpperCase();
  if (!/^Q\d+$/.test(clean)) return null;

  const api = new URL("https://www.wikidata.org/w/api.php");
  api.searchParams.set("action", "wbgetentities");
  api.searchParams.set("format", "json");
  api.searchParams.set("props", "sitelinks/urls");
  api.searchParams.set("sitefilter", "enwiki");
  api.searchParams.set("ids", clean);

  const json = await fetchJsonWithRetry(api.toString(), MAX_RETRIES);

  const entity = json?.entities?.[clean];
  const enwiki = entity?.sitelinks?.enwiki;

  // When props includes urls, enwiki may contain "url"
  if (enwiki?.url && typeof enwiki.url === "string") {
    return enwiki.url;
  }

  // Fallback: use title if present
  if (enwiki?.title && typeof enwiki.title === "string") {
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(
      enwiki.title.replace(/ /g, "_")
    )}`;
  }

  return null;
}

async function loadBatch(offset: number): Promise<DeathLocationRow[]> {
  // Pull rows missing wikipedia_url but having wikidata_qid
  // Note: Supabase filter for empty strings isn't perfect; we handle trim/empty client-side too.
  const { data, error } = await supabase
    .from("death_locations")
    .select("id,title,source,wikidata_qid,wikipedia_url,source_urls")
    .eq("source", "oddstops")
    .not("wikidata_qid", "is", null)
    .range(offset, offset + BATCH_SIZE - 1);

  if (error) throw error;

  // Client-side filter: wikipedia_url empty/blank
  return (data ?? []).filter((r: any) => {
    const w = (r.wikipedia_url ?? "").toString().trim();
    return w.length === 0;
  }) as DeathLocationRow[];
}

async function updateRow(
  id: string,
  wikipediaUrl: string,
  nextSourceUrls: string[]
) {
  if (DRY_RUN) return;

  const { error } = await supabase
    .from("death_locations")
    .update({
      wikipedia_url: wikipediaUrl,
      source_urls: nextSourceUrls,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw error;
}

async function main() {
  console.log("=== Backfill OddStops Wikipedia URLs ===");
  console.log(
    JSON.stringify(
      {
        BATCH_SIZE,
        CONCURRENCY,
        MIN_DELAY_MS,
        MAX_RETRIES,
        DRY_RUN,
      },
      null,
      2
    )
  );

  let offset = 0;

  let scanned = 0;
  let candidates = 0;
  let updated = 0;
  let skippedNoEnwiki = 0;
  let skippedAlreadyInArray = 0;
  let errors = 0;

  while (true) {
    const batch = await loadBatch(offset);
    scanned += batch.length;

    if (batch.length === 0) {
      // We might have reached the end of the table range OR there are no more missing wikipedia_url rows.
      // To avoid missing records due to gaps, we keep paging until we also get an empty raw range.
      // But we already filter client-side. So: if raw range had rows but none matched, we'd incorrectly stop.
      // Solution: fetch raw range count by querying without client-side filter would be heavy.
      // Practical: continue advancing offsets until we see multiple empty pages in a row.
      // We'll do a small safeguard: stop after two consecutive empty filtered pages.
      const nextTry = await loadBatch(offset + BATCH_SIZE);
      if (nextTry.length === 0) break;
      offset += BATCH_SIZE;
      continue;
    }

    candidates += batch.length;

    // Process with limited concurrency
    const queue = batch.slice();
    const workers: Promise<void>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(
        (async () => {
          while (queue.length) {
            const row = queue.shift()!;
            try {
              const qid = row.wikidata_qid?.trim();
              if (!qid) {
                skippedNoEnwiki++;
                continue;
              }

              const enwikiUrl = await getEnwikiUrlFromWikidata(qid);
              if (!enwikiUrl) {
                skippedNoEnwiki++;
                continue;
              }

              const existing = row.source_urls ?? [];
              const already = existing.some(
                (u) => normalizeUrl(u) === normalizeUrl(enwikiUrl)
              );

              const next = already
                ? dedupeUrls(existing)
                : dedupeUrls([...existing, enwikiUrl]);

              if (already) skippedAlreadyInArray++;

              await updateRow(row.id, enwikiUrl, next);
              updated++;

              if (updated % LOG_EVERY === 0) {
                console.log(
                  `Progress: updated=${updated} candidates=${candidates} skippedNoEnwiki=${skippedNoEnwiki} errors=${errors}`
                );
              }
            } catch (e: any) {
              errors++;
              const label = row.title ?? row.id;
              console.error(
                `ERROR on ${label} (${row.wikidata_qid ?? "no-qid"}):`,
                e?.message ?? e
              );
            }
          }
        })()
      );
    }

    await Promise.all(workers);

    offset += BATCH_SIZE;
  }

  console.log("=== DONE ===");
  console.log(
    JSON.stringify(
      {
        scanned,
        candidates,
        updated,
        skippedNoEnwiki,
        skippedAlreadyInArray,
        errors,
        dryRun: DRY_RUN,
      },
      null,
      2
    )
  );

  if (DRY_RUN) {
    console.log(
      "DRY_RUN was enabled: no rows were updated. Re-run with DRY_RUN unset (or 0) to write changes."
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
