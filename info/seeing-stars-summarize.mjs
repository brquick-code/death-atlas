import fs from "fs";
import { chromium } from "playwright";
import * as cheerio from "cheerio";

const URLS = [
  "https://www.seeing-stars.com/Died/2010s.shtml",
  "https://www.seeing-stars.com/Died/2000s.shtml",
  "https://www.seeing-stars.com/Died/90s.shtml",
  "https://www.seeing-stars.com/Died/80s.shtml",
  "https://www.seeing-stars.com/Died/70s.shtml",
  "https://www.seeing-stars.com/Died/60s.shtml",
  "https://www.seeing-stars.com/Died/50s_20s.shtml#20s",
];

const OUTFILE = "seeing-stars-summaries.txt";

const MONTH_RE =
  /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)/i;

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function looksLikeEntryLine(line) {
  const l = line.toLowerCase();
  // Keep lines that likely represent entries
  if (l.length < 20) return false;
  if (MONTH_RE.test(line)) return true;
  if (/\b(19\d{2}|20\d{2})\b/.test(line)) return true;
  if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(line)) return true;
  if (/\b(died|killed|murdered|suicide|accident|crash|overdose|shot)\b/.test(l)) return true;
  return false;
}

function tryParseFields(line) {
  // Seeing-Stars often uses hyphens/dashes separating fields
  const parts = line
    .replace(/[–—]/g, "-")
    .split(" - ")
    .map(clean)
    .filter(Boolean);

  let name = "";
  let date = "";
  let location = "";
  let cause = "";

  if (parts.length >= 2) {
    name = parts[0];
    // Find date-ish part
    const dateIdx = parts.findIndex((p) => MONTH_RE.test(p) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(p) || /\b(19\d{2}|20\d{2})\b/.test(p));
    if (dateIdx >= 0) {
      date = parts[dateIdx];
      // Remaining parts after date commonly: location then cause
      const after = parts.slice(dateIdx + 1);
      if (after.length >= 1) location = after[0] || "";
      if (after.length >= 2) cause = after.slice(1).join(" - ");
    } else {
      // If no clear date, just fill sequentially
      date = parts[1] || "";
      location = parts[2] || "";
      cause = parts.slice(3).join(" - ");
    }
  } else {
    // Fallback: name is first chunk before "(" or "," if present
    name = clean(line.split("(")[0].split(",")[0]);
  }

  return { name, date, location, cause };
}

function extractWikipediaLinks($) {
  const map = new Map(); // key: lower(name-ish) -> wiki url
  $("a[href*='wikipedia.org/wiki/']").each((_, a) => {
    const href = $(a).attr("href");
    const text = clean($(a).text());
    if (!href) return;
    if (!text) return;
    map.set(text.toLowerCase(), href);
  });
  return map;
}

function bestWikiForName(wikiMap, name) {
  if (!name) return "";
  const key = name.toLowerCase();
  if (wikiMap.has(key)) return wikiMap.get(key);

  // Loose matching: strip punctuation
  const norm = key.replace(/[^a-z0-9 ]+/g, "").trim();
  for (const [k, v] of wikiMap.entries()) {
    const kn = k.replace(/[^a-z0-9 ]+/g, "").trim();
    if (kn === norm) return v;
  }
  return "";
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const out = [];
  out.push("Seeing-Stars Summaries");
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push("Fields: Name | Date of death | Location | Cause | Wikipedia (if available)");
  out.push("");

  let total = 0;

  for (const url of URLS) {
    out.push("=".repeat(90));
    out.push(`SOURCE: ${url}`);
    out.push("=".repeat(90));

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const html = await page.content();
      const $ = cheerio.load(html);

      // convert <br> to newline so entries become lines
      $("br").replaceWith("\n");

      const wikiMap = extractWikipediaLinks($);

      const text = $.root().text();
      const lines = text
        .split("\n")
        .map(clean)
        .filter(Boolean)
        .filter(looksLikeEntryLine);

      // Deduplicate exact lines
      const seen = new Set();
      for (const line of lines) {
        if (seen.has(line)) continue;
        seen.add(line);

        const { name, date, location, cause } = tryParseFields(line);
        const wiki = bestWikiForName(wikiMap, name);

        total++;
        out.push(`- Name: ${name}`);
        out.push(`  Date of death: ${date}`);
        out.push(`  Location: ${location}`);
        out.push(`  Cause: ${cause}`);
        out.push(`  Wikipedia: ${wiki}`);
        out.push(`  Raw: ${line}`);
        out.push("");
      }

      out.push("");
    } catch (e) {
      out.push(`[ERROR] ${String(e)}`);
      out.push("");
    }
  }

  await browser.close();

  fs.writeFileSync(OUTFILE, out.join("\n"), "utf8");
  console.log(`Done. Wrote ${total} entries to ${OUTFILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
