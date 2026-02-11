/**
 * Parse locally-saved OddStops HTML files by rendering with Playwright.
 *
 * Key improvement: aggressively FILTER out junk HTML (ads/iframes/_files) before rendering.
 *
 * Extracts ONLY:
 *  - subject_name
 *  - latitude
 *  - longitude
 *  - source_url
 */

import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

// ================= CONFIG =================

const INPUT_DIR = process.env.INPUT_DIR || "C:\\death-atlas\\oddstops_saved";
const OUTPUT_FILE =
  process.env.OUTPUT_FILE || "C:\\death-atlas\\web\\oddstops-leads.json";

// Safety controls
const MAX_FILES = parseInt(process.env.MAX_FILES || "5000", 10); // how many files to consider
const MAX_RENDER = parseInt(process.env.MAX_RENDER || "2500", 10); // how many filtered candidates to render
const RENDER_WAIT_MS = parseInt(process.env.RENDER_WAIT_MS || "650", 10);
const PROGRESS_EVERY = parseInt(process.env.PROGRESS_EVERY || "25", 10);

// Filtering knobs
const MIN_FILE_BYTES = parseInt(process.env.MIN_FILE_BYTES || "15000", 10); // skip tiny HTML (ads often tiny)
const SKIP_FILES_DIRS = (process.env.SKIP_FILES_DIRS || "true").toLowerCase() === "true";

// Optional debug
const DEBUG_DIR = process.env.DEBUG_DIR || "C:\\death-atlas\\web\\oddstops-render-debug";
const DEBUG_SAVE_FIRST = parseInt(process.env.DEBUG_SAVE_FIRST || "3", 10);

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
  local_file?: string;
};

// ================= HELPERS =================

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanName(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function listHtmlFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listHtmlFilesRecursive(full));
    else if (ent.isFile()) {
      const lower = ent.name.toLowerCase();
      if (lower.endsWith(".html") || lower.endsWith(".htm")) out.push(full);
    }
  }
  return out;
}

function pathLooksLikeFilesAssets(filePath: string): boolean {
  // Common “Save page complete” asset dir: Something_files
  const parts = filePath.toLowerCase().split(path.sep);
  return parts.some(p => p.endsWith("_files") || p === "files");
}

/**
 * DMS → decimal
 */
function dmsToDecimal(deg: number, min: number, sec: number, hemi: string): number {
  const sign = /[SW]/i.test(hemi) ? -1 : 1;
  return sign * (Math.abs(deg) + min / 60 + sec / 3600);
}

/**
 * Extract coords from text/HTML.
 * Supports:
 *  - lat=..&lon=.. (or lng)
 *  - @lat,lon
 *  - q=lat,lon ; ll=lat,lon ; center=lat,lon ; sll=lat,lon
 *  - "lat":.. "lng":..
 *  - latitude:.. longitude:..
 *  - plain "34.1234, -81.5678"
 *  - DMS "34°12'34.5\"N 81°23'45.6\"W"
 */
function extractLatLonFromText(blob: string): { lat: number; lon: number } | null {
  if (!blob) return null;

  const q1 = blob.match(
    /(?:^|[?&\s])lat(?:itude)?=([-]?\d{1,3}\.\d+)[^\d-]+(?:lon|lng|longitude)=([-]?\d{1,3}\.\d+)/i
  );
  if (q1) {
    const lat = parseFloat(q1[1]);
    const lon = parseFloat(q1[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  const qMap = blob.match(
    /(?:[?&](?:q|ll|center|sll)=)([-]?\d{1,2}\.\d{3,})\s*,\s*([-]?\d{1,3}\.\d{3,})/i
  );
  if (qMap) {
    const lat = parseFloat(qMap[1]);
    const lon = parseFloat(qMap[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  const q2 = blob.match(/@([-]?\d{1,2}\.\d{3,}),\s*([-]?\d{1,3}\.\d{3,})/);
  if (q2) {
    const lat = parseFloat(q2[1]);
    const lon = parseFloat(q2[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  const q3 = blob.match(
    /"lat"\s*:\s*([-]?\d{1,2}\.\d+)[\s\S]{0,200}?"(?:lng|lon)"\s*:\s*([-]?\d{1,3}\.\d+)/i
  );
  if (q3) {
    const lat = parseFloat(q3[1]);
    const lon = parseFloat(q3[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  const q4 = blob.match(
    /latitude\s*[:=]\s*([-]?\d{1,2}\.\d+)[\s,;]+longitude\s*[:=]\s*([-]?\d{1,3}\.\d+)/i
  );
  if (q4) {
    const lat = parseFloat(q4[1]);
    const lon = parseFloat(q4[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  const plain = blob.match(/([-]?\d{1,2}\.\d{4,})\s*,\s*([-]?\d{1,3}\.\d{4,})/);
  if (plain) {
    const lat = parseFloat(plain[1]);
    const lon = parseFloat(plain[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  const dms = blob.match(
    /(\d{1,2})\s*°\s*(\d{1,2})\s*['’]\s*(\d{1,2}(?:\.\d+)?)\s*["”]?\s*([NS])[\s,;]+(\d{1,3})\s*°\s*(\d{1,2})\s*['’]\s*(\d{1,2}(?:\.\d+)?)\s*["”]?\s*([EW])/i
  );
  if (dms) {
    const lat = dmsToDecimal(+dms[1], +dms[2], +dms[3], dms[4]);
    const lon = dmsToDecimal(+dms[5], +dms[6], +dms[7], dms[8]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  return null;
}

function pickSubjectName($: cheerio.CheerioAPI): string {
  const h1 = cleanName($("h1").first().text());
  if (h1) return h1;

  const title = cleanName($("title").first().text());
  if (title) return title.replace(/\s*\|\s*OddStops.*$/i, "").trim();

  const h2 = cleanName($("h2").first().text());
  if (h2) return h2;

  return "Unknown";
}

function pickSourceUrl($: cheerio.CheerioAPI, renderedHtml: string, filePath: string): string {
  const og = $("meta[property='og:url']").attr("content");
  if (og && /^https?:\/\//i.test(og)) return og.trim();

  const canonical = $("link[rel='canonical']").attr("href");
  if (canonical && /^https?:\/\//i.test(canonical)) return canonical.trim();

  const m = renderedHtml.match(/https?:\/\/oddstops\.com\/place\.php\?[^"'<>\s]+/i);
  if (m?.[0]) return m[0];

  const anyOdd = $("a[href*='oddstops.com']").first().attr("href");
  if (anyOdd && /^https?:\/\//i.test(anyOdd)) return anyOdd.trim();

  return `file:///${filePath.replace(/\\/g, "/")}`;
}

function rawLooksLikeOddstopsPlace(raw: string): boolean {
  // Try to identify “real page” vs iframe/ad
  // Keywords from your screenshot UI:
  const hits = [
    "GPS Coordinates",
    "Get Directions",
    "Location",
    "Apple Maps",
    "Google Maps",
  ];

  if (/oddstops\.com/i.test(raw)) return true;
  if (hits.some(k => raw.includes(k))) return true;

  // Also accept pages that already contain obvious coordinate patterns
  if (/@[-]?\d{1,2}\.\d{3,},\s*[-]?\d{1,3}\.\d{3,}/.test(raw)) return true;
  if (/(?:[?&](?:q|ll|center|sll)=)[-]?\d{1,2}\.\d{3,}\s*,\s*[-]?\d{1,3}\.\d{3,}/i.test(raw)) return true;
  if (/latitude\s*[:=]/i.test(raw) && /longitude\s*[:=]/i.test(raw)) return true;

  return false;
}

// ================= MAIN =================

async function run() {
  console.log("=== Parse Saved OddStops HTML (Playwright-rendered, filtered) ===");
  console.log("INPUT_DIR:", INPUT_DIR);
  console.log("OUTPUT_FILE:", OUTPUT_FILE);
  console.log("MIN_FILE_BYTES:", MIN_FILE_BYTES);
  console.log("SKIP_FILES_DIRS:", SKIP_FILES_DIRS);
  console.log("MAX_RENDER:", MAX_RENDER);
  console.log("RENDER_WAIT_MS:", RENDER_WAIT_MS);

  const all = listHtmlFilesRecursive(INPUT_DIR).slice(0, MAX_FILES);
  console.log(`Found ${all.length} HTML files (capped)`);

  // Filter pass (FAST)
  const candidates: string[] = [];
  let skippedFilesDir = 0;
  let skippedSmall = 0;
  let skippedNoSignals = 0;

  for (const f of all) {
    if (SKIP_FILES_DIRS && pathLooksLikeFilesAssets(f)) {
      skippedFilesDir++;
      continue;
    }

    const st = fs.statSync(f);
    if (st.size < MIN_FILE_BYTES) {
      skippedSmall++;
      continue;
    }

    const raw = fs.readFileSync(f, "utf-8");

    if (!rawLooksLikeOddstopsPlace(raw)) {
      skippedNoSignals++;
      continue;
    }

    candidates.push(f);
  }

  console.log(`Candidates after filter: ${candidates.length}`);
  console.log(`Skipped (in *_files dirs): ${skippedFilesDir}`);
  console.log(`Skipped (too small): ${skippedSmall}`);
  console.log(`Skipped (no OddStops signals): ${skippedNoSignals}`);

  const toRender = candidates.slice(0, MAX_RENDER);
  console.log(`Will render: ${toRender.length}`);

  if (toRender.length === 0) {
    console.log("No candidates to render. Try lowering MIN_FILE_BYTES or disabling SKIP_FILES_DIRS.");
    return;
  }

  ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const leads: OddStopLead[] = [];
  let hits = 0;
  let noCoords = 0;
  let errors = 0;

  for (let i = 0; i < toRender.length; i++) {
    const filePath = toRender[i];
    const fileUrl = `file:///${filePath.replace(/\\/g, "/")}`;

    try {
      await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(RENDER_WAIT_MS);

      const renderedHtml = await page.content();

      if (i < DEBUG_SAVE_FIRST) {
        fs.writeFileSync(path.join(DEBUG_DIR, `rendered_${i + 1}.html`), renderedHtml, "utf-8");
      }

      const $ = cheerio.load(renderedHtml);

      // IMPORTANT: some rendered files may still be ads; quick reject by title/body
      const title = cleanName($("title").text());
      const bodyText = cleanName($("body").text());
      if (/toxic foods for dogs|advert|sponsored/i.test(title + " " + bodyText)) {
        noCoords++;
        continue;
      }

      const hrefBlob = $("a[href]")
        .map((_, a) => $(a).attr("href") || "")
        .get()
        .join("\n");

      const blob = `${renderedHtml}\n\n${hrefBlob}\n\n${bodyText}`;
      const coords = extractLatLonFromText(blob);

      if (!coords) {
        noCoords++;
      } else {
        hits++;
        leads.push({
          subject_name: pickSubjectName($),
          latitude: coords.lat,
          longitude: coords.lon,
          source_url: pickSourceUrl($, renderedHtml, filePath),
          local_file: filePath,
        });
      }

      if ((i + 1) % PROGRESS_EVERY === 0 || i + 1 === toRender.length) {
        console.log(`Rendered ${i + 1}/${toRender.length} | hits: ${hits} | no: ${noCoords} | err: ${errors}`);
      }
    } catch {
      errors++;
    }
  }

  await browser.close();

  console.log(`Hits (coords found): ${hits}`);
  console.log(`No coords: ${noCoords}`);
  console.log(`Errors: ${errors}`);

  const unique = Array.from(
    new Map(leads.map(l => [`${l.source_url}|${l.latitude}|${l.longitude}`, l])).values()
  );

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2), "utf-8");
  console.log(`Wrote ${unique.length} leads → ${OUTPUT_FILE}`);

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
          source_site: "OddStops",
        })),
        { onConflict: "source_url" }
      );

    if (error) console.error("Supabase error:", error);
    else console.log("Supabase upsert complete");
  } else {
    console.log("Supabase disabled (missing env vars)");
  }

  console.log("Debug samples saved to:", DEBUG_DIR);
  console.log("Done.");
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
