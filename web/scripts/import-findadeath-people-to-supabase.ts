/**
 * Route 1 importer:
 * Import FindADeath "people" entries into Supabase without Wikidata.
 *
 * Inputs:
 *   findadeath-people-leads.json  (produced by classify-findadeath-people.ts)
 *
 * Writes to:
 *   TABLE (default: death_locations)
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   TABLE=death_locations
 *   IN_LEADS=findadeath-people-leads.json
 *   BATCH=200
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

type Lead = {
  name: string;
  url: string;
  birthYear: number | null;
  deathYear: number | null;
  source: "findadeath";
  sourceUrl: string; // directory page
};

type Row = Record<string, any>;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const TABLE = process.env.TABLE || "death_locations";
const IN_LEADS = process.env.IN_LEADS || "findadeath-people-leads.json";
const BATCH = Math.max(1, Number(process.env.BATCH || "200"));

const supabaseUrl: string = SUPABASE_URL;
const supabaseServiceKey: string = SUPABASE_SERVICE_ROLE_KEY;

function clean(s: string): string {
  return s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function detectTableColumns(): Promise<Set<string>> {
  // Uses REST to fetch 1 row and infer columns.
  // If table is empty, we fall back to a minimal set.
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
  if (Array.isArray(json) && json.length > 0 && json[0] && typeof json[0] === "object") {
    return new Set(Object.keys(json[0]));
  }

  // table empty fallback (minimum we know you have based on earlier errors)
  return new Set(["title", "type", "source_url"]);
}

function filterRowToColumns(row: Row, allowed: Set<string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

function buildRowFromLead(lead: Lead, allowed: Set<string>): Row {
  // Required by your schema (based on prior errors):
  const base: Row = {
    title: clean(lead.name) || lead.url,
    type: "person",
    source_url: lead.url,
  };

  // Nice-to-have fields, only if they exist
  // (We keep this conservative so we don't fight schema.)
  if (allowed.has("source")) base.source = "findadeath";
  if (allowed.has("source_note"))
    base.source_note = `Imported from FindADeath directory (people-only classifier). Directory: ${lead.sourceUrl}`;

  // If you have “external” fields, populate them
  if (allowed.has("external_source")) base.external_source = "findadeath";
  if (allowed.has("external_url")) base.external_url = lead.url;
  if (allowed.has("external_id")) base.external_id = lead.url;

  // Years if your schema has them
  if (allowed.has("birth_year")) base.birth_year = lead.birthYear;
  if (allowed.has("death_year")) base.death_year = lead.deathYear;

  // Sometimes people store the raw name separately
  if (allowed.has("person_label")) base.person_label = clean(lead.name);

  // For your app logic: unknown coords / not yet enriched
  if (allowed.has("coord_source")) base.coord_source = "unknown";

  return filterRowToColumns(base, allowed);
}

async function insertBatch(supabase: any, rows: Row[]) {
  const { error } = await supabase.from(TABLE).insert(rows as any);
  if (!error) return;

  // If batch insert fails, fall back to per-row so we can skip duplicates
  throw error;
}

async function insertOneSkipDuplicates(supabase: any, row: Row): Promise<"inserted" | "duplicate_skipped"> {
  const { error } = await supabase.from(TABLE).insert(row as any);

  if (!error) return "inserted";

  // Duplicate key / unique violation
  // Supabase/PostgREST usually returns code 23505 for unique violations
  if ((error as any).code === "23505") return "duplicate_skipped";

  throw error;
}

async function main() {
  const inPath = path.join(process.cwd(), IN_LEADS);
  const raw = await fs.readFile(inPath, "utf8");
  const leads: Lead[] = JSON.parse(raw);

  console.log(`Loaded ${leads.length} leads from ${path.basename(inPath)}`);
  console.log(`Importing into table="${TABLE}" (Route 1: FindADeath-only, no Wikidata)`);

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  console.log("Detecting table columns...");
  const allowedCols = await detectTableColumns();
  console.log(`Detected ${allowedCols.size} column(s).`);

  const rowsAll = leads.map((l) => buildRowFromLead(l, allowedCols));

  // Basic sanity
  for (const r of rowsAll) {
    if (!r.title) r.title = "Unknown";
    if (!r.type) r.type = "person";
    if (!r.source_url) r.source_url = "https://findadeath.com/";
  }

  console.log(`Built ${rowsAll.length} row payloads.`);

  let inserted = 0;
  let dupes = 0;

  // Try batched inserts first for speed
  for (let i = 0; i < rowsAll.length; i += BATCH) {
    const chunk = rowsAll.slice(i, i + BATCH);
    try {
      await insertBatch(supabase as any, chunk);
      inserted += chunk.length;
      console.log(`Inserted ${Math.min(i + BATCH, rowsAll.length)}/${rowsAll.length}...`);
    } catch (e: any) {
      const code = e?.code || e?.details || e?.message || String(e);
      console.log(`Batch insert failed (will fall back to per-row for this chunk). Reason: ${code}`);

      // Per-row fallback: skip duplicates rather than crash
      for (const row of chunk) {
        const r = await insertOneSkipDuplicates(supabase as any, row);
        if (r === "inserted") inserted++;
        else dupes++;
      }

      console.log(`Progress ${Math.min(i + BATCH, rowsAll.length)}/${rowsAll.length} (inserted=${inserted} dupes_skipped=${dupes})...`);
    }
  }

  console.log("Done.");
  console.log(`Inserted: ${inserted}`);
  console.log(`Duplicates skipped: ${dupes}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
