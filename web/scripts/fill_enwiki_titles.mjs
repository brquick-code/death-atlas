/**
 * Fill enwiki_title + wikipedia_url for death_locations
 * using Wikidata API (NO SPARQL).
 *
 * IMPORTANT:
 * - Uses UPDATE only (no UPSERT)
 * - Safe for tables with NOT NULL columns like `title`
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   QID_COL=wikidata_qid
 *   START_AFTER_ID=...
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QID_COL = process.env.QID_COL || "wikidata_qid";
const TABLE = "death_locations";
const ID_COL = "id";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DB_BATCH = 1000;
const WD_BATCH = 50;
const THROTTLE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeQid(v) {
  if (!v) return null;
  const m = String(v).match(/Q\d+/);
  return m ? m[0] : null;
}

function wikiUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(
    title.replace(/ /g, "_")
  )}`;
}

async function fetchEnwiki(qids) {
  const ids = qids.join("|");
  const url =
    `https://www.wikidata.org/w/api.php?action=wbgetentities` +
    `&format=json&props=sitelinks&sitefilter=enwiki&ids=${ids}&origin=*`;

  const res = await fetch(url, {
    headers: { "User-Agent": "DeathAtlasEnwikiFill/1.0" },
  });

  if (!res.ok) return {};
  const json = await res.json();
  return json.entities || {};
}

async function main() {
  let lastId = process.env.START_AFTER_ID || null;
  let scanned = 0;
  let updated = 0;

  console.log(
    `Table=${TABLE} | QID_COL=${QID_COL} | starting ${
      lastId ? "after " + lastId : "from beginning"
    }`
  );

  while (true) {
    let q = supabase
      .from(TABLE)
      .select(`${ID_COL},${QID_COL},enwiki_title`)
      .order(ID_COL, { ascending: true })
      .limit(DB_BATCH);

    if (lastId) q = q.gt(ID_COL, lastId);

    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    scanned += data.length;
    lastId = data[data.length - 1][ID_COL];

    const missing = data
      .filter((r) => !r.enwiki_title)
      .map((r) => ({ id: r.id, qid: normalizeQid(r[QID_COL]) }))
      .filter((r) => r.qid);

    if (missing.length === 0) {
      console.log(`Scanned ${scanned}; updated ${updated}`);
      continue;
    }

    const qids = [...new Set(missing.map((m) => m.qid))];
    const idByQid = new Map(missing.map((m) => [m.qid, m.id]));

    for (let i = 0; i < qids.length; i += WD_BATCH) {
      const chunk = qids.slice(i, i + WD_BATCH);
      const entities = await fetchEnwiki(chunk);

      for (const qid of chunk) {
        const title = entities[qid]?.sitelinks?.enwiki?.title;
        if (!title) continue;

        const id = idByQid.get(qid);
        if (!id) continue;

        const { error: upErr } = await supabase
          .from(TABLE)
          .update({
            enwiki_title: title,
            wikipedia_url: wikiUrl(title),
          })
          .eq(ID_COL, id);

        if (!upErr) updated++;
      }

      await sleep(THROTTLE_MS);
    }

    console.log(
      `Scanned ${scanned}; updated ${updated}; lastId=${lastId}`
    );
  }

  console.log("DONE");
  console.log("Resume with:");
  console.log(`START_AFTER_ID=${lastId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
