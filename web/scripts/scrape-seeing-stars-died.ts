/**
 * Seeing-Stars "Died" pages are NOT authoritative.
 * This script only extracts NAME LEADS (and keeps some raw context),
 * then writes a JSON file you can verify against Wikidata.
 *
 * Output:
 *  - seeing-stars-died-leads.json
 *  - debug-seeing-stars/<page>.html
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import iconv from "iconv-lite";
import * as cheerio from "cheerio";

type Lead = {
  source: "seeing-stars";
  decade: string;
  name: string;
  rawContext?: string;
  url: string;
};

const PAGES: Array<{ decade: string; url: string; file: string }> = [
  { decade: "2020s", url: "https://www.seeing-stars.com/Died/2020s.shtml", file: "2020s.html" },
  { decade: "2010s", url: "https://www.seeing-stars.com/Died/2010s.shtml", file: "2010s.html" },
  { decade: "2000s", url: "https://www.seeing-stars.com/Died/2000s.shtml", file: "2000s.html" },
  { decade: "1990s", url: "https://www.seeing-stars.com/Died/90s.shtml", file: "90s.html" },
  { decade: "1980s", url: "https://www.seeing-stars.com/Died/80s.shtml", file: "80s.html" },
  { decade: "1970s", url: "https://www.seeing-stars.com/Died/70s.shtml", file: "70s.html" },
  { decade: "1960s", url: "https://www.seeing-stars.com/Died/60s.shtml", file: "60s.html" },
  { decade: "1950s-1920s", url: "https://www.seeing-stars.com/Died/50s_20s.shtml", file: "50s_20s.html" },
];

const DEBUG_DIR = path.join(process.cwd(), "debug-seeing-stars");
const OUT_FILE = path.join(process.cwd(), "seeing-stars-died-leads.json");

function cleanName(s: string): string {
  let t = (s || "").replace(/\s+/g, " ").trim();

  // Remove trailing punctuation / separators commonly used in old HTML
  t = t.replace(/^[\-–—•:\s]+/, "").replace(/[\-–—•:\s]+$/, "");

  // Drop obvious non-names / headings
  const bad = [
    /^died$/i,
    /^death$/i,
    /^where\s+they\s+died/i,
    /^where\s+they\s+passed/i,
    /^celebrity/i,
    /^notes?/i,
    /^updated/i,
  ];
  if (bad.some((re) => re.test(t))) return "";

  // Seeing-Stars sometimes bolds things like "NOTE" etc
  if (t.length < 2) return "";

  // Avoid items that look like whole sentences
  if (t.split(" ").length > 6 && /[.?!]/.test(t)) return "";

  return t;
}

function normalizeWhitespace(s: string): string {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function looksLikePersonName(name: string): boolean {
  // Very permissive: at least two "name-like" tokens, not all caps junk, not numeric
  if (!name) return false;
  if (/\d/.test(name)) return false;
  const tokens = name.split(" ").filter(Boolean);
  if (tokens.length < 2) return false;
  if (tokens.some((t) => t.length === 1 && t !== "J." && t !== "R.")) {
    // allow initials but not single-letter “names” generally
  }
  // reject obvious labels
  if (/^(mr|mrs|ms|dr)\.?$/i.test(tokens[0])) return false;
  return true;
}

/**
 * Extracts leads by:
 *  - taking all <b> elements
 *  - cleaning their text into a candidate name
 *  - capturing nearby text as "rawContext" (useful for debugging)
 */
function extractLeadsFromHtml(html: string, decade: string, url: string): Lead[] {
  const $ = cheerio.load(html);

  const leads: Lead[] = [];
  const seen = new Set<string>();

  $("b").each((_, el) => {
    const rawBold = $(el).text();
    const name = cleanName(rawBold);

    if (!looksLikePersonName(name)) return;

    // Grab a little context: parent text (with <br> converted)
    const parent = $(el).parent();
    let ctx = "";

    if (parent && parent.length) {
      // Clone parent HTML, convert <br> to \n, then strip tags
      const parentHtml = parent.html() || "";
      const ctxText = cheerio
        .load(parentHtml.replace(/<br\s*\/?>/gi, "\n"))
        .text();
      ctx = normalizeWhitespace(ctxText);
    }

    const key = `${decade}::${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    leads.push({
      source: "seeing-stars",
      decade,
      name,
      rawContext: ctx || undefined,
      url,
    });
  });

  return leads;
}

async function fetchWindows1252(url: string): Promise<{ text: string; encoding: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "death-atlas-bot/1.0 (leads-only; contact: local)",
      "Accept": "text/html,*/*",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  // Seeing-Stars pages are commonly Windows-1252
  const text = iconv.decode(buf, "windows-1252");
  return { text, encoding: "windows-1252" };
}

async function main() {
  await fs.mkdir(DEBUG_DIR, { recursive: true });

  const allLeads: Lead[] = [];

  for (const page of PAGES) {
    console.log(`Fetching ${page.url}`);
    const { text, encoding } = await fetchWindows1252(page.url);

    const debugPath = path.join(DEBUG_DIR, page.file);
    await fs.writeFile(debugPath, text, "utf8");

    const leads = extractLeadsFromHtml(text, page.decade, page.url);

    console.log(`  Encoding=${encoding} Parsed=${leads.length}`);
    for (const l of leads.slice(0, 10)) {
      console.log(`   - ${l.name}`);
    }
    if (leads.length > 10) console.log(`   ... +${leads.length - 10} more`);

    allLeads.push(...leads);
  }

  // De-dupe globally by name (keep earliest decade occurrence)
  const byName = new Map<string, Lead>();
  for (const lead of allLeads) {
    const k = lead.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, lead);
  }

  const deduped = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  await fs.writeFile(OUT_FILE, JSON.stringify(deduped, null, 2), "utf8");
  console.log(`Done. Total leads: ${deduped.length}`);
  console.log(`Wrote ${path.basename(OUT_FILE)}`);
  console.log(`Saved raw pages to ${DEBUG_DIR}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
