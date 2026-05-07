import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as cheerio from "cheerio";

type Lead = {
  name: string;
  url: string;
  birthYear: number | null;
  deathYear: number | null;
  source: "findadeath";
  sourceUrl: string;
};

type Verified = Lead & {
  qid: string;
  wikidataLabel: string | null;
  deathDate: string | null;
  matchedBy: "wikipedia_link" | "wikidata_search";
  debug?: {
    wikipediaUrl?: string | null;
    wikipediaTitle?: string | null;
    matchScore?: number | null;
    queryTried?: string | null;
  };
};

const IN_LEADS = path.join(process.cwd(), "findadeath-directory-leads.json");
const OUT_VERIFIED = path.join(process.cwd(), "findadeath-verified.json");
const OUT_QIDS = path.join(process.cwd(), "findadeath-qids.json");

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || "2"));
// Bump delay a bit because this script hits FindADeath + Wikipedia + Wikidata
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "450");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "death-atlas-bot/1.0 (findadeath verifier)",
      Accept: "text/html,*/*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "death-atlas-bot/1.0 (findadeath verifier)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function toYear(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function getEnLabel(entity: any): string | null {
  return entity?.labels?.en?.value || null;
}

function hasHumanInstance(entity: any): boolean {
  const claims = entity?.claims?.P31;
  if (!Array.isArray(claims)) return false;
  return claims.some((c: any) => c?.mainsnak?.datavalue?.value?.id === "Q5");
}

function getDeathDate(entity: any): string | null {
  const claims = entity?.claims?.P570;
  if (!Array.isArray(claims) || !claims.length) return null;
  const time = claims[0]?.mainsnak?.datavalue?.value?.time as string | undefined;
  if (!time) return null;
  return time.replace(/^\+/, "");
}

async function getWikidataEntity(qid: string): Promise<any | null> {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  const doc = await fetchJson<any>(url);
  return doc?.entities?.[qid] || null;
}

/**
 * Extract first Wikipedia URL from a FindADeath page, if present.
 */
function extractWikipediaUrlFromFindADeathHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // look for any link to en.wikipedia.org/wiki/...
  const a = $('a[href*="en.wikipedia.org/wiki/"]').first();
  if (a && a.length) {
    const href = (a.attr("href") || "").trim();
    return href || null;
  }

  // sometimes it might be plain wikipedia.org/wiki/
  const a2 = $('a[href*="wikipedia.org/wiki/"]').first();
  if (a2 && a2.length) {
    const href = (a2.attr("href") || "").trim();
    return href || null;
  }

  return null;
}

function wikipediaTitleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/wiki\/(.+)$/);
    if (!m) return null;
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * Wikipedia title -> Wikidata QID using pageprops.wikibase_item
 */
async function qidFromWikipediaTitle(title: string): Promise<string | null> {
  const api =
    "https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*" +
    "&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=" +
    encodeURIComponent(title);

  const json = await fetchJson<any>(api);
  const pages = json?.query?.pages;
  if (!pages) return null;

  const page = Object.values(pages)[0] as any;
  const qid = page?.pageprops?.wikibase_item;
  return typeof qid === "string" && qid.startsWith("Q") ? qid : null;
}

/**
 * Fallback: Wikidata search by name (wbsearchentities)
 */
async function wbSearchEntities(query: string, limit = 25): Promise<string[]> {
  const url =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&uselang=en` +
    `&type=item&limit=${limit}&search=${encodeURIComponent(query)}`;
  const json = await fetchJson<any>(url);
  const ids: string[] = [];
  for (const r of json?.search || []) {
    if (r?.id && typeof r.id === "string" && r.id.startsWith("Q")) ids.push(r.id);
  }
  return ids;
}

function scoreCandidate(opts: {
  leadName: string;
  leadDeathYear: number | null;
  entityLabel: string | null;
  entityDeathDate: string | null;
}): number {
  let score = 0;

  const leadName = clean(opts.leadName).toLowerCase();
  const label = clean(opts.entityLabel || "").toLowerCase();

  if (label && leadName) {
    if (label === leadName) score += 40;
    else if (label.includes(leadName) || leadName.includes(label)) score += 20;
  }

  const entityDeathYear = toYear(opts.entityDeathDate);

  if (opts.leadDeathYear && entityDeathYear) {
    if (opts.leadDeathYear === entityDeathYear) score += 80;
    else if (Math.abs(opts.leadDeathYear - entityDeathYear) === 1) score += 20;
    else score -= 40;
  }

  if (opts.entityDeathDate) score += 10;

  return score;
}

async function resolveViaWikipediaLink(lead: Lead): Promise<Verified | null> {
  await sleep(MIN_DELAY_MS);
  const html = await fetchText(lead.url);

  const wikiUrl = extractWikipediaUrlFromFindADeathHtml(html);
  if (!wikiUrl) return null;

  const title = wikipediaTitleFromUrl(wikiUrl);
  if (!title) return null;

  await sleep(MIN_DELAY_MS);
  const qid = await qidFromWikipediaTitle(title);
  if (!qid) return null;

  await sleep(MIN_DELAY_MS);
  const entity = await getWikidataEntity(qid);
  if (!entity) return null;

  if (!hasHumanInstance(entity)) return null;
  const deathDate = getDeathDate(entity);
  if (!deathDate) return null;

  return {
    ...lead,
    qid,
    wikidataLabel: getEnLabel(entity),
    deathDate,
    matchedBy: "wikipedia_link",
    debug: {
      wikipediaUrl: wikiUrl,
      wikipediaTitle: title,
      matchScore: null,
      queryTried: null,
    },
  };
}

async function resolveViaWikidataSearch(lead: Lead): Promise<Verified | null> {
  // Try name + deathYear to disambiguate when possible
  const queries = [
    lead.deathYear ? `${lead.name} ${lead.deathYear}` : null,
    lead.name,
  ].filter(Boolean) as string[];

  let best: Verified | null = null;

  for (const q of Array.from(new Set(queries.map(clean)))) {
    await sleep(MIN_DELAY_MS);
    const ids = await wbSearchEntities(q, 25);

    for (const id of ids) {
      await sleep(MIN_DELAY_MS);
      const entity = await getWikidataEntity(id);
      if (!entity) continue;
      if (!hasHumanInstance(entity)) continue;

      const deathDate = getDeathDate(entity);
      if (!deathDate) continue;

      const label = getEnLabel(entity);
      const score = scoreCandidate({
        leadName: lead.name,
        leadDeathYear: lead.deathYear,
        entityLabel: label,
        entityDeathDate: deathDate,
      });

      const cand: Verified = {
        ...lead,
        qid: id,
        wikidataLabel: label,
        deathDate,
        matchedBy: "wikidata_search",
        debug: {
          wikipediaUrl: null,
          wikipediaTitle: null,
          matchScore: score,
          queryTried: q,
        },
      };

      if (!best || score > (best.debug?.matchScore ?? -999)) best = cand;
    }

    if (best && (best.debug?.matchScore ?? 0) >= 90) break;
  }

  // Lower threshold because we’re using death year heavily
  if (!best) return null;
  const s = best.debug?.matchScore ?? 0;
  if (s < 35) return null;

  return best;
}

async function resolveLead(lead: Lead): Promise<Verified | null> {
  // 1) Best: use Wikipedia link on the FindADeath page
  const viaWiki = await resolveViaWikipediaLink(lead);
  if (viaWiki) return viaWiki;

  // 2) Fallback: name search
  return await resolveViaWikidataSearch(lead);
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

async function main() {
  const raw = await fs.readFile(IN_LEADS, "utf8");
  const leads: Lead[] = JSON.parse(raw);

  console.log(`Loaded ${leads.length} leads from ${path.basename(IN_LEADS)}`);
  console.log(`Resolving with CONCURRENCY=${CONCURRENCY} MIN_DELAY_MS=${MIN_DELAY_MS}`);

  const out = await workerPool(leads, CONCURRENCY, async (lead, idx) => {
    if (idx % 25 === 0) console.log(`Progress ${idx}/${leads.length}...`);
    try {
      const v = await resolveLead(lead);
      return { ok: Boolean(v), verified: v, lead };
    } catch (e: any) {
      return { ok: false, verified: null, lead, err: e?.message || String(e) };
    }
  });

  const verified: Verified[] = out.filter((x: any) => x.ok).map((x: any) => x.verified as Verified);
  const rejected = out.filter((x: any) => !x.ok);

  // stable outputs
  verified.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const qids = Array.from(new Set(verified.map((v) => v.qid)));

  await fs.writeFile(OUT_VERIFIED, JSON.stringify(verified, null, 2), "utf8");
  await fs.writeFile(OUT_QIDS, JSON.stringify(qids, null, 2), "utf8");

  const byWiki = verified.filter((v) => v.matchedBy === "wikipedia_link").length;
  const bySearch = verified.filter((v) => v.matchedBy === "wikidata_search").length;

  console.log(`Done.`);
  console.log(`Verified: ${verified.length} (wikipedia_link=${byWiki}, wikidata_search=${bySearch})`);
  console.log(`Rejected: ${rejected.length}`);
  console.log(`Wrote ${path.basename(OUT_VERIFIED)}`);
  console.log(`Wrote ${path.basename(OUT_QIDS)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
