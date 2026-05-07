/**
 * Import verified "dead human" QIDs into Supabase death_locations.
 * Schema-safe + handles NOT NULL constraints + handles BOTH unique constraints
 * by doing per-row upserts with automatic retry.
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   TABLE=death_locations
 *   CONCURRENCY=3
 *   MIN_DELAY_MS=250
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

type WikidataEntityDoc = { entities: Record<string, any> };
type Row = Record<string, any>;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const supabaseUrl: string = SUPABASE_URL;
const supabaseServiceKey: string = SUPABASE_SERVICE_ROLE_KEY;

const TABLE = process.env.TABLE || "death_locations";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || "3"));
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "250");

const IN_QIDS = path.join(process.cwd(), "seeing-stars-died-qids.json");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "death-atlas-bot/1.0 (entitydata importer)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

function getEnLabel(entity: any): string | null {
  return entity?.labels?.en?.value || null;
}

function getEnWikiTitle(entity: any): string | null {
  return entity?.sitelinks?.enwiki?.title || null;
}

function hasInstanceOfHuman(entity: any): boolean {
  const claims = entity?.claims?.P31;
  if (!Array.isArray(claims)) return false;
  return claims.some((c: any) => c?.mainsnak?.datavalue?.value?.id === "Q5");
}

function getTimeClaim(entity: any, pid: string): string | null {
  const claims = entity?.claims?.[pid];
  if (!Array.isArray(claims) || !claims.length) return null;
  const time = claims[0]?.mainsnak?.datavalue?.value?.time as string | undefined;
  if (!time) return null;
  return time.replace(/^\+/, "");
}

function getFirstEntityIdClaim(entity: any, pid: string): string | null {
  const claims = entity?.claims?.[pid];
  if (!Array.isArray(claims) || !claims.length) return null;
  const v = claims[0]?.mainsnak?.datavalue?.value;
  const id = v?.id as string | undefined;
  return id || null;
}

function getFirstGlobeCoord(entity: any, pid: string): { lat: number; lon: number } | null {
  const claims = entity?.claims?.[pid];
  if (!Array.isArray(claims) || !claims.length) return null;
  const v = claims[0]?.mainsnak?.datavalue?.value;
  const lat = v?.latitude;
  const lon = v?.longitude;
  if (typeof lat === "number" && typeof lon === "number") return { lat, lon };
  return null;
}

async function getEntity(qid: string): Promise<any> {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  const doc = await fetchJson<WikidataEntityDoc>(url);
  return doc?.entities?.[qid];
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

async function detectTableColumns(): Promise<Set<string>> {
  const url = `${supabaseUrl}/rest/v1/${encodeURIComponent(TABLE)}?select=*&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to detect columns: HTTP ${res.status} ${res.statusText}\n${text}`);
  }

  const json = (await res.json()) as any[];
  if (Array.isArray(json) && json.length > 0 && typeof json[0] === "object" && json[0]) {
    return new Set(Object.keys(json[0]));
  }

  // table empty fallback
  return new Set(["wikidata_id", "wikidata_qid", "title", "type", "source_url"]);
}

function filterRowToColumns(row: Row, allowed: Set<string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

async function buildRowForQid(qid: string): Promise<Row | null> {
  await sleep(MIN_DELAY_MS);
  const person = await getEntity(qid);
  if (!person) return null;

  if (!hasInstanceOfHuman(person)) return null;

  const deathDate = getTimeClaim(person, "P570");
  if (!deathDate) return null;

  const personLabel = getEnLabel(person);
  const wikipediaTitle = getEnWikiTitle(person);

  const bestTitle = personLabel || wikipediaTitle || qid;
  const wikidataUrl = `https://www.wikidata.org/wiki/${qid}`;

  const deathPlaceQid = getFirstEntityIdClaim(person, "P20");
  const burialPlaceQid = getFirstEntityIdClaim(person, "P119");

  let deathPlaceLabel: string | null = null;
  let deathCoord: { lat: number; lon: number } | null = null;

  if (deathPlaceQid) {
    await sleep(MIN_DELAY_MS);
    const deathPlace = await getEntity(deathPlaceQid);
    if (deathPlace) {
      deathPlaceLabel = getEnLabel(deathPlace);
      deathCoord = getFirstGlobeCoord(deathPlace, "P625");
    }
  }

  if (!deathCoord) {
    const personCoord = getFirstGlobeCoord(person, "P625");
    if (personCoord) deathCoord = personCoord;
  }

  let burialPlaceLabel: string | null = null;
  let burialCoord: { lat: number; lon: number } | null = null;

  if (burialPlaceQid) {
    await sleep(MIN_DELAY_MS);
    const burialPlace = await getEntity(burialPlaceQid);
    if (burialPlace) {
      burialPlaceLabel = getEnLabel(burialPlace);
      burialCoord = getFirstGlobeCoord(burialPlace, "P625");
    }
  }

  let coord_source: string = "unknown";
  let latitude: number | null = null;
  let longitude: number | null = null;
  let burial_latitude: number | null = null;
  let burial_longitude: number | null = null;

  if (deathCoord) {
    coord_source = "death";
    latitude = deathCoord.lat;
    longitude = deathCoord.lon;
  } else if (burialCoord) {
    coord_source = "burial";
  }

  if (burialCoord) {
    burial_latitude = burialCoord.lat;
    burial_longitude = burialCoord.lon;
  }

  return {
    // required (learned from your schema)
    title: bestTitle,
    type: "person",
    source_url: wikidataUrl,

    // ids (both unique in your table)
    wikidata_id: qid,
    wikidata_qid: qid,

    // useful fields
    person_label: personLabel,
    wikipedia_title: wikipediaTitle,
    death_date: deathDate,
    death_place_label: deathPlaceLabel,
    latitude,
    longitude,
    burial_place_label: burialPlaceLabel,
    burial_latitude,
    burial_longitude,
    coord_source,
    source: "wikidata",
    source_note: "Seeded from Seeing-Stars leads; verified + enriched via Wikidata",
  };
}
async function getRowIdByKey(supabase: any, col: "wikidata_id" | "wikidata_qid", qid: string) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id")
    .eq(col, qid)
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data[0].id as string;
}

async function updateByUuidId(supabase: any, id: string, patch: Row) {
  const { error } = await supabase
    .from(TABLE)
    .update(patch as any)
    .eq("id", id);

  if (error) throw error;
}

/**
 * Upsert ONE row, retrying on the other conflict column if we hit a unique violation.
 */
async function upsertOneWithRetry(
  supabase: any,
  row: Row,
  hasId: boolean,
  hasQid: boolean
) {
  const qid = String(row.wikidata_id || row.wikidata_qid || "");

  const primary = hasId ? "wikidata_id" : "wikidata_qid";
  const secondary = primary === "wikidata_id" ? "wikidata_qid" : "wikidata_id";

  const doUpsert = async (conflictCol: string, payload: Row) => {
    const { error } = await supabase.from(TABLE).upsert(payload as any, { onConflict: conflictCol });
    return error || null;
  };

  // Attempt 1
  let err = await doUpsert(primary, row);
  if (!err) return;

  // Non-unique errors: stop
  if (err.code !== "23505") throw err;

  // Attempt 2 (swap conflict key)
  if ((secondary === "wikidata_id" && !hasId) || (secondary === "wikidata_qid" && !hasQid)) {
    throw err;
  }

  err = await doUpsert(secondary, row);
  if (!err) return;

  // If second attempt is NOT unique, stop
  if (err.code !== "23505") throw err;

  // ✅ Double-unique collision:
  // - one row already has wikidata_id=Qxxx
  // - another row already has wikidata_qid=Qxxx
  //
  // We cannot insert/update a row containing BOTH keys without violating one.
  // So: update the row found by wikidata_id (preferred), else by wikidata_qid,
  // and OMIT setting the *other* key in the patch.
  //
  // This lets the import complete without breaking constraints.
  const idRowId = hasId ? await getRowIdByKey(supabase, "wikidata_id", qid) : null;
  const qidRowId = hasQid ? await getRowIdByKey(supabase, "wikidata_qid", qid) : null;

  if (!idRowId && !qidRowId) {
    throw new Error(
      `Double-unique collision for ${qid}, but couldn't find either row by wikidata_id or wikidata_qid`
    );
  }

  // Choose target row: prefer wikidata_id row (more "canonical" in your schema)
  const targetId = idRowId || qidRowId;

  // Build patch that avoids touching the conflicting key
  const patch: Row = { ...row };

  if (targetId === idRowId) {
    // We are updating the row that already owns wikidata_id=Qxxx
    // Don't set wikidata_qid (it belongs to someone else currently)
    delete patch.wikidata_qid;
  } else {
    // Updating the row that already owns wikidata_qid=Qxxx
    // Don't set wikidata_id
    delete patch.wikidata_id;
  }

  await updateByUuidId(supabase, targetId!, patch);
}


async function main() {
  const raw = await fs.readFile(IN_QIDS, "utf8");
  const qids: string[] = JSON.parse(raw);

  console.log(`Loaded ${qids.length} QIDs from ${path.basename(IN_QIDS)}`);
  console.log(`Importing into table="${TABLE}" CONCURRENCY=${CONCURRENCY} MIN_DELAY_MS=${MIN_DELAY_MS}`);

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  console.log("Detecting table columns...");
  const allowedCols = await detectTableColumns();
  console.log(`Detected ${allowedCols.size} column(s).`);

  const hasWikidataId = allowedCols.has("wikidata_id");
  const hasWikidataQid = allowedCols.has("wikidata_qid");

  if (!hasWikidataId && !hasWikidataQid) {
    console.error(`Neither wikidata_id nor wikidata_qid exists in ${TABLE}. Can't upsert safely.`);
    process.exit(1);
  }

  // Build rows
  const built = await workerPool(qids, CONCURRENCY, async (qid, idx) => {
    if (idx % 5 === 0) console.log(`Building rows ${idx}/${qids.length}...`);
    try {
      const row = await buildRowForQid(qid);
      if (!row) return { ok: false as const, qid, reason: "no_row_built" };

      // ensure required fields
      row.title = row.title || qid;
      row.type = row.type || "person";
      row.source_url = row.source_url || `https://www.wikidata.org/wiki/${qid}`;
      row.wikidata_id = row.wikidata_id || qid;
      row.wikidata_qid = row.wikidata_qid || qid;

      const filtered = filterRowToColumns(row, allowedCols);
      return { ok: true as const, qid, row: filtered };
    } catch (e: any) {
      return { ok: false as const, qid, reason: e?.message || String(e) };
    }
  });

  const rowsAll: { qid: string; row: Row }[] = built
    .filter((x: any) => x.ok)
    .map((x: any) => ({ qid: x.qid as string, row: x.row as Row }));

  const rejected = built.filter((x: any) => !x.ok);

  console.log(`Built ${rowsAll.length} row payloads. Rejected ${rejected.length}.`);

  if (rowsAll.length === 0) {
    console.error("No rows to upsert. Exiting.");
    process.exit(1);
  }

  // Upsert rows one-by-one with retry (20 rows -> totally fine)
  let okCount = 0;
  for (const { qid, row } of rowsAll) {
    try {
      await upsertOneWithRetry(supabase as any, row, hasWikidataId, hasWikidataQid);
      okCount++;
      console.log(`Upsert OK ${okCount}/${rowsAll.length}: ${qid}`);
    } catch (e: any) {
      console.error(`Upsert FAILED for ${qid}:`, e?.message || e);
      process.exit(1);
    }
  }

  console.log("Done.");

  if (rejected.length) {
    console.log("Rejected QIDs:");
    for (const r of rejected) console.log(` - ${r.qid}: ${(r as any).reason}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
