// scripts/fill-death-from-wikipedia.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import wtf from "wtf_wikipedia";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  console.error("PowerShell example:");
  console.error('$env:SUPABASE_URL="https://xxxx.supabase.co"');
  console.error('$env:SUPABASE_SERVICE_ROLE_KEY="xxxx"');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const USER_AGENT =
  process.env.USER_AGENT || "DeathAtlasWikiFill/1.0 (contact: you@example.com)";

const BATCH = Number(process.env.BATCH || "200");
const CONCURRENCY = Number(process.env.CONCURRENCY || "6");
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "250");
const MAX_RETRIES = Number(process.env.MAX_RETRIES || "8");

const MW_API = "https://en.wikipedia.org/w/api.php";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetries<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const wait = Math.min(30000, 800 * attempt * attempt);
      console.warn(`${label} failed (attempt ${attempt}/${MAX_RETRIES}): ${String(e?.message ?? e)}`);
      console.warn(`Waiting ${wait}ms...`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function pingSupabase() {
  // Tiny request to prove network + credentials are good
  return await withRetries(async () => {
    const { error } = await supabase.from("death_locations").select("id").limit(1);
    if (error) throw new Error(`Supabase ping error: ${error.message}`);
    return true;
  }, "Supabase ping");
}

function sanitizeEnwikiTitle(t: string) {
  return t.replace(/ /g, "_");
}

async function fetchWikitext(enwikiTitle: string): Promise<string | null> {
  const title = sanitizeEnwikiTitle(enwikiTitle);

  const url = new URL(MW_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("rvprop", "content");
  url.searchParams.set("rvslots", "main");
  url.searchParams.set("titles", title);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const page = json?.query?.pages?.[0];
  const content = page?.revisions?.[0]?.slots?.main?.content;

  return typeof content === "string" ? content : null;
}

function stripRefs(s: string) {
  return s
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref[^\/]*\/\s*>/gi, "");
}

function stripTemplates(s: string) {
  return s.replace(/\{\{[^}]+\}\}/g, "");
}

function stripWikiLinks(s: string) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1");
}

function normalizeDeathDate(raw: string): string {
  let s = raw.trim();
  s = stripRefs(s);

  s = s.replace(/\{\{\s*death date and age\s*\|([^}]+)\}\}/gi, (_m, inner) => {
    const parts = inner.split("|").map((p: string) => p.trim());
    const y = parts[0], mo = parts[1], d = parts[2];
    if (y && mo && d) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return `${y || ""}`.trim();
  });

  s = s.replace(/\{\{\s*death date\s*\|([^}]+)\}\}/gi, (_m, inner) => {
    const parts = inner.split("|").map((p: string) => p.trim());
    const y = parts[0], mo = parts[1], d = parts[2];
    if (y && mo && d) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return `${y || ""}`.trim();
  });

  s = stripTemplates(s);
  s = stripWikiLinks(s);
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function normalizePlace(raw: string): string {
  let s = raw.trim();
  s = stripRefs(s);
  s = stripTemplates(s);
  s = stripWikiLinks(s);
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function asText(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v.text === "function") return v.text();
  try {
    return String(v);
  } catch {
    return "";
  }
}

function extractFromInfobox(wikitext: string): { deathDate?: string; deathPlace?: string } {
  const doc: any = wtf(wikitext);
  const boxes: any[] = doc?.infoboxes?.() ?? [];
  const box: any = boxes[0];
  if (!box) return {};

  const get = (key: string) => {
    try {
      return asText(box.get(key));
    } catch {
      return "";
    }
  };

  const rawDeathDate = get("death_date") || get("death date") || get("died");
  const rawDeathPlace = get("death_place") || get("death place") || get("place of death");

  const out: any = {};
  if (rawDeathDate && rawDeathDate.trim()) out.deathDate = normalizeDeathDate(rawDeathDate);
  if (rawDeathPlace && rawDeathPlace.trim()) out.deathPlace = normalizePlace(rawDeathPlace);

  return out;
}

async function getBatch(offset: number) {
  return await withRetries(async () => {
    const { data, error } = await supabase
      .from("death_locations")
      .select("id,enwiki_title,death_date_wiki,death_place_wiki")
      .not("enwiki_title", "is", null)
      .is("death_date_wiki", null)
      .range(offset, offset + BATCH - 1);

    if (error) throw new Error(`Supabase select error: ${error.message}`);
    return (data ?? []) as any[];
  }, "Supabase select batch");
}

async function updateRow(id: string | number, patch: any) {
  return await withRetries(async () => {
    const { error } = await supabase.from("death_locations").update(patch).eq("id", id);
    if (error) throw new Error(`Update failed for ${id}: ${error.message}`);
    return true;
  }, `Supabase update ${id}`);
}

async function worker(queue: any[]) {
  while (queue.length) {
    const row = queue.pop();
    if (!row) continue;

    const id = row.id;
    const enwikiTitle = row.enwiki_title as string | null;
    if (!enwikiTitle) continue;

    try {
      const wikitext = await withRetries(
        async () => await fetchWikitext(enwikiTitle),
        `Wikipedia fetch ${enwikiTitle}`
      );

      if (!wikitext) {
        await sleep(MIN_DELAY_MS);
        continue;
      }

      const extracted = extractFromInfobox(wikitext);

      const patch: any = { wiki_extracted_at: new Date().toISOString() };
      if (extracted.deathDate) patch.death_date_wiki = extracted.deathDate;
      if (extracted.deathPlace) patch.death_place_wiki = extracted.deathPlace;

      if (patch.death_date_wiki || patch.death_place_wiki) {
        await updateRow(id, patch);
      }
    } catch (e: any) {
      console.warn(`Row ${id} failed: ${String(e?.message ?? e)}`);
    }

    await sleep(MIN_DELAY_MS);
  }
}

async function main() {
  console.log(`SUPABASE_URL present? ${!!process.env.SUPABASE_URL}`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY present? ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}`);
  console.log(`BATCH=${BATCH} CONCURRENCY=${CONCURRENCY} MIN_DELAY_MS=${MIN_DELAY_MS} MAX_RETRIES=${MAX_RETRIES}`);

  await pingSupabase();

  let offset = 0;
  while (true) {
    const rows = await getBatch(offset);
    if (!rows.length) break;

    const queue = rows.slice();
    const workers = Array.from({ length: CONCURRENCY }, () => worker(queue));
    await Promise.all(workers);

    console.log(`Processed batch offset=${offset} count=${rows.length}`);
    offset += BATCH;
  }

  console.log("Wikipedia fill complete.");
}

main().catch((e) => {
  console.error("Script failed:", e);
  process.exit(1);
});
