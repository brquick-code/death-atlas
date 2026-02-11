/**
 * Parse locally-saved OddStops HTML files (Cloudflare-safe, offline)
 *
 * Reads all .html/.htm files under INPUT_DIR (recursively) and extracts ONLY:
 *  - subject_name
 *  - latitude
 *  - longitude
 *  - source_url (best-effort: og:url / canonical / first oddstops link / fallback to "file://...")
 *
 * Writes:
 *  - OUTPUT_FILE (JSON)
 *
 * Optional:
 *  - Upsert into Supabase table "oddstops_leads" if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set
 */

import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

// ================= CONFIG =================

const INPUT_DIR =
  process.env.INPUT_DIR || path.resolve(process.cwd(), "..", "oddstops_saved");

const OUTPUT_FILE =
  process.env.OUTPUT_FILE || path.resolve(process.cwd(), "oddstops-leads.json");

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
  local_file?: string; // helpful for debugging; you can remove later if you want
};

// ================= HELPERS =================

function listHtmlFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listHtmlFilesRecursive(full));
    } else if (ent.isFile()) {
      const lower = ent.name.toLowerCase();
      if (lower.endsWith(".html") || lower.endsWith(".htm")) out.push(full);
    }
  }
  return out;
}

function cleanName(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/**
 * Extract coordinates from any text/HTML blob.
 * Supports common patterns:
 *  - lat=..&lon=.. (or lng)
 *  - @lat,lon (Google Maps)
 *  - "lat":.. "lng":..
 *  - latitude: .. longitude: ..
 */
function extractLatLonFromText(blob: string): { lat: number; lon: number } | null {
  if (!blob) return null;

  // lat=34.123&lon=-81.456 (or lng)
  const q1 = blob.match(
    /(?:^|[?&\s])lat(?:itude)?=([-]?\d{1,3}\.\d+)[^\d-]+(?:lon|lng|longitude)=([-]?\d{1,3}\.\d+)/i
  );
  if (q1) return { lat: parseFloat(q1[1]), lon: parseFloat(q1[2]) };

  // @34.123,-81.456
  const q2 = blob.match(/@([-]?\d{1,3}\.\d+),([-]?\d{1,3}\.\d+)/);
  if (q2) return { lat: parseFloat(q2[1]), lon: parseFloat(q2[2]) };

  // "lat":34.123 ... "lng":-81.456
  const q3 = blob.match(
    /"lat"\s*:\s*([-]?\d{1,3}\.\d+)[\s\S]{0,80}?"(?:lng|lon)"\s*:\s*([-]?\d{1,3}\.\d+)/i
  );
  if (q3) return { lat: parseFloat(q3[1]), lon: parseFloat(q3[2]) };

  // latitude: 34.123 longitude: -81.456
  const q4 = blob.match(
    /latitude\s*[:=]\s*([-]?\d{1,3}\.\d+)[\s,;]+longitude\s*[:=]\s*([-]?\d{1,3}\.\d+)/i
  );
  if (q4) return { lat: parseFloat(q4[1]), lon: parseFloat(q4[2]) };

  return null;
}

function pickSourceUrl($: cheerio.CheerioAPI, rawHtml: string, filePath: string): string {
  // 1) og:url
  const og = $("meta[property='og:url']").attr("content");
  if (og && /^https?:\/\//i.test(og)) return og.trim();

  // 2) canonical link
  const canonical = $("link[rel='canonical']").attr("href");
  if (canonical && /^https?:\/\//i.test(canonical)) return canonical.trim();

  // 3) first oddstops link on page
  const firstOddstopsHref =
    $("a[href*='oddstops.com']").first().attr("href") ||
    $("a[href^='https://oddstops.com']").first().attr("href") ||
    $("a[href^='http://oddstops.com']").first().attr("href");
  if (firstOddstopsHref && /^https?:\/\//i.test(firstOddstopsHref)) return firstOddstopsHref.trim();

  // 4) regex scan for oddstops place.php?...
  const m = rawHtml.match(/https?:\/\/oddstops\.com\/place\.php\?[^"'<>\s]+/i);
  if (m?.[0]) return m[0];

  // 5) fallback to file path
  return `file:///${filePath.replace(/\\/g, "/")}`;
}

function pickSubjectName($: cheerio.CheerioAPI): string {
  const h1 = cleanName($("h1").first().text());
  if (h1) return h1;

  const title = cleanName($("title").first().text());
  if (title) return title.replace(/\s*\|\s*OddStops.*$/i, "").trim();

  // fallback: first strong-ish header text
  const h2 = cleanName($("h2").first().text());
  if (h2) return h2;

  return "Unknown";
}

// ================= MAIN =================

async function run() {
  console.log("=== Parse Saved OddStops HTML (offline) ===");
  console.log("INPUT_DIR:", INPUT_DIR);
  console.log("OUTPUT_FILE:", OUTPUT_FILE);

  const files = listHtmlFilesRecursive(INPUT_DIR);
  console.log(`Found ${files.length} HTML files`);

  if (files.length === 0) {
    console.log("No .html/.htm files found. Check the folder path.");
    return;
  }

  const leads: OddStopLead[] = [];
  let withCoords = 0;
  let noCoords = 0;

  for (const filePath of files) {
    const rawHtml = fs.readFileSync(filePath, "utf-8");
    const $ = cheerio.load(rawHtml);

    const subject_name = pickSubjectName($);

    // Search for coords across:
    // - full HTML
    // - hrefs concatenated
    const hrefBlob = $("a[href]")
      .map((_, a) => $(a).attr("href") || "")
      .get()
      .join("\n");

    const blob = `${rawHtml}\n\n${hrefBlob}`;
    const coords = extractLatLonFromText(blob);

    if (!coords) {
      noCoords++;
      continue;
    }

    withCoords++;

    const source_url = pickSourceUrl($, rawHtml, filePath);

    leads.push({
      subject_name,
      latitude: coords.lat,
      longitude: coords.lon,
      source_url,
      local_file: filePath
    });
  }

  console.log(`Pages with coords: ${withCoords}`);
  console.log(`Pages without coords: ${noCoords}`);

  // Deduplicate by source_url + coords
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
