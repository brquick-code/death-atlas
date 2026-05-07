/**
 * Takes seeing-stars-died-leads.json and resolves each name to a Wikidata QID.
 * Keeps ONLY:
 *  - humans (P31=Q5) AND
 *  - with a death date (P570)
 *
 * Output:
 *  - seeing-stars-died-verified.json (safe-ish: still review, but hoaxes/living should drop)
 *  - seeing-stars-died-qids.json      (just QIDs for import pipelines)
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";

type Lead = {
  source: "seeing-stars";
  decade: string;
  name: string;
  rawContext?: string;
  url: string;
};

type Verified = {
  name: string;
  qid: string;
  label: string;
  description?: string;
  deathDate?: string; // ISO-ish
  sourceLead: Lead;
  chosenFromSearchRank?: number;
};

const IN_FILE = path.join(process.cwd(), "seeing-stars-died-leads.json");
const OUT_VERIFIED = path.join(process.cwd(), "seeing-stars-died-verified.json");
const OUT_QIDS = path.join(process.cwd(), "seeing-stars-died-qids.json");

const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "250");
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || "3"));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "death-atlas-bot/1.0 (verification; contact: local)",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Wikidata search for an item by name
async function wikidataSearch(name: string, limit = 8) {
  const url =
    "https://www.wikidata.org/w/api.php?" +
    new URLSearchParams({
      action: "wbsearchentities",
      format: "json",
      language: "en",
      uselang: "en",
      type: "item",
      search: name,
      limit: String(limit),
    }).toString();

  return fetchJson(url);
}

// Fetch entity data
async function getEntity(qid: string) {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  return fetchJson(url);
}

// Helpers to read claims
function getClaimValue(entity: any, pid: string) {
  const claims = entity?.claims?.[pid];
  if (!claims || !Array.isArray(claims) || claims.length === 0) return null;
  return claims[0]?.mainsnak?.datavalue?.value ?? null;
}

function hasInstanceOfHuman(entity: any): boolean {
  const claims = entity?.claims?.P31;
  if (!Array.isArray(claims)) return false;
  for (const c of claims) {
    const v = c?.mainsnak?.datavalue?.value;
    if (v?.["id"] === "Q5") return true; // human
  }
  return false;
}

function getDeathDate(entity: any): string | undefined {
  // P570 is time
  const claims = entity?.claims?.P570;
  if (!Array.isArray(claims) || claims.length === 0) return undefined;

  const time = claims[0]?.mainsnak?.datavalue?.value?.time as string | undefined;
  if (!time) return undefined;

  // Wikidata time looks like "+1984-10-12T00:00:00Z"
  return time.replace(/^\+/, "");
}

function getLabel(entity: any): string {
  return entity?.labels?.en?.value || entity?.labels?.[Object.keys(entity?.labels || {})[0]]?.value || "";
}

function getDescription(entity: any): string | undefined {
  return entity?.descriptions?.en?.value;
}

async function resolveNameToVerified(name: string): Promise<{ verified?: Omit<Verified, "sourceLead">; debugReason?: string }> {
  const s = await wikidataSearch(name, 10);
  const results: any[] = s?.search || [];
  if (!results.length) return { debugReason: "no_search_results" };

  // Try results in order until we find:
  //  - human (P31=Q5)
  //  - has death date (P570)
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const qid = r?.id;
    if (!qid) continue;

    await sleep(MIN_DELAY_MS);

    const entityDoc = await getEntity(qid);
    const entity = entityDoc?.entities?.[qid];
    if (!entity) continue;

    if (!hasInstanceOfHuman(entity)) continue;

    const deathDate = getDeathDate(entity);
    if (!deathDate) continue;

    const label = getLabel(entity) || r?.label || name;
    const description = getDescription(entity) || r?.description;

    return {
      verified: {
        name,
        qid,
        label,
        description,
        deathDate,
        chosenFromSearchRank: i + 1,
      },
    };
  }

  return { debugReason: "no_human_with_death_date_found" };
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

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const raw = await fs.readFile(IN_FILE, "utf8");
  const leads: Lead[] = JSON.parse(raw);

  console.log(`Loaded ${leads.length} leads from ${path.basename(IN_FILE)}`);
  console.log(`Resolving with CONCURRENCY=${CONCURRENCY} MIN_DELAY_MS=${MIN_DELAY_MS}`);

  const verified: Verified[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  const resolved = await workerPool(leads, CONCURRENCY, async (lead, idx) => {
    if (idx % 25 === 0) console.log(`Progress ${idx}/${leads.length}...`);
    try {
      const r = await resolveNameToVerified(lead.name);
      if (r.verified) {
        return { ok: true as const, v: { ...r.verified, sourceLead: lead } };
      }
      return { ok: false as const, name: lead.name, reason: r.debugReason || "unknown" };
    } catch (e: any) {
      return { ok: false as const, name: lead.name, reason: `error:${e?.message || String(e)}` };
    }
  });

  for (const r of resolved) {
    if (r.ok) verified.push(r.v);
    else rejected.push({ name: r.name, reason: r.reason });
  }

  // De-dupe by QID (keep first occurrence)
  const byQid = new Map<string, Verified>();
  for (const v of verified) {
    if (!byQid.has(v.qid)) byQid.set(v.qid, v);
  }
  const deduped = Array.from(byQid.values()).sort((a, b) => (b.deathDate || "").localeCompare(a.deathDate || ""));

  await fs.writeFile(OUT_VERIFIED, JSON.stringify({ verified: deduped, rejected }, null, 2), "utf8");
  await fs.writeFile(OUT_QIDS, JSON.stringify(deduped.map((v) => v.qid), null, 2), "utf8");

  console.log(`Done.`);
  console.log(`Verified humans w/ death date: ${deduped.length}`);
  console.log(`Rejected: ${rejected.length}`);
  console.log(`Wrote ${path.basename(OUT_VERIFIED)}`);
  console.log(`Wrote ${path.basename(OUT_QIDS)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
