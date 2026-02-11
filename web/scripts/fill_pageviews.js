/**
 * Fill Wikipedia pageviews for rows in Supabase using wikipedia_url.
 *
 * Requirements:
 *   npm i @supabase/supabase-js
 *
 * Env vars (set these):
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...   (recommended so RLS doesn't block updates)
 *
 * Optional env vars:
 *   BATCH_SIZE=200
 *   THROTTLE_MS=250
 *   START_OFFSET=0
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TABLE = "death_locations";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 250);
const START_OFFSET = Number(process.env.START_OFFSET || 0);

// Pageviews API endpoints:
//  - 30 days: daily totals for last 30 complete days
//  - 365 days: daily totals for last 365 complete days
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function yyyymmddUTC(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function getDateRange(days) {
  // Wikimedia wants date range inclusive, and "complete days" are safer.
  // End: yesterday UTC. Start: (yesterday - (days-1))
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  end.setUTCHours(0, 0, 0, 0);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return { start: yyyymmddUTC(start), end: yyyymmddUTC(end) };
}

function extractWikipediaTitle(url) {
  try {
    const u = new URL(url);
    // common forms:
    //  https://en.wikipedia.org/wiki/Some_Title
    //  https://en.wikipedia.org/wiki/Some_Title#Section
    //  https://en.wikipedia.org/wiki/Some_Title?...
    const parts = u.pathname.split("/");
    const wikiIndex = parts.indexOf("wiki");
    if (wikiIndex >= 0 && parts[wikiIndex + 1]) {
      const raw = parts[wikiIndex + 1];
      const noFragment = raw.split("#")[0];
      // decode %XX and keep underscores (API expects title with underscores)
      return decodeURIComponent(noFragment);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchPageviewsSum(title, days) {
  const { start, end } = getDateRange(days);
  const encodedTitle = encodeURIComponent(title);

  const api = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodedTitle}/daily/${start}/${end}`;

  let tries = 0;
  while (tries < 6) {
    tries += 1;
    const res = await fetch(api, {
      headers: {
        "User-Agent": "DeathAtlasPageviews/1.0 (contact: local-script)",
        "Accept": "application/json",
      },
    });

    if (res.status === 429 || res.status === 503) {
      // Back off if we’re rate-limited or service is busy
      const backoff = Math.min(30000, 1000 * Math.pow(2, tries));
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      // 404 for missing pages etc.
      return null;
    }

    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    const sum = items.reduce((acc, it) => acc + (it?.views || 0), 0);
    return sum;
  }

  return null;
}

async function main() {
  console.log(`Starting pageviews fill. batch=${BATCH_SIZE} throttle=${THROTTLE_MS}ms offset=${START_OFFSET}`);

  let offset = START_OFFSET;
  let totalUpdated = 0;

  while (true) {
    // Pull rows that need pageviews (either null) and have a wikipedia_url
    const { data: rows, error } = await supabase
      .from(TABLE)
      .select("id,wikipedia_url,pageviews_30d,pageviews_365d")
      .not("wikipedia_url", "is", null)
      .or("pageviews_30d.is.null,pageviews_365d.is.null")
      .order("id", { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) throw error;
    if (!rows || rows.length === 0) {
      console.log("No more rows in this range. Done.");
      break;
    }

    console.log(`Fetched ${rows.length} rows (offset ${offset}).`);

    for (const r of rows) {
      const title = extractWikipediaTitle(r.wikipedia_url);
      if (!title) {
        // nothing to do
        continue;
      }

      // Only fetch missing values
      const pv30 = (r.pageviews_30d == null) ? await fetchPageviewsSum(title, 30) : r.pageviews_30d;
      await sleep(THROTTLE_MS);

      const pv365 = (r.pageviews_365d == null) ? await fetchPageviewsSum(title, 365) : r.pageviews_365d;
      await sleep(THROTTLE_MS);

      // If both are null, skip updating
      if (pv30 == null && pv365 == null) continue;

      const { error: upErr } = await supabase
        .from(TABLE)
        .update({
          pageviews_30d: pv30 ?? r.pageviews_30d,
          pageviews_365d: pv365 ?? r.pageviews_365d,
        })
        .eq("id", r.id);

      if (upErr) {
        console.warn("Update failed for id", r.id, upErr.message);
      } else {
        totalUpdated += 1;
        if (totalUpdated % 50 === 0) console.log(`Updated ${totalUpdated} rows so far...`);
      }

      // small pause to avoid spiky DB writes too
      await sleep(THROTTLE_MS);
    }

    offset += rows.length;
  }

  console.log(`Finished. Updated rows: ${totalUpdated}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
