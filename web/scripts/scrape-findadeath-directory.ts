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

const DIRECTORY_URL = "https://findadeath.com/the-directory/";
const OUT_JSON = path.join(process.cwd(), "findadeath-directory-leads.json");
const DEBUG_DIR = path.join(process.cwd(), "debug-findadeath");
const DEBUG_HTML = path.join(DEBUG_DIR, "findadeath-directory.html");

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

function normalizeUrl(href: string): string | null {
  const h = href.trim();
  if (!h) return null;
  if (h.startsWith("mailto:")) return null;
  if (h.startsWith("tel:")) return null;
  if (h.startsWith("#")) return null;

  // Absolute
  if (h.startsWith("http://") || h.startsWith("https://")) return h;

  // Relative to site
  if (h.startsWith("/")) return `https://findadeath.com${h}`;

  return null;
}

function parseYears(adjacent: string): { birthYear: number | null; deathYear: number | null } {
  const t = cleanText(adjacent);

  // Common formats:
  // "1923 – 2006"
  // "1923-2006"
  // "(1923 – 2006)"
  // "1923 –"
  // "– 2006"
  const m = t.match(/(\d{4})\s*[–-]\s*(\d{4})/);
  if (m) return { birthYear: Number(m[1]), deathYear: Number(m[2]) };

  // Sometimes only one side appears in text blobs
  const m2 = t.match(/(\d{4})\s*[–-]\s*$/);
  if (m2) return { birthYear: Number(m2[1]), deathYear: null };

  const m3 = t.match(/^[–-]\s*(\d{4})/);
  if (m3) return { birthYear: null, deathYear: Number(m3[1]) };

  return { birthYear: null, deathYear: null };
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "death-atlas-bot/1.0 (findadeath directory scraper)",
      Accept: "text/html,*/*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function pickContentRoot($: cheerio.CheerioAPI) {
  // WordPress themes usually put main article text in one of these.
  // We'll pick the first that actually exists and is non-empty.
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
    if (el && el.length && cleanText(el.text()).length > 200) return el;
  }
  return $("body");
}


function isLikelyPersonLink(url: string): boolean {
  // Directory entries tend to link to person pages (not category pages, not the directory itself).
  // This is a heuristic; we can tighten later if needed.
  const u = url.toLowerCase();
  if (!u.startsWith("https://findadeath.com/")) return false;
  if (u.includes("/the-directory")) return false;
  if (u.includes("/category/")) return false;
  if (u.includes("/tag/")) return false;
  if (u.includes("/page/")) return false;
  if (u.includes("/wp-content/")) return false;
  if (u.includes("/wp-json/")) return false;
  return true;
}

async function main() {
  console.log(`Fetching ${DIRECTORY_URL}`);
  const html = await fetchHtml(DIRECTORY_URL);

  await fs.mkdir(DEBUG_DIR, { recursive: true });
  await fs.writeFile(DEBUG_HTML, html, "utf8");
  console.log(`Saved raw HTML -> ${DEBUG_HTML}`);

  const $ = cheerio.load(html);

  const root = pickContentRoot($);

  // Grab all anchors inside the main content
  const anchors = root.find("a").toArray();

  const seen = new Set<string>();
  const leads: Lead[] = [];

  for (const a of anchors) {
    const $a = $(a);
    const nameRaw = cleanText($a.text());
    const hrefRaw = ($a.attr("href") || "").trim();
    const url = normalizeUrl(hrefRaw);

    if (!url) continue;
    if (!isLikelyPersonLink(url)) continue;

    // Basic name sanity
    if (!nameRaw) continue;
    if (nameRaw.length < 2) continue;
    if (/^(click here|here|more|read more)$/i.test(nameRaw)) continue;

    // Try to parse years from nearby text:
    // Usually in the same parent node after the <a>, e.g. "Name 1923 – 2006"
    let neighborText = "";

    // 1) next sibling text node
    const next = (a as any).nextSibling as any;
    if (next && next.type === "text" && typeof next.data === "string") {
      neighborText = next.data;
    }

    // 2) fallback: parent text minus anchor text (can be noisy but works)
    if (!neighborText) {
      const parentText = cleanText($a.parent().text());
      if (parentText && parentText !== nameRaw) {
        neighborText = parentText.replace(nameRaw, "").trim();
      }
    }

    const { birthYear, deathYear } = parseYears(neighborText);

    // De-dupe by URL (most stable)
    if (seen.has(url)) continue;
    seen.add(url);

    leads.push({
      name: nameRaw,
      url,
      birthYear,
      deathYear,
      source: "findadeath",
      sourceUrl: DIRECTORY_URL,
    });
  }

  // Sort for stability (nice diffs)
  leads.sort((a, b) => a.name.localeCompare(b.name));

  await fs.writeFile(OUT_JSON, JSON.stringify(leads, null, 2), "utf8");
  console.log(`Done. Found ${leads.length} directory entries.`);
  console.log(`Wrote ${path.basename(OUT_JSON)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
