/**
 * Fill Wikipedia pageviews (last 365 days) into death_locations.pageviews_365d
 *
 * This version ONLY scans rows that still need work:
 *   - pageviews_365d IS NULL
 *   - AND (enwiki_title IS NOT NULL OR wikipedia_url IS NOT NULL)
 *
 * It also:
 *   - Treats Wikimedia 404 as 0 views (writes 0, so it won't retry forever)
 *   - Skips bad "titles" like QIDs (Q12345) or namespaces like Special:, File:, etc.
 *   - Retries DB reads (transient network issues) instead of crashing
 *   - Shows heartbeat dots during backoff
 *
 * Env:
 *  - SUPABASE_URL (required)
 *  - SUPABASE_SERVICE_ROLE_KEY (required)
 *  - TABLE=death_locations
 *  - CONCURRENCY=1
 *  - DB_BATCH=50
 *  - MIN_DELAY_MS=250
 *
 * Optional:
 *  - START_OFFSET=0
 *  - MAX_ROWS=0            (0 = unlimited)
 *  - LOG_EVERY=25          (log an "ok:" line every N successful updates)
 *  - DB_READ_RETRIES=8
 *  - DB_READ_RETRY_MS=1500
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TABLE = process.env.TABLE || "death_locations";
const CONCURRENCY = Number(process.env.CONCURRENCY || "1");
const DB_BATCH = Number(process.env.DB_BATCH || "50");
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "250");

const START_OFFSET = Number(process.env.START_OFFSET || "0");
const MAX_ROWS = Number(process.env.MAX_ROWS || "0"); // 0 = unlimited
const LOG_EVERY = Number(process.env.LOG_EVERY || "25");

const DB_READ_RETRIES = Number(process.env.DB_READ_RETRIES || "8");
const DB_READ_RETRY_MS = Number(process.env.DB_READ_RETRY_MS || "1500");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

console.log(
  `TABLE=${TABLE} | CONCURRENCY=${CONCURRENCY} | DB_BATCH=${DB_BATCH} | MIN_DELAY_MS=${MIN_DELAY_MS} | START_OFFSET=${START_OFFSET} | LOG_EVERY=${LOG_EVERY}`
);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoYMD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function normalizeWikiTitle(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  if (!t) return null;

  // Skip Wikidata QIDs
  if (/^Q\d+$/i.test(t)) return null;

  // If stored as URL, extract /wiki/Title
  const wikiIdx = t.indexOf("/wiki/");
  if (wikiIdx !== -1) t = t.slice(wikiIdx + "/wiki/".length);

  // Strip fragment
  t = t.split("#")[0];

  // Decode if possible
  try {
    t = decodeURIComponent(t);
  } catch {
    // ignore
  }

  // Spaces -> underscores for API path
  t = t.replace(/ /g, "_").trim();
  if (!t) return null;

  // Skip obvious non-article namespaces (often 404/no data)
  const lower = t.toLowerCase();
  const badPrefixes = [
    "special:",
    "file:",
    "category:",
    "template:",
    "help:",
    "portal:",
    "talk:",
    "user:",
  ];
  if (badPrefixes.some((p) => lower.startsWith(p))) return null;

  // Skip placeholders / junk
  if (/^unknown\s*\(q\d+\)$/i.test(t)) return null;
  if (/\(q\d+\)$/i.test(t)) return null;

  return t;
}

async function fetchJsonWithRetry(url, opts = {}, retries = 8) {
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);

      // Treat 404 as "no data" (caller will set to 0)
      if (res.status === 404) {
        const bodyText = await res.text().catch(() => "");
        return { status: 404, json: null, bodyText };
      }

      // Backoff for rate limits / transient server errors
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(15_000, 700 * Math.pow(2, i));
        process.stdout.write(".");
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = await res.json();
      return { status: res.status, json, bodyText: null };
    } catch (e) {
      lastErr = e;
      const wait = Math.min(15_000, 700 * Math.pow(2, i));
      process.stdout.write(".");
      await sleep(wait);
    }
  }

  throw lastErr || new Error("fetch failed");
}

async function getViews365(title) {
  // last 365 days ending yesterday (avoid partial today)
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364);

  const startYMD = isoYMD(start);
  const endYMD = isoYMD(end);

  const encodedTitle = encodeURIComponent(title);

  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodedTitle}/daily/${startYMD}/${endYMD}`;

  const { status, json, bodyText } = await fetchJsonWithRetry(url, {
    headers: {
      "User-Agent": "death-atlas/1.0 (fill_pageviews_365)",
      Accept: "application/json",
    },
  });

  if (status === 404) {
    return { views: 0, is404: true, detail: bodyText || null };
  }

  const items = Array.isArray(json?.items) ? json.items : [];
  let sum = 0;
  for (const it of items) {
    const v = Number(it?.views || 0);
    if (Number.isFinite(v)) sum += v;
  }

  return { views: sum, is404: false, detail: null };
}

function pickTitle(row) {
  return (
    normalizeWikiTitle(row?.enwiki_title) ||
    normalizeWikiTitle(row?.wikipedia_url) ||
    normalizeWikiTitle(row?.title) ||
    null
  );
}

async function updateRow(id, views365) {
  const payload = {
    pageviews_365d: views365,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from(TABLE).update(payload).eq("id", id);
  if (error) throw error;
}

/**
 * ONLY fetch rows that still need pageviews:
 *   pageviews_365d IS NULL
 *   AND (enwiki_title IS NOT NULL OR wikipedia_url IS NOT NULL)
 *
 * NOTE: We page over THIS FILTERED SET using .range(from,to).
 */
async function safeDbRead(rangeFrom, rangeTo) {
  const selectCols = "id,enwiki_title,wikipedia_url,title,pageviews_365d";
  let lastErr = null;

  for (let i = 0; i <= DB_READ_RETRIES; i++) {
    try {
      const { data, error } = await supabase
        .from(TABLE)
        .select(selectCols)
        .is("pageviews_365d", null)
        .or("enwiki_title.not.is.null,wikipedia_url.not.is.null")
        .order("id", { ascending: true })
        .range(rangeFrom, rangeTo);

      if (error) throw error;
      return data || [];
    } catch (e) {
      lastErr = e;
      const wait = DB_READ_RETRY_MS * (i + 1);
      console.log(
        `\nDB read failed (attempt ${i + 1}/${DB_READ_RETRIES + 1}): ${
          e?.message || e
        }. Waiting ${wait}ms...`
      );
      await sleep(wait);
    }
  }

  throw lastErr || new Error("DB read failed repeatedly");
}

async function workerLoop(workerId, queue, stats, globalLog) {
  while (true) {
    const job = queue.shift();
    if (!job) return;

    const { id, row } = job;

    try {
      const title = pickTitle(row);
      if (!title) {
        // Should be rare now, but keep it safe
        stats.skipped_no_title++;
        continue;
      }

      await sleep(MIN_DELAY_MS);

      const { views, is404 } = await getViews365(title);
      if (is404) stats.pageviews_404_as_zero++;

      await updateRow(id, views);

      stats.updated++;
      globalLog.updated_total++;

      if (
        workerId === 1 &&
        (globalLog.updated_total % LOG_EVERY === 0 || LOG_EVERY <= 1)
      ) {
        console.log(
          `\nok: ${id} | ${title} | pageviews_365d=${views} | total_updated=${globalLog.updated_total}`
        );
      }
    } catch (e) {
      stats.errors++;
      console.log(`\nworker ${workerId}: update failed at id ${id}`, {
        code: e?.code || null,
        details: e?.details || null,
        hint: e?.hint || null,
        message: e?.message || String(e),
      });
    }
  }
}

async function main() {
  console.log("Starting (filtered to missing rows only)");

  let offset = START_OFFSET;
  let processed = 0;

  const globalLog = { updated_total: 0 };

  while (true) {
    if (MAX_ROWS > 0 && processed >= MAX_ROWS) {
      console.log(`Reached MAX_ROWS=${MAX_ROWS}, stopping.`);
      break;
    }

    const from = offset;
    const to = offset + DB_BATCH - 1;

    let batch;
    try {
      batch = await safeDbRead(from, to);
    } catch (e) {
      console.log(`\nFatal DB read error after retries: ${e?.message || e}`);
      console.log(
        "Stopping without losing progress. Re-run with START_OFFSET set to the last printed offset."
      );
      process.exit(1);
    }

    if (!batch || batch.length === 0) {
      console.log("\nNo more eligible rows. Done.");
      break;
    }

    offset += batch.length;

    const remainingAllowed =
      MAX_ROWS > 0 ? Math.max(0, MAX_ROWS - processed) : batch.length;
    const slice = MAX_ROWS > 0 ? batch.slice(0, remainingAllowed) : batch;

    processed += slice.length;

    const queue = slice.map((row) => ({ id: row.id, row }));

    const stats = {
      skipped_no_title: 0,
      pageviews_404_as_zero: 0,
      updated: 0,
      errors: 0,
    };

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(workerLoop(i + 1, queue, stats, globalLog));
    }
    await Promise.all(workers);

    console.log(
      `\nbatch done | offset=${offset} | processed=${processed} | batch=${slice.length}` +
        ` | updated=${stats.updated}` +
        ` | 404_as_zero=${stats.pageviews_404_as_zero}` +
        ` | skipped_no_title=${stats.skipped_no_title}` +
        ` | errors=${stats.errors}`
    );

    if (MAX_ROWS > 0 && processed >= MAX_ROWS) {
      console.log(`Reached MAX_ROWS=${MAX_ROWS}, stopping.`);
      break;
    }
  }
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
