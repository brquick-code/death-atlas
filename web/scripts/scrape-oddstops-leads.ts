/**
 * OddStops lead scraper (Playwright)
 * Uses a real browser context to avoid basic WAF 403 blocks.
 *
 * Extracts ONLY:
 *  - subject_name
 *  - latitude
 *  - longitude
 *  - source_url
 */

import fs from "fs";
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const START_URL =
  process.env.START_URL || "https://oddstops.com/places.php?id=20";

const OUTPUT_FILE = process.env.OUTPUT_FILE || "oddstops-leads.json";
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "1500", 10);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ENABLE_SUPABASE = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

type OddStopLead = {
  subject_name: string;
  latitude: number;
  longitude: number;
  source_url: string;
};

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function extractCoordinatesFromLink(href: string): { lat: number; lon: number } | null {
  const latMatch = href.match(/lat=(-?\d+\.\d+)/i);
  const lonMatch = href.match(/lon=(-?\d+\.\d+)/i);
  if (!latMatch || !lonMatch) return null;
  return { lat: parseFloat(latMatch[1]), lon: parseFloat(lonMatch[1]) };
}

function toAbsoluteUrl(href: string): string {
  if (href.startsWith("http")) return href;
  return `https://oddstops.com/${href.replace(/^\/+/, "")}`;
}

async function run() {
  console.log("=== OddStops Lead Scraper (Playwright) ===");
  console.log("Start URL:", START_URL);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await sleep(REQUEST_DELAY_MS);

  const html = await page.content();
  await browser.close();

  const $ = cheerio.load(html);

  const leads: OddStopLead[] = [];

  $("a[href*='place.php']").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();

    if (!href || !text) return;

    const coords = extractCoordinatesFromLink(href);
    if (!coords) return;

    leads.push({
      subject_name: text,
      latitude: coords.lat,
      longitude: coords.lon,
      source_url: toAbsoluteUrl(href),
    });
  });

  console.log(`Found ${leads.length} raw leads`);

  const unique = Array.from(
    new Map(leads.map(l => [`${l.subject_name}|${l.latitude}|${l.longitude}`, l])).values()
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

  console.log("Done.");
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
