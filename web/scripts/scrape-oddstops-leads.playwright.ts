/**
 * OddStops lead scraper (Playwright) — diagnostic + robust link extraction
 *
 * Step 1: Load category page and extract "place detail" URLs from:
 *   - a[href] that includes place.php (case-insensitive)
 *   - onclick attributes containing place.php
 *   - raw HTML regex scan for place.php?... patterns
 *
 * Step 2: Visit each detail page and extract ONLY:
 *   - subject_name
 *   - latitude
 *   - longitude
 *   - source_url (detail page URL)
 *
 * No descriptions copied.
 */

import fs from "fs";
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

// ================= CONFIG =================

const START_URL =
  process.env.START_URL || "https://oddstops.com/places.php?id=20";

const OUTPUT_FILE = process.env.OUTPUT_FILE || "oddstops-leads.json";

const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "1500", 10);
const MAX_DETAILS = parseInt(process.env.MAX_DETAILS || "150", 10);

// Always save debug HTML when we can't find links
const DEBUG_DIR = process.env.DEBUG_DIR || "oddstops-debug";

// Supabase (optional)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ENABLE_SUPABASE = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

// ================= TYPES =================

type OddStopLead = {
  subject_name: string;
  latitude: number;
  longitude: number;
  source_url: string;
};

// ================= HELPERS =================

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toAbsoluteUrl(href: string): string {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  return `https://oddstops.com/${href.replace(/^\/+/, "")}`;
}

/**
 * Extract coordinates from a blob of text or HTML.
 * Looks for:
 *  - lat=.. lon=..
 *  - latitude=.. longitude=..
 *  - @lat,lon (Google Maps)
 *  - "lat":.. "lng":..
 */
function extractLatLonFromText(blob: string): { lat: number; lon: number } | null {
  if (!blob) return null;

  const q1 = blob.match(
    /(?:^|[?&\s])lat(?:itude)?=([-]?\d{1,3}\.\d+)[^\d-]+(?:lon|lng|longitude)=([-]?\d{1,3}\.\d+)/i
  );
  if (q1) return { lat: parseFloat(q1[1]), lon: parseFloat(q1[2]) };

  const q2 = blob.match(/@([-]?\d{1,3}\.\d+),([-]?\d{1,3}\.\d+)/);
  if (q2) return { lat: parseFloat(q2[1]), lon: parseFloat(q2[2]) };

  const q3 = blob.match(
    /"lat"\s*:\s*([-]?\d{1,3}\.\d+)[\s\S]{0,60}?"(?:lng|lon)"\s*:\s*([-]?\d{1,3}\.\d+)/i
  );
  if (q3) return { lat: parseFloat(q3[1]), lon: parseFloat(q3[2]) };

  const q4 = blob.match(
    /latitude\s*[:=]\s*([-]?\d{1,3}\.\d+)[\s,;]+longitude\s*[:=]\s*([-]?\d{1,3}\.\d+)/i
  );
  if (q4) return { lat: parseFloat(q4[1]), lon: parseFloat(q4[2]) };

  return null;
}

function cleanName(name: string): string {
  return (name || "").replace(/\s+/g, " ").trim();
}

async function getPageHtml(page: any): Promise<string> {
  await page.waitForLoadState("domcontentloaded");
  // sometimes content comes in after initial DOMContentLoaded
  await page.waitForTimeout(500);
  await sleep(REQUEST_DELAY_MS);
  return await page.content();
}

function extractPlaceUrlsFromHtml(html: string): string[] {
  const urls: string[] = [];

  // Capture strings like: place.php?something (case-insensitive)
  // Handles quotes or plain text occurrences.
  const re = /place\.php\?[^"'<>\s]+/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    urls.push(toAbsoluteUrl(m[0]));
  }

  return urls;
}

// ================= MAIN =================

async function run() {
  console.log("=== OddStops Lead Scraper (Playwright, diagnostic) ===");
  console.log("Start URL:", START_URL);

  ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  // -------- Step 1: Load category page --------
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  // Try a bit harder in case it loads via JS
  await page.waitForTimeout(800);
  await page.waitForLoadState("networkidle").catch(() => {});

  const finalUrl = page.url();
  const title = await page.title().catch(() => "");
  const categoryHtml = await getPageHtml(page);

  fs.writeFileSync(`${DEBUG_DIR}/category.html`, categoryHtml, "utf-8");

  const $ = cheerio.load(categoryHtml);

  const anchorCount = $("a").length;
  console.log("Final URL:", finalUrl);
  console.log("Title:", title || "(no title)");
  console.log("Anchor tags found:", anchorCount);

  // 1) Extract from a[href] where href contains place.php (case-insensitive)
  const hrefUrls: string[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) return;
    if (/place\.php/i.test(href)) hrefUrls.push(toAbsoluteUrl(href));
  });

  // 2) Extract from onclick="...place.php?...."
  const onclickUrls: string[] = [];
  $("[onclick]").each((_, el) => {
    const onclick = ($(el).attr("onclick") || "").trim();
    if (!onclick) return;

    const match = onclick.match(/place\.php\?[^"'<> )]+/i);
    if (match) onclickUrls.push(toAbsoluteUrl(match[0]));
  });

  // 3) Extract from raw HTML regex scan
  const regexUrls = extractPlaceUrlsFromHtml(categoryHtml);

  // Combine + dedupe
  const combined = Array.from(new Set([...hrefUrls, ...onclickUrls, ...regexUrls]));

  console.log(`place.php URLs found (href): ${hrefUrls.length}`);
  console.log(`place.php URLs found (onclick): ${onclickUrls.length}`);
  console.log(`place.php URLs found (regex): ${regexUrls.length}`);
  console.log(`Total unique detail candidates: ${combined.length}`);

  // If we still found none, dump a short text snippet to help diagnose
  if (combined.length === 0) {
    const bodyText = cleanName($("body").text()).slice(0, 400);
    console.log("No place.php links found.");
    console.log("Body text snippet:", bodyText || "(empty)");
    console.log(`Saved debug HTML to: ${DEBUG_DIR}\\category.html`);
    await browser.close();
    return;
  }

  const detailUrls = combined.slice(0, MAX_DETAILS);

  console.log(`Unique detail pages to visit (capped): ${detailUrls.length}`);

  // -------- Step 2: Visit each detail page and extract coordinates --------
  const leads: OddStopLead[] = [];

  let visited = 0;
  let noCoords = 0;
  let errors = 0;

  for (const url of detailUrls) {
    visited++;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      await page.waitForLoadState("networkidle").catch(() => {});

      const html = await getPageHtml(page);

      if (visited <= 3) {
        fs.writeFileSync(`${DEBUG_DIR}/detail_${visited}.html`, html, "utf-8");
      }

      const $$ = cheerio.load(html);

      const h1 = cleanName($$("h1").first().text());
      const pageTitle = cleanName($$("title").first().text());

      const subject_name =
        h1 ||
        (pageTitle ? pageTitle.replace(/\s*\|\s*OddStops.*$/i, "").trim() : "") ||
        "Unknown";

      const allHrefs = $$("a[href]")
        .map((_, a) => $$(a).attr("href") || "")
        .get()
        .join("\n");

      const blob = `${html}\n\n${allHrefs}`;

      const coords = extractLatLonFromText(blob);

      if (!coords) {
        noCoords++;
        continue;
      }

      leads.push({
        subject_name,
        latitude: coords.lat,
        longitude: coords.lon,
        source_url: url
      });
    } catch (e) {
      errors++;
      console.warn(`Error on ${url}:`, e);
      continue;
    }
  }

  await browser.close();

  console.log(`Visited: ${visited}`);
  console.log(`Leads with coords: ${leads.length}`);
  console.log(`No coords found: ${noCoords}`);
  console.log(`Errors: ${errors}`);

  // Deduplicate by url + coords
  const unique = Array.from(
    new Map(leads.map(l => [`${l.source_url}|${l.latitude}|${l.longitude}`, l])).values()
  );

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2), "utf-8");
  console.log(`Wrote ${unique.length} leads → ${OUTPUT_FILE}`);

  // -------- Optional Supabase upsert --------
  if (ENABLE_SUPABASE) {
    console.log("Upserting into Supabase: oddstops_leads");
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { error } = await supabase
      .from("oddstops_leads")
      .upsert(
        unique.map(l => ({
          subject_name: l.subject_name,
          latitude: l.latitude,
          longitude: l.longitude,
          source_url: l.source_url,
          source_site: "OddStops"
        })),
        { onConflict: "source_url" }
      );

    if (error) console.error("Supabase error:", error);
    else console.log("Supabase upsert complete");
  } else {
    console.log("Supabase disabled (missing env vars)");
  }

  console.log("Done.");
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
