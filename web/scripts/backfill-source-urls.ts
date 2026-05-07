import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  console.error("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL). Put it in .env.local");
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY. Put it in .env.local (do NOT commit it).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isStatementTimeout(msg: string) {
  const m = msg.toLowerCase();
  return m.includes("statement timeout") || m.includes("canceling statement due to statement timeout");
}

async function callBatch(limitN: number) {
  const { data, error } = await supabase.rpc("backfill_source_urls_batch", {
    limit_n: limitN,
  });

  if (error) return { updated: 0, error: error.message };
  const updated = typeof data === "number" ? data : Number(data ?? 0);
  return { updated, error: "" };
}

async function main() {
  // Start settings (can be overridden by env vars)
  let batch = Number(process.env.BACKFILL_BATCH ?? "500");
  const minBatch = Number(process.env.BACKFILL_MIN_BATCH ?? "50");
  const maxBatch = Number(process.env.BACKFILL_MAX_BATCH ?? "500");
  const pauseMs = Number(process.env.BACKFILL_PAUSE_MS ?? "25");

  // Optional: after N consecutive successes, try to increase batch a little
  const rampEnabled = (process.env.BACKFILL_RAMP ?? "1") !== "0";
  const rampEvery = Number(process.env.BACKFILL_RAMP_EVERY ?? "25"); // every 25 successful rounds, bump batch
  const rampStep = Number(process.env.BACKFILL_RAMP_STEP ?? "50"); // increase by 50

  console.log("=== Backfill source_urls from source_url (adaptive batches) ===");
  console.log("SUPABASE_URL:", SUPABASE_URL);
  console.log("Start batch:", batch, "Min:", minBatch, "Max:", maxBatch, "Pause:", pauseMs, "ms");

  let total = 0;
  let rounds = 0;
  let consecutiveSuccess = 0;

  while (true) {
    rounds++;

    const startedAt = Date.now();
    const res = await callBatch(batch);
    const tookMs = Date.now() - startedAt;

    if (res.error) {
      // Handle timeout by reducing batch and retrying
      if (isStatementTimeout(res.error)) {
        consecutiveSuccess = 0;

        const next = Math.max(minBatch, Math.floor(batch / 2));
        console.log(
          `Round ${rounds}: TIMEOUT at batch=${batch} (took ~${tookMs}ms). Reducing to ${next} and retrying...`
        );

        batch = next;

        if (batch <= minBatch) {
          // still retry, but add a bigger pause to be gentle
          await sleep(Math.max(pauseMs, 200));
        } else {
          await sleep(pauseMs);
        }

        // don’t count this round as progress; try again
        continue;
      }

      // Non-timeout errors: print and stop
      console.error(`Round ${rounds}: RPC error: ${res.error}`);
      process.exit(1);
    }

    const updated = res.updated;
    total += updated;
    consecutiveSuccess++;

    console.log(
      `Round ${rounds}: updated ${updated.toLocaleString()} (batch=${batch}) in ${tookMs}ms (total ${total.toLocaleString()})`
    );

    if (!updated) {
      console.log("Done. No more rows to update.");
      break;
    }

    // gentle ramp-up if things are stable
    if (rampEnabled && consecutiveSuccess % rampEvery === 0 && batch < maxBatch) {
      const bumped = Math.min(maxBatch, batch + rampStep);
      if (bumped !== batch) {
        console.log(`Stable run detected. Increasing batch from ${batch} → ${bumped}`);
        batch = bumped;
      }
    }

    if (pauseMs > 0) await sleep(pauseMs);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e?.message ?? e);
    process.exit(1);
  });
