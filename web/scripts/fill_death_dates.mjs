/**
 * Fill death_date + death_year using Wikidata API claims (P570).
 *
 * Requires:
 *   npm i @supabase/supabase-js
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   TABLE=death_locations
 *   QID_COL=wikidata_qid
 *   START_AFTER_ID=...
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TABLE = process.env.TABLE || "death_locations";
const QID_COL = process.env.QID_COL || "wikidata_qid";
const ID_COL = "id";

const DB_BATCH = 1000;
const WD_BATCH = 50; // max 50 for wbgetentities
const THROTTLE_MS = 250;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeQid(v) {
  if (!v) return null;
  const m = String(v).match(/Q\d+/);
  return m ? m[0] : null;
}

function parseWikidataTimeToISODate(wdTime) {
  // wdTime like "+1984-10-12T00:00:00Z"
  if (!wdTime || typeof wdTime !== "string") return null;
  const m = wdTime.match(/^[+-]?(\d{1,})-(\d{2})-(\d{2})T/);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  // Supabase/Postgres DATE needs YYYY-MM-DD (year padded to 4+ digits)
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchDeathDates(qids) {
  const ids = qids.join("|");
  const url =
    `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json` +
    `&props=claims&ids=${encodeURIComponent(ids)}&origin=*`;

  let tries = 0;
  while (tries < 6) {
    tries += 1;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "DeathAtlasDeathDateFill/1.0 (local script)",
        "Accept": "application/json",
      },
    });

    if (res.status === 429 || res.status === 503) {
      const backoff = Math.min(30000, 1000 * Math.pow(2, tries));
      await sleep(backoff);
      continue;
    }

    if (!res.ok) return {};

    const json = await res.json();
    return json.entities || {};
  }

  return {};
}

async function main() {
  let lastId = process.env.START_AFTER_ID || null;
  let scanned = 0;
  let updated = 0;

  console.log(`Table=${TABLE} | QID_COL=${QID_COL} | start ${lastId ? "after " + lastId : "beginning"}`);

  while (true) {
    let q = supabase
      .from(TABLE)
      .select(`${ID_COL},${QID_COL},death_date,death_year`)
      .order(ID_COL, { ascending: true })
      .limit(DB_BATCH);

    if (lastId) q = q.gt(ID_COL, lastId);

    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    scanned += data.length;
    lastId = data[data.length - 1][ID_COL];

    // only rows missing death_date AND having a QID
    const missing = data
      .filter((r) => !r.death_date)
      .map((r) => ({ id: r.id, qid: normalizeQid(r[QID_COL]) }))
      .filter((x) => x.qid);

    if (missing.length === 0) {
      console.log(`Scanned ${scanned}; updated ${updated}; lastId=${lastId}`);
      continue;
    }

    const qids = [...new Set(missing.map((m) => m.qid))];
    const idByQid = new Map(missing.map((m) => [m.qid, m.id]));

    for (let i = 0; i < qids.length; i += WD_BATCH) {
      const chunk = qids.slice(i, i + WD_BATCH);
      const entities = await fetchDeathDates(chunk);

      for (const qid of chunk) {
        const ent = entities[qid];
        const claims = ent?.claims;
        const p570 = claims?.P570;
        if (!p570 || !Array.isArray(p570) || p570.length === 0) continue;

        const time = p570?.[0]?.mainsnak?.datavalue?.value?.time;
        const isoDate = parseWikidataTimeToISODate(time);
        if (!isoDate) continue;

        const year = Number(isoDate.slice(0, 4));
        const id = idByQid.get(qid);
        if (!id) continue;

        const { error: upErr } = await supabase
          .from(TABLE)
          .update({ death_date: isoDate, death_year: year })
          .eq(ID_COL, id);

        if (!upErr) updated++;
      }

      await sleep(THROTTLE_MS);
    }

    console.log(`Scanned ${scanned}; updated ${updated}; lastId=${lastId}`);
  }

  console.log("DONE");
  console.log("Resume with (PowerShell):");
  console.log(`$env:START_AFTER_ID="${lastId}"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
