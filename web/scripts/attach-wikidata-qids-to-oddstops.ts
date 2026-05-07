// web/scripts/attach-wikidata-qids-to-oddstops.ts
//
// Attach Wikidata QIDs to OddStops rows (and optionally set Wikipedia URL + append to source_urls).
//
// What it does:
// - Looks for rows where source='oddstops' AND wikidata_qid IS NULL
// - Searches Wikidata for the row title
// - Validates candidate is a human (P31=Q5)
// - Prefers candidates with an English Wikipedia sitelink (enwiki)
// - Updates: wikidata_qid, wikidata_url, person_qid (if null), enwiki_title, wikipedia_url
// - Appends wikipedia_url into source_urls[] (deduped)
//
// Run (PowerShell) from death-atlas/web:
//   $env:SUPABASE_URL="https://xxxx.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY="xxxxx"
//   npx ts-node scripts\attach-wikidata-qids-to-oddstops.ts
//
// Optional env:
//   $env:BATCH_SIZE="250"           (default 250)
//   $env:CONCURRENCY="5"            (default 5)
//   $env:MIN_DELAY_MS="150"         (default 150)  // pacing to Wikidata
//   $env:MAX_RETRIES="3"            (default 3)
//   $env:DRY_RUN="1"                (default 0)    // no DB writes
//   $env:REQUIRE_ENWIKI="1"          (default 0)    // only accept matches that have enwiki sitelink
//   $env:SEARCH_LIMIT="10"           (default 10)   // candidates per title from wbsearchentities
//   $env:LOG_EVERY="25"              (default 25)
//   $env:REPORT_FILE="oddstops-wikidata-match-report.json" (default)
//
// Notes:
// - Matching is conservative. Ambiguous matches are skipped and written to the report.
// - The script uses Wikidata APIs:
//   - wbsearchentities (search)
//   - wbgetentities (validate human + get sitelinks)
//
// Requires Node 18+ (global fetch).

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

type DeathLocationRow = {
  id: string;
  title: string | null;
  source: string | null;

  wikidata_qid: string | null;
  wikidata_url: string | null;
  person_qid: string | null;

  wikipedia_url: string | null;
  enwiki_title: string | null;

  source_urls: string[] | null;
};

type SearchHit = {
  id: string; // QID
  label?: string;
  description?: string;
  match?: { type?: string; text?: string; language?: string };
};

type CandidateEntity = {
  qid: string;
  label: string | null;
  description: string | null;
  isHuman: boolean;
  enwikiTitle: string | null;
  enwikiUrl: string | null;
  score: number;
  scoreReasons: string[];
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
const CONCURRENCY = clampInt(process.env.CONCURRENCY, 1, 25, 5);
const MIN_DELAY_MS = clampInt(process.env.MIN_DELAY_MS, 0, 5000, 150);
const MAX_RETRIES = clampInt(process.env.MAX_RETRIES, 0, 10, 3);
const DRY_RUN = truthy(process.env.DRY_RUN);
const REQUIRE_ENWIKI = truthy(process.env.REQUIRE_ENWIKI);
const SEARCH_LIMIT = clampInt(process.env.SEARCH_LIMIT, 1, 50, 10);
const LOG_EVERY = clampInt(process.env.LOG_EVERY, 1, 500, 25);
const REPORT_FILE =
  (process.env.REPORT_FILE ?? "").trim() ||
  "oddstops-wikidata-match-report.json";

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

function normalizeName(s: string) {
  // conservative normalization: lowercase, strip punctuation, collapse spaces
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .toLowerCase()
    .replace(/['".,–—-]/g, " ")
    .replace(/[(){}\[\]]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeUrls(urls: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const nu = (u ?? "").toString().trim();
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
          // Put something reasonable here (Wikidata asks for descriptive UA)
          "User-Agent": "DeathAtlas/1.0 (OddStops QID match; no email)",
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        // Retry on 429 / 5xx
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

async function wikidataSearchByTitle(title: string): Promise<SearchHit[]> {
  const api = new URL("https://www.wikidata.org/w/api.php");
  api.searchParams.set("action", "wbsearchentities");
  api.searchParams.set("format", "json");
  api.searchParams.set("language", "en");
  api.searchParams.set("uselang", "en");
  api.searchParams.set("search", title);
  api.searchParams.set("limit", String(SEARCH_LIMIT));

  const json = await fetchJsonWithRetry(api.toString(), MAX_RETRIES);
  const hits = (json?.search ?? []) as any[];

  return hits
    .map((h) => ({
      id: h?.id,
      label: h?.label,
      description: h?.description,
      match: h?.match,
    }))
    .filter((h) => typeof h.id === "string" && /^Q\d+$/.test(h.id));
}

async function wikidataGetEntities(qids: string[]) {
  if (qids.length === 0) return {};

  const api = new URL("https://www.wikidata.org/w/api.php");
  api.searchParams.set("action", "wbgetentities");
  api.searchParams.set("format", "json");
  api.searchParams.set("languages", "en");
  api.searchParams.set("props", "labels|descriptions|claims|sitelinks");
  api.searchParams.set("sitefilter", "enwiki");
  api.searchParams.set("ids", qids.join("|"));

  const json = await fetchJsonWithRetry(api.toString(), MAX_RETRIES);
  return (json?.entities ?? {}) as Record<string, any>;
}

function isHumanEntity(entity: any): boolean {
  // P31 = instance of. Human = Q5
  const claims = entity?.claims;
  const p31 = claims?.P31;
  if (!Array.isArray(p31)) return false;

  for (const snak of p31) {
    const dv = snak?.mainsnak?.datavalue;
    const id = dv?.value?.id;
    if (id === "Q5") return true;
  }
  return false;
}

function getEnLabel(entity: any): string | null {
  const lbl = entity?.labels?.en?.value;
  return typeof lbl === "string" ? lbl : null;
}

function getEnDescription(entity: any): string | null {
  const d = entity?.descriptions?.en?.value;
  return typeof d === "string" ? d : null;
}

function getEnwikiTitle(entity: any): string | null {
  const title = entity?.sitelinks?.enwiki?.title;
  return typeof title === "string" ? title : null;
}

function enwikiUrlFromTitle(title: string): string {
  // Wikipedia titles use underscores; encodeURIComponent safe enough
  const t = title.replace(/ /g, "_");
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(t)}`;
}

function scoreCandidate(
  rowTitle: string,
  candLabel: string | null,
  candDescription: string | null,
  hasEnwiki: boolean
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const a = normalizeName(rowTitle);
  const b = candLabel ? normalizeName(candLabel) : "";

  if (b && a === b) {
    score += 10;
    reasons.push("exact normalized label match (+10)");
  } else if (b && (a === b.replace(/\s+/g, " ") || b.includes(a) || a.includes(b))) {
    score += 4;
    reasons.push("strong partial label similarity (+4)");
  }

  // Prefer entities that clearly look like people in description
  const desc = (candDescription ?? "").toLowerCase();
  if (desc.includes("american") || desc.includes("english") || desc.includes("actor") || desc.includes("singer") || desc.includes("rapper") || desc.includes("wrestler") || desc.includes("politician") || desc.includes("murder")) {
    score += 1;
    reasons.push("description hints person context (+1)");
  }

  if (hasEnwiki) {
    score += 2;
    reasons.push("has enwiki sitelink (+2)");
  }

  return { score, reasons };
}

async function chooseBestCandidate(rowTitle: string): Promise<{
  best: CandidateEntity | null;
  alternatives: CandidateEntity[];
}> {
  const hits = await wikidataSearchByTitle(rowTitle);
  if (hits.length === 0) return { best: null, alternatives: [] };

  const qids = hits.map((h) => h.id);
  const entities = await wikidataGetEntities(qids);

  const candidates: CandidateEntity[] = [];

  for (const qid of qids) {
    const ent = entities[qid];
    if (!ent || ent?.missing) continue;

    const human = isHumanEntity(ent);
    const label = getEnLabel(ent);
    const desc = getEnDescription(ent);
    const enwikiTitle = getEnwikiTitle(ent);
    const hasEnwiki = !!enwikiTitle;

    if (!human) continue; // only humans

    const { score, reasons } = scoreCandidate(rowTitle, label, desc, hasEnwiki);

    const enwikiUrl = enwikiTitle ? enwikiUrlFromTitle(enwikiTitle) : null;

    candidates.push({
      qid,
      label,
      description: desc,
      isHuman: true,
      enwikiTitle,
      enwikiUrl,
      score,
      scoreReasons: reasons,
    });
  }

  if (candidates.length === 0) return { best: null, alternatives: [] };

  // Sort by score desc
  candidates.sort((a, b) => b.score - a.score);

  // Apply REQUIRE_ENWIKI if requested
  const filtered = REQUIRE_ENWIKI
    ? candidates.filter((c) => !!c.enwikiUrl)
    : candidates;

  if (filtered.length === 0) return { best: null, alternatives: candidates };

  const top = filtered[0];
  const second = filtered[1];

  // Ambiguity rule:
  // - must have score >= 8 to be "confident"
  // - OR if score >= 10 and beats second by >= 3
  // - Otherwise skip as ambiguous
  const confident =
    top.score >= 10 ||
    (top.score >= 8 && (!second || top.score - second.score >= 3));

  if (!confident) {
    return { best: null, alternatives: filtered.slice(0, 5) };
  }

  return { best: top, alternatives: filtered.slice(0, 5) };
}

async function loadBatch(offset: number): Promise<DeathLocationRow[]> {
  const { data, error } = await supabase
    .from("death_locations")
    .select(
      "id,title,source,wikidata_qid,wikidata_url,person_qid,wikipedia_url,enwiki_title,source_urls"
    )
    .eq("source", "oddstops")
    .is("wikidata_qid", null)
    .range(offset, offset + BATCH_SIZE - 1);

  if (error) throw error;
  return (data ?? []) as DeathLocationRow[];
}

async function updateRowWithMatch(
  row: DeathLocationRow,
  match: CandidateEntity
) {
  const wikidataUrl = `https://www.wikidata.org/wiki/${match.qid}`;

  const existingUrls = row.source_urls ?? [];
  const nextUrls = match.enwikiUrl
    ? dedupeUrls([...existingUrls, match.enwikiUrl])
    : dedupeUrls(existingUrls);

  const patch: any = {
    wikidata_qid: match.qid,
    wikidata_url: wikidataUrl,
    // Only set person_qid if it's empty
    person_qid: row.person_qid ? row.person_qid : match.qid,
    // Fill wiki fields if available
    enwiki_title: match.enwikiTitle ?? row.enwiki_title,
    wikipedia_url: match.enwikiUrl ?? row.wikipedia_url,
    source_urls: nextUrls,
    updated_at: new Date().toISOString(),
  };

  if (DRY_RUN) return { patch };

  const { error } = await supabase
    .from("death_locations")
    .update(patch)
    .eq("id", row.id);

  if (error) throw error;
  return { patch };
}

async function main() {
  console.log("=== Attach Wikidata QIDs to OddStops ===");
  console.log(
    JSON.stringify(
      {
        BATCH_SIZE,
        CONCURRENCY,
        MIN_DELAY_MS,
        MAX_RETRIES,
        DRY_RUN,
        REQUIRE_ENWIKI,
        SEARCH_LIMIT,
        REPORT_FILE,
      },
      null,
      2
    )
  );

  let offset = 0;
  let scanned = 0;
  let updated = 0;
  let skippedNoHits = 0;
  let skippedAmbiguous = 0;
  let skippedNoValidHuman = 0;
  let errors = 0;

  const report: any = {
    started_at: new Date().toISOString(),
    config: {
      BATCH_SIZE,
      CONCURRENCY,
      MIN_DELAY_MS,
      MAX_RETRIES,
      DRY_RUN,
      REQUIRE_ENWIKI,
      SEARCH_LIMIT,
    },
    updated: [] as any[],
    skipped: [] as any[],
    errors: [] as any[],
  };

  while (true) {
    const batch = await loadBatch(offset);
    if (batch.length === 0) break;

    scanned += batch.length;

    const queue = batch.slice();
    const workers: Promise<void>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(
        (async () => {
          while (queue.length) {
            const row = queue.shift()!;
            const title = (row.title ?? "").trim();

            if (!title) {
              skippedNoHits++;
              report.skipped.push({
                id: row.id,
                title: row.title,
                reason: "missing title",
              });
              continue;
            }

            try {
              const { best, alternatives } = await chooseBestCandidate(title);

              if (!alternatives || alternatives.length === 0) {
                skippedNoValidHuman++;
                report.skipped.push({
                  id: row.id,
                  title,
                  reason: "no valid human candidates after validation",
                });
                continue;
              }

              if (!best) {
                // ambiguous or no confident match
                skippedAmbiguous++;
                report.skipped.push({
                  id: row.id,
                  title,
                  reason: "ambiguous or low-confidence match",
                  alternatives,
                });
                continue;
              }

              const { patch } = await updateRowWithMatch(row, best);
              updated++;

              report.updated.push({
                id: row.id,
                title,
                match: best,
                patch,
              });

              if (updated % LOG_EVERY === 0) {
                console.log(
                  `Progress: scanned=${scanned} updated=${updated} skippedAmbiguous=${skippedAmbiguous} errors=${errors}`
                );
              }
            } catch (e: any) {
              errors++;
              report.errors.push({
                id: row.id,
                title,
                error: e?.message ?? String(e),
              });
              console.error(`ERROR on "${title}" (${row.id}):`, e?.message ?? e);
            }
          }
        })()
      );
    }

    await Promise.all(workers);
    offset += BATCH_SIZE;
  }

  report.finished_at = new Date().toISOString();
  report.summary = {
    scanned,
    updated,
    skippedNoHits,
    skippedAmbiguous,
    skippedNoValidHuman,
    errors,
    dryRun: DRY_RUN,
  };

  const outPath = path.resolve(process.cwd(), REPORT_FILE);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("=== DONE ===");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report written: ${outPath}`);

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
