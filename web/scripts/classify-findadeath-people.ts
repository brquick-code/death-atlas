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

type ClassifyResult = {
  name: string;
  url: string;
  isPerson: boolean;
  score: number;
  reasons: string[];
};

const IN_LEADS = path.join(process.cwd(), "findadeath-directory-leads.json");
const OUT_PEOPLE = path.join(process.cwd(), "findadeath-people-leads.json");
const OUT_NONPEOPLE = path.join(process.cwd(), "findadeath-nonpeople-leads.json");
const OUT_REPORT = path.join(process.cwd(), "findadeath-classify-report.json");

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || "3"));
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "350");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtml(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "death-atlas-bot/1.0 (findadeath classifier)",
      Accept: "text/html,*/*",
    },
  });

  // Some directory links are dead — treat as skip, not fatal
  if (res.status === 404) return null;

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}


function clean(s: string): string {
  return s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function nameHeuristicNonPerson(name: string): { hit: boolean; reason?: string } {
  const n = name.toLowerCase();

  // Strong “group” signals
  const groupWords = [
    "sisters",
    "brothers",
    "family",
    "band",
    "trio",
    "quartet",
    "duo",
    "group",
    "crew",
    "team",
    "couple",
    "twins",
    "midgets",
    "the ", // “The Andrews Sisters, The” often ends up with “the”
  ];

  // If name ends with ", The" or starts with "The "
  if (/\b,\s*the$/i.test(name) || /^the\s+/i.test(name)) {
    return { hit: true, reason: "name looks like a group/page title (The ...)" };
  }

  for (const w of groupWords) {
    if (w === "the ") continue;
    if (n.includes(w)) return { hit: true, reason: `name contains group word: ${w}` };
  }

  // Non-person-ish tokens
  const nonPersonTokens = [
    "cemetery",
    "graveyard",
    "murder",
    "massacre",
    "disaster",
    "accident",
    "tour",
    "tours",
    "hotel",
    "house",
    "mansion",
    "hospital",
    "school",
    "prison",
    "bridge",
    "plane",
    "flight",
    "ship",
    "train",
  ];
  for (const t of nonPersonTokens) {
    if (n.includes(t)) return { hit: true, reason: `name contains non-person token: ${t}` };
  }

  return { hit: false };
}

function extractMainText($: cheerio.CheerioAPI): string {
  const candidates = [
    "article .entry-content",
    ".entry-content",
    "main .entry-content",
    "article",
    "main",
    "#content",
    "body",
  ];

  for (const sel of candidates) {
    const el = $(sel).first();
    const txt = clean(el.text() || "");
    if (txt.length > 200) return txt;
  }
  return clean($("body").text() || "");
}

function scorePersonFromHtml(html: string): { score: number; reasons: string[] } {
  const $ = cheerio.load(html);
  const text = extractMainText($).toLowerCase();

  let score = 0;
  const reasons: string[] = [];

  const add = (pts: number, reason: string) => {
    score += pts;
    reasons.push(`${pts >= 0 ? "+" : ""}${pts}: ${reason}`);
  };

  // Person signals: “born”, “died”, “date of death”, etc.
  const bornSignals = [
    "born",
    "date of birth",
    "birth date",
    "dob",
  ];
  const diedSignals = [
    "died",
    "date of death",
    "death date",
    "dod",
  ];

  const hasBorn = bornSignals.some((s) => text.includes(s));
  const hasDied = diedSignals.some((s) => text.includes(s));

  if (hasBorn) add(25, "page contains birth language");
  if (hasDied) add(25, "page contains death language");
  if (hasBorn && hasDied) add(20, "page contains both birth and death language");

  // Find 4-digit years near “born”/“died”
  if (/(born|birth).{0,40}\b(18\d{2}|19\d{2}|20\d{2})\b/.test(text)) add(15, "birth year pattern found");
  if (/(died|death).{0,40}\b(18\d{2}|19\d{2}|20\d{2})\b/.test(text)) add(15, "death year pattern found");

  // Wikipedia link is a strong indicator it’s a person page
  const hasWikiLink =
    $('a[href*="wikipedia.org/wiki/"]').length > 0 ||
    $('a[href*="en.wikipedia.org/wiki/"]').length > 0;
  if (hasWikiLink) add(30, "has a Wikipedia link");

  // Category-ish pages often have “Category:” or “Archives” or navigation patterns.
  if (text.includes("category:")) add(-25, "looks like a category page");
  if (text.includes("archives")) add(-10, "looks like an archive/index page");

  // Tour pages (FindADeath also has tours)
  if (text.includes("dearly departed tours") || text.includes("tour") || text.includes("book a tour")) {
    add(-40, "looks like a tours page");
  }

  // If the page is extremely short, likely not a person entry (but not always)
  if (text.length < 600) add(-10, "very short page text");

  return { score, reasons };
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

  console.log(`Loaded ${leads.length} leads`);
  console.log(`Classifying with CONCURRENCY=${CONCURRENCY} MIN_DELAY_MS=${MIN_DELAY_MS}`);

  const results = await workerPool(leads, CONCURRENCY, async (lead, idx) => {
    if (idx % 25 === 0) console.log(`Progress ${idx}/${leads.length}...`);

    const reasons: string[] = [];
    let score = 0;

    // Name-only pre-filter (soft)
    const h = nameHeuristicNonPerson(lead.name);
    if (h.hit) {
      score -= 25;
      reasons.push(`-25: name heuristic: ${h.reason}`);
    } else {
      score += 5;
      reasons.push(`+5: name heuristic: looks like a person name`);
    }

    await sleep(MIN_DELAY_MS);
    const html = await fetchHtml(lead.url);

if (!html) {
  // 404: dead directory link, treat as non-person/skip but don't crash
  const out: ClassifyResult = {
    name: lead.name,
    url: lead.url,
    isPerson: false,
    score: -999,
    reasons: ["-999: dead link (404)"],
  };
  return out;
}

const pageScore = scorePersonFromHtml(html);


    score += pageScore.score;
    reasons.push(...pageScore.reasons);

    // Decision threshold:
    // >= 40 is “pretty clearly a person entry”
    const isPerson = score >= 40;

    const out: ClassifyResult = {
      name: lead.name,
      url: lead.url,
      isPerson,
      score,
      reasons,
    };

    return out;
  });

  const peopleSet = new Set(results.filter((r) => r.isPerson).map((r) => r.url));

  const people = leads.filter((l) => peopleSet.has(l.url));
  const nonPeople = leads.filter((l) => !peopleSet.has(l.url));

  // Stable ordering
  people.sort((a, b) => a.name.localeCompare(b.name));
  nonPeople.sort((a, b) => a.name.localeCompare(b.name));

  await fs.writeFile(OUT_PEOPLE, JSON.stringify(people, null, 2), "utf8");
  await fs.writeFile(OUT_NONPEOPLE, JSON.stringify(nonPeople, null, 2), "utf8");
  await fs.writeFile(OUT_REPORT, JSON.stringify(results, null, 2), "utf8");

  console.log(`Done.`);
  console.log(`People: ${people.length}`);
  console.log(`Non-people: ${nonPeople.length}`);
  console.log(`Wrote ${path.basename(OUT_PEOPLE)}`);
  console.log(`Wrote ${path.basename(OUT_NONPEOPLE)}`);
  console.log(`Wrote ${path.basename(OUT_REPORT)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
