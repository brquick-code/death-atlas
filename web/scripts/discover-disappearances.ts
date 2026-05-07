/**
 * Discover Wikipedia pages titled:
 *  - "Disappearance of X"
 *  - "The disappearance of X"
 *
 * Skip cases newer than N years (default 15).
 * Handles Wikipedia 429 with retry+backoff and continues.
 * Writes progress incrementally so you don't lose results.
 *
 * Outputs:
 *  - scripts/out/disappearances.json
 *  - scripts/out/disappearances.sql
 *
 * Usage:
 *   cd C:\death-atlas\web
 *   npx ts-node scripts\discover-disappearances.ts --max=200 --depth=3 --minYears=15
 *
 * Resume:
 *   npx ts-node scripts\discover-disappearances.ts --max=200 --depth=3 --minYears=15 --resumeFrom=22
 */

import fs from "node:fs";
import path from "node:path";

type CatMember = { pageid: number; ns: number; title: string };
type PageInfo = { pageid: number; title: string; fullurl?: string };

type OutRow = {
  title: string;
  wikipedia_url: string;
  summary: string | null;
  year_detected: number | null;
  skipped: boolean;
  skip_reason: string | null;
};

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_REST_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/";

const OUT_DIR = path.join(process.cwd(), "scripts", "out");
const OUT_JSON = path.join(OUT_DIR, "disappearances.json");
const OUT_SQL = path.join(OUT_DIR, "disappearances.sql");

// ✅ Better seeds
const SEED_CATEGORIES = [
  "Category:Missing people",
  "Category:Unexplained disappearances",
  "Category:Mass disappearances",
  "Category:Missing person cases by decade",
];

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function argNum(name: string, fallback: number) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split("=", 2)[1]);
  return Number.isFinite(n) ? n : fallback;
}

function argBool(name: string, fallback: boolean) {
  const on = process.argv.includes(`--${name}`);
  const off = process.argv.includes(`--no-${name}`);
  if (on) return true;
  if (off) return false;
  return fallback;
}

function sqlEscape(s: string) {
  return s.replace(/'/g, "''");
}

function normalizeTitleMatch(title: string) {
  const t = title.trim().toLowerCase();
  return t.startsWith("disappearance of ") || t.startsWith("the disappearance of ");
}

function extractYearFromText(text: string): number | null {
  const matches = text.match(/\b(18|19|20)\d{2}\b/g);
  if (!matches?.length) return null;
  const years = matches.map(Number).filter((n) => Number.isFinite(n));
  if (!years.length) return null;
  return Math.min(...years);
}

/**
 * Simple child-case heuristic (you wanted to avoid these)
 * Can be disabled with: --no-skipChildren
 */
function looksLikeChildCase(title: string, summary: string | null): boolean {
  const hay = `${title}\n${summary ?? ""}`.toLowerCase();

  // common phrases in child disappearance articles
  const triggers = [
    "child",
    "children",
    "boy",
    "girl",
    "toddler",
    "infant",
    "kidnapping",
    "abduction",
    "schoolgirl",
    "schoolboy",
    "teenage girl",
    "teenage boy",
    "aged 3",
    "aged 4",
    "aged 5",
    "aged 6",
    "aged 7",
    "aged 8",
    "aged 9",
    "aged 10",
    "aged 11",
    "aged 12",
    "aged 13",
    "aged 14",
    "aged 15",
    "aged 16",
    "aged 17",
    "year-old",
    "years old",
  ];

  return triggers.some((t) => hay.includes(t));
}

/**
 * Fetch with automatic retry/backoff on 429 + transient errors.
 */
async function fetchWithRetry(url: string, opts: RequestInit, label: string) {
  let attempt = 0;
  let delayMs = 600; // start small
  const maxAttempts = 8;

  while (true) {
    attempt++;

    const res = await fetch(url, opts).catch((e) => {
      // treat as transient
      return null as any;
    });

    if (!res) {
      if (attempt >= maxAttempts) throw new Error(`${label}: network error (gave up)`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 15000);
      continue;
    }

    if (res.status === 429) {
      // obey retry-after if present
      const ra = res.headers.get("retry-after");
      const wait = ra ? Math.min(Number(ra) * 1000, 30000) : delayMs;
      if (attempt >= maxAttempts) throw new Error(`${label}: Wiki API failed 429 (gave up)`);
      await sleep(wait);
      delayMs = Math.min(delayMs * 2, 20000);
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= maxAttempts) throw new Error(`${label}: server error ${res.status} (gave up)`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 15000);
      continue;
    }

    return res;
  }
}

async function wikiApi(params: Record<string, string>) {
  const url = new URL(WIKI_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("format", "json");

  const res = await fetchWithRetry(
    url.toString(),
    { headers: { "User-Agent": "DeathAtlas/1.0 (disappearance discovery; non-commercial)" } },
    "wikiApi"
  );

  if (!res.ok) throw new Error(`Wiki API failed ${res.status}`);
  return res.json();
}

async function getCategoryMembers(catTitle: string, cmcontinue?: string) {
  const params: Record<string, string> = {
    action: "query",
    list: "categorymembers",
    cmtitle: catTitle,
    cmlimit: "500",
    cmtype: "page|subcat",
  };
  if (cmcontinue) params.cmcontinue = cmcontinue;

  const json = await wikiApi(params);
  const members = (json?.query?.categorymembers ?? []) as CatMember[];
  const next = json?.continue?.cmcontinue as string | undefined;
  return { members, next };
}

async function getPageInfo(title: string): Promise<PageInfo | null> {
  const json = await wikiApi({
    action: "query",
    prop: "info",
    inprop: "url",
    titles: title,
  });

  const pages = json?.query?.pages;
  if (!pages) return null;

  const firstKey = Object.keys(pages)[0];
  const p = pages[firstKey];
  if (!p || p.missing) return null;

  return { pageid: p.pageid, title: p.title, fullurl: p.fullurl };
}

async function getSummary(title: string): Promise<string | null> {
  const url = WIKI_REST_SUMMARY + encodeURIComponent(title);
  const res = await fetchWithRetry(
    url,
    { headers: { "User-Agent": "DeathAtlas/1.0 (disappearance discovery; non-commercial)" } },
    "summary"
  );
  if (!res.ok) return null;
  const j: any = await res.json();
  return typeof j?.extract === "string" ? j.extract : null;
}

async function crawlTitles(opts: { depth: number; max: number }) {
  const visitedCats = new Set<string>();
  const seenTitles = new Set<string>();
  const queue: Array<{ cat: string; d: number }> = SEED_CATEGORIES.map((c) => ({ cat: c, d: 0 }));
  const hits: string[] = [];

  while (queue.length && hits.length < opts.max) {
    const { cat, d } = queue.shift()!;
    if (visitedCats.has(cat)) continue;
    visitedCats.add(cat);

    let cont: string | undefined = undefined;
    let scanned = 0;

    do {
      const { members, next } = await getCategoryMembers(cat, cont);
      cont = next;
      scanned += members.length;

      for (const m of members) {
        if (m.ns === 14) {
          if (d + 1 <= opts.depth) {
            const sub = m.title.startsWith("Category:") ? m.title : `Category:${m.title}`;
            if (!visitedCats.has(sub)) queue.push({ cat: sub, d: d + 1 });
          }
          continue;
        }

        if (m.ns !== 0) continue;

        const t = m.title.trim();
        if (seenTitles.has(t)) continue;
        seenTitles.add(t);

        if (normalizeTitleMatch(t)) {
          hits.push(t);
          if (hits.length >= opts.max) break;
        }
      }
    } while (cont && hits.length < opts.max);

    console.log(`Scanned category: ${cat} -> members=${scanned}, hits_so_far=${hits.length}`);
    await sleep(150);
  }

  return hits;
}

function buildSql(rows: OutRow[]) {
  const lines: string[] = [];
  lines.push("-- Auto-generated by scripts/discover-disappearances.ts");
  lines.push("-- Inserts Missing cases into public.death_locations");
  lines.push("-- Only non-skipped rows are inserted.");
  lines.push("-- coord_source='last_seen'");
  lines.push("");

  for (const r of rows) {
    if (r.skipped) continue;

    const title = sqlEscape(r.title);
    const wiki = sqlEscape(r.wikipedia_url);
    const summary = r.summary ? sqlEscape(r.summary) : "";

    lines.push(
      `insert into public.death_locations (` +
        [
          "title",
          "type",
          "category",
          "source_name",
          "source_url",
          "source_urls",
          "is_published",
          "is_hidden",
          "summary",
          "confidence",
          "coord_source",
        ].join(", ") +
        `)\nselect ` +
        [
          `'${title}'`,
          `'person'`,
          `'missing'`,
          `'wikipedia'`,
          `'${wiki}'`,
          `array['${wiki}']`,
          `true`,
          `false`,
          summary ? `'${summary}'` : `null`,
          `'approximate'`,
          `'last_seen'`,
        ].join(", ") +
        `\nwhere not exists (\n  select 1 from public.death_locations where lower(title) = lower('${title}')\n);\n`
    );
  }

  return lines.join("\n");
}

function writeOutputs(rows: OutRow[], meta: any) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        ...meta,
        kept: rows.filter((r) => !r.skipped).length,
        skipped: rows.filter((r) => r.skipped).length,
        rows,
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(OUT_SQL, buildSql(rows), "utf8");
}

async function main() {
  const max = Math.min(Math.max(argNum("max", 200), 1), 2000);
  const depth = Math.min(Math.max(argNum("depth", 3), 0), 6);
  const minYears = Math.min(Math.max(argNum("minYears", 15), 1), 200);
  const resumeFrom = Math.max(argNum("resumeFrom", 1), 1); // 1-based index
  const skipChildren = argBool("skipChildren", true);

  const nowYear = new Date().getFullYear();
  const cutoffYear = nowYear - minYears;

  console.log(`Crawling categories (depth=${depth}, max=${max}, minYears=${minYears})...`);

  const titles = await crawlTitles({ depth, max });

  console.log(`Found ${titles.length} candidate titles`);
  if (titles.length === 0) {
    writeOutputs([], {
      generated_at: new Date().toISOString(),
      min_years: minYears,
      cutoff_year: cutoffYear,
      resume_from: resumeFrom,
      skip_children: skipChildren,
      note: "No candidates found. Seeds may need adjustment.",
    });
    return;
  }

  // If a prior output exists, load it so we can append safely
  let rows: OutRow[] = [];
  if (fs.existsSync(OUT_JSON)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_JSON, "utf8"));
      if (Array.isArray(prev?.rows)) rows = prev.rows;
    } catch {
      // ignore
    }
  }

  // ensure rows map by title (avoid dupes)
  const existingByTitle = new Map<string, OutRow>();
  for (const r of rows) existingByTitle.set(r.title.toLowerCase(), r);

  for (let i = resumeFrom - 1; i < titles.length; i++) {
    const t = titles[i];

    // skip if already processed in previous run
    if (existingByTitle.has(t.toLowerCase())) {
      console.log(`[${i + 1}/${titles.length}] ${t} ... already processed`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${titles.length}] ${t} ... `);

    // polite pacing between items (in addition to backoff on 429)
    await sleep(350);

    const info = await getPageInfo(t).catch((e) => null);
    const url = info?.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`;

    const summary = await getSummary(t).catch(() => null);

    let year: number | null = null;
    let skipped = false;
    let reason: string | null = null;

    if (!summary) {
      skipped = true;
      reason = "no summary available";
    } else {
      year = extractYearFromText(summary);

      // child-case skip (optional but ON by default)
      if (!skipped && skipChildren && looksLikeChildCase(t, summary)) {
        skipped = true;
        reason = "child-case heuristic";
      }

      // recency skip
      if (!skipped && year != null && year > cutoffYear) {
        skipped = true;
        reason = `too recent (year ${year}, cutoff <= ${cutoffYear})`;
      }
    }

    const row: OutRow = {
      title: t,
      wikipedia_url: url,
      summary: summary ?? null,
      year_detected: year,
      skipped,
      skip_reason: reason,
    };

    rows.push(row);
    existingByTitle.set(t.toLowerCase(), row);

    console.log(skipped ? `SKIP: ${reason}` : "KEEP");

    // ✅ write every 10 rows so you never lose work
    if ((rows.length % 10) === 0) {
      writeOutputs(rows, {
        generated_at: new Date().toISOString(),
        min_years: minYears,
        cutoff_year: cutoffYear,
        resume_from: resumeFrom,
        skip_children: skipChildren,
      });
      console.log(`(progress saved: ${rows.length} processed)`);
    }
  }

  // final write
  writeOutputs(rows, {
    generated_at: new Date().toISOString(),
    min_years: minYears,
    cutoff_year: cutoffYear,
    resume_from: resumeFrom,
    skip_children: skipChildren,
  });

  console.log(`\nWrote:\n- ${OUT_JSON}\n- ${OUT_SQL}`);
  console.log("\nNext: review the JSON, then run the SQL in Supabase SQL Editor.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
