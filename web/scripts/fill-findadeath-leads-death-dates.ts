import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const TABLE = process.env.TABLE || "findadeath_leads";
const DB_BATCH = Number(process.env.DB_BATCH || "50");
const CONCURRENCY = Number(process.env.CONCURRENCY || "3");
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || "350");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || "20000");
const RETRIES = Number(process.env.RETRIES || "2");
const LIMIT = Number(process.env.LIMIT || "0");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "DeathAtlas/1.0 (local research)",
        Accept: "text/html",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function strip(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Best-effort extraction:
 * Find-A-Death pages commonly include a death date near the top.
 * We scan for a few patterns and return the first strong hit.
 */
function extractDeathDateRaw(text: string): string | null {
  const t = text;

  // Month name formats: "January 2, 2003" / "Jan. 2, 2003"
  const month =
    /\b(Jan(?:uary)?\.?|Feb(?:ruary)?\.?|Mar(?:ch)?\.?|Apr(?:il)?\.?|May\.?|Jun(?:e)?\.?|Jul(?:y)?\.?|Aug(?:ust)?\.?|Sep(?:t|tember)?\.?|Oct(?:ober)?\.?|Nov(?:ember)?\.?|Dec(?:ember)?\.?)\s+\d{1,2},\s+\d{4}\b/;
  const m1 = t.match(month);
  if (m1) return m1[0];

  // Numeric formats: "01/02/2003" or "1-2-2003"
  const numeric = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/;
  const m2 = t.match(numeric);
  if (m2) return m2[0];

  // “Died:” or “Death:” label
  const labeled = /\b(?:Died|Death(?:\s*Date)?)\s*:\s*([A-Za-z0-9,\/\-\.\s]{6,30})\b/;
  const m3 = t.match(labeled);
  if (m3?.[1]) return m3[1].trim();

  return null;
}

/**
 * Parse common date strings into YYYY-MM-DD.
 * Returns null if parsing fails.
 */
function parseToISODate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // Numeric mm/dd/yyyy
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    let yy = Number(m[3]);
    if (yy < 100) yy += yy >= 70 ? 1900 : 2000;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const iso = `${yy.toString().padStart(4, "0")}-${mm
        .toString()
        .padStart(2, "0")}-${dd.toString().padStart(2, "0")}`;
      return iso;
    }
  }

  // Month name parsing (US English)
  // Use Date.parse on a normalized string
  const normalized = s.replace(/\./g, "");
  const dt = new Date(normalized);
  if (!isNaN(dt.getTime())) {
    const yy = dt.getUTCFullYear();
    const mm = (dt.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = dt.getUTCDate().toString().padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  return null;
}

async function fetchBatch(offset: number, limit: number) {
  // Rows that have a URL and are missing parsed date
  const q = supabase
    .from(TABLE)
    .select("id,name_raw,findadeath_url,death_date_raw,death_date")
    .not("findadeath_url", "is", null)
    .is("death_date", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error } = await q;
  if (error) throw new Error(`DB fetch error: ${error.message}`);
  return data ?? [];
}

async function updateRow(id: number, death_date_raw: string | null, death_date_iso: string | null) {
  const payload: any = {
    death_date_raw: death_date_raw ?? null,
    death_date: death_date_iso ?? null,
  };
  const { error } = await supabase.from(TABLE).update(payload).eq("id", id);
  if (error) throw new Error(`DB update error id=${id}: ${error.message}`);
}

async function processOne(row: any) {
  const id = row.id as number;
  const url = String(row.findadeath_url || "").trim();
  if (!url) return { ok: false, id, err: "missing url" };

  await sleep(MIN_DELAY_MS);

  let lastErr: any = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const html = await fetchWithTimeout(url, TIMEOUT_MS);
      const text = strip(html);
      const raw = extractDeathDateRaw(text);
      const iso = parseToISODate(raw);

      await updateRow(id, raw, iso);
      return { ok: true, id, raw, iso };
    } catch (e: any) {
      lastErr = e;
      await sleep(500 * (attempt + 1));
    }
  }

  return { ok: false, id, err: lastErr?.message || String(lastErr) };
}

async function run() {
  console.log("=== Fill FindADeath Lead Death Dates ===");
  console.log(
    JSON.stringify(
      { TABLE, DB_BATCH, CONCURRENCY, MIN_DELAY_MS, TIMEOUT_MS, RETRIES, LIMIT },
      null,
      2
    )
  );

  let offset = 0;
  let processed = 0;
  let ok = 0;
  let fail = 0;

  const inFlight = new Set<Promise<void>>();
  const add = (p: Promise<void>) => {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  };

  while (true) {
    if (LIMIT > 0 && processed >= LIMIT) break;

    const remaining = LIMIT > 0 ? Math.min(DB_BATCH, LIMIT - processed) : DB_BATCH;
    const batch = await fetchBatch(offset, remaining);
    if (batch.length === 0) {
      console.log("No more rows. Done.");
      break;
    }

    offset += batch.length;
    let i = 0;

    while (i < batch.length) {
      while (inFlight.size < CONCURRENCY && i < batch.length) {
        const row = batch[i++];

        const task = processOne(row)
          .then((r) => {
            processed++;
            if (r.ok) {
              ok++;
              console.log(`OK   id=${r.id} raw="${r.raw ?? ""}" iso="${r.iso ?? ""}"`);
            } else {
              fail++;
              console.log(`FAIL id=${r.id} err="${r.err}"`);
            }
          })
          .catch((e) => {
            processed++;
            fail++;
            console.log(`FAIL unexpected err="${e?.message || e}"`);
          });

        add(task);
      }
      if (inFlight.size >= CONCURRENCY) await Promise.race(inFlight);
    }

    while (inFlight.size > 0) await Promise.race(inFlight);

    console.log(`Progress: processed=${processed} ok=${ok} fail=${fail}`);
  }

  console.log("=== Done ===");
  console.log(`processed=${processed} ok=${ok} fail=${fail}`);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
