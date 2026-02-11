import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const TABLE = "findadeath_leads";

// Start at the directory root (you already found it)
const START_URL = process.env.START_URL || "https://findadeath.com/the-directory/";

// How many directory pages to crawl (pagination). 0 = unlimited (not recommended).
const MAX_DIR_PAGES = Number(process.env.MAX_DIR_PAGES || "25");

// Throttle
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "300");

// Regex to identify "entry pages" vs navigation.
// You can override this if needed.
const ENTRY_HREF_REGEX =
  process.env.ENTRY_HREF_REGEX ||
  // default: any URL under /the-directory/ that is NOT the root and NOT /page/N/
  "^https?://(www\\.)?findadeath\\.com/the-directory/(?!page/)(?!$).+/?$";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "DeathAtlas/1.0 (research)",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function absolutize(base: string, href: string) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function extractAnchors(baseUrl: string, html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];

  // Simple anchor capture (good enough for WP pages)
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const hrefRaw = m[1].trim();
    if (!hrefRaw) continue;

    // strip tags from link text
    const text = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const href = absolutize(baseUrl, hrefRaw);

    out.push({ href, text });
  }

  return out;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

async function upsertBatch(rows: { name: string; url: string }[]) {
  if (rows.length === 0) return;

  const payload = rows.map((r) => ({
    name_raw: r.name,
    findadeath_url: r.url,
    status: "new",
  }));

  const { error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: "findadeath_url" });

  if (error) throw new Error(error.message);
}

/**
 * Crawl directory pages:
 * - Start at /the-directory/
 * - Follow pagination links like /the-directory/page/2/
 */
async function crawlDirectoryPages(startUrl: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue: string[] = [startUrl];

  const dirPages: string[] = [];
  while (queue.length > 0) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);

    dirPages.push(url);

    if (MAX_DIR_PAGES > 0 && dirPages.length >= MAX_DIR_PAGES) break;

    await sleep(MIN_DELAY_MS);
    const html = await fetchHtml(url);

    const anchors = extractAnchors(url, html);
    const pageLinks = anchors
      .map((a) => a.href)
      .filter((h) => /findadeath\.com\/the-directory\/page\/\d+\/?/i.test(h));

    for (const p of uniq(pageLinks)) {
      if (!seen.has(p)) queue.push(p);
    }
  }

  return dirPages;
}

async function run() {
  console.log("=== Import Find-A-Death Directory → findadeath_leads ===");
  console.log(
    JSON.stringify(
      { START_URL, MAX_DIR_PAGES, MIN_DELAY_MS, ENTRY_HREF_REGEX },
      null,
      2
    )
  );

  // 1) Collect directory pages
  const dirPages = await crawlDirectoryPages(START_URL);
  console.log(`Directory pages discovered: ${dirPages.length}`);
  console.log("Sample directory pages:", dirPages.slice(0, 5));

  // 2) Extract entry links from directory pages
  const entryRe = new RegExp(ENTRY_HREF_REGEX, "i");
  const entries: { name: string; url: string }[] = [];

  for (let i = 0; i < dirPages.length; i++) {
    const pageUrl = dirPages[i];
    await sleep(MIN_DELAY_MS);
    const html = await fetchHtml(pageUrl);

    const anchors = extractAnchors(pageUrl, html);

for (const a of anchors) {
  const href = a.href;
  const text = a.text;

  if (!text || text.length < 3) continue;

  // Hard excludes
  if (!href.includes("findadeath.com")) continue;
  if (href.includes("/the-directory")) continue;
  if (href.includes("/page/")) continue;
  if (href.includes("?share=")) continue;
  if (href.includes("#")) continue;

  // Filter obvious UI junk
  if (/click to share|skip to|top|more|facebook|twitter|reddit|linkedin|tumblr|pinterest|whatsapp|telegram/i.test(text))
    continue;

  // Person names usually look like names
  // (at least one space, mostly letters)
  if (!/^[A-Za-z.'\- ]+$/.test(text)) continue;
  if (!text.includes(" ")) continue;

  entries.push({
    name: text.trim(),
    url: href.split("?")[0], // strip tracking params
  });
}


    if ((i + 1) % 5 === 0) {
      console.log(`Scanned ${i + 1}/${dirPages.length} directory pages…`);
    }
  }

  // de-dupe by url
  const byUrl = new Map<string, { name: string; url: string }>();
  for (const e of entries) {
    if (!byUrl.has(e.url)) byUrl.set(e.url, e);
  }
  const uniqueEntries = Array.from(byUrl.values());

  console.log(`Entry links found: ${uniqueEntries.length}`);
  console.log("Sample entries:");
  console.log(uniqueEntries.slice(0, 15));

  if (uniqueEntries.length === 0) {
    console.log(
      "\nNo entry links matched ENTRY_HREF_REGEX.\n" +
        "Next step: loosen ENTRY_HREF_REGEX to match the actual person-page URL format.\n" +
        "Tip: open the directory page in your browser, click a name, copy the URL, and we’ll set a regex for it."
    );
    return;
  }

  // 3) Upsert into DB
  const BATCH = 200;
  let total = 0;

  for (let i = 0; i < uniqueEntries.length; i += BATCH) {
    const slice = uniqueEntries.slice(i, i + BATCH);
    await upsertBatch(slice);
    total += slice.length;
    console.log(`Upserted ~${total}`);
    await sleep(200);
  }

  console.log("=== Done ===");
}

run().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});
