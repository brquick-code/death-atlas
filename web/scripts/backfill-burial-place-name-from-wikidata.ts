import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

type Row = {
  id: string;
  title: string | null;
  wikidata_id: string | null; // e.g. "Q42"
  burial_place_name: string | null;
  is_published: boolean | null;
};

type SparqlBinding = {
  person: { value: string };
  burialPlace?: { value: string };
  burialPlaceLabel?: { value: string };
};

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sparql(query: string) {
  const url =
    "https://query.wikidata.org/sparql?format=json&query=" +
    encodeURIComponent(query);

  const res = await fetch(url, {
    headers: {
      // Important: Wikidata asks for a descriptive UA.
      "User-Agent": "DeathAtlas/1.0 (contact: you@example.com) backfill burial place",
      Accept: "application/sparql-results+json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SPARQL failed ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as {
    results: { bindings: SparqlBinding[] };
  };
}

async function main() {
  console.log("Fetching rows missing burial_place_name with wikidata_id...");

  const { data: rows, error } = await supabase
    .from("death_locations")
    .select("id, title, wikidata_id, burial_place_name, is_published")
    .is("burial_place_name", null)
    .not("wikidata_id", "is", null)
    .eq("is_published", true)
    .limit(1000);

  if (error) {
    console.error("Supabase error:", error.message);
    return;
  }
  if (!rows || rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Clean + normalize QIDs
  const candidates = (rows as Row[])
    .map((r) => ({
      ...r,
      wikidata_id: (r.wikidata_id || "").trim().toUpperCase(),
    }))
    .filter((r) => /^Q\d+$/.test(r.wikidata_id || ""));

  console.log(`Found ${candidates.length} candidate rows.`);

  // Batch QIDs to be polite to Wikidata
  const batches = chunk(candidates, 50);

  let updated = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const qids = batch.map((r) => `wd:${r.wikidata_id}`).join(" ");

    const query = `
SELECT ?person ?burialPlace ?burialPlaceLabel WHERE {
  VALUES ?person { ${qids} }
  OPTIONAL { ?person wdt:P119 ?burialPlace. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;

    console.log(`SPARQL batch ${b + 1}/${batches.length} (${batch.length} people)...`);

    let bindings: SparqlBinding[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const json = await sparql(query);
        bindings = json.results.bindings || [];
        break;
      } catch (e: any) {
        console.log(`  ❌ SPARQL attempt ${attempt} failed: ${e?.message ?? e}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }

    // Map QID -> burialPlaceLabel
    const map = new Map<string, string>();
    for (const row of bindings) {
      const personUrl = row.person.value; // e.g. http://www.wikidata.org/entity/Q42
      const qid = personUrl.split("/").pop() || "";
      const label = row.burialPlaceLabel?.value?.trim();
      if (qid && label) map.set(qid.toUpperCase(), label);
    }

    for (const r of batch) {
      const qid = (r.wikidata_id || "").toUpperCase();
      const burialName = map.get(qid);

      if (!burialName) continue;

      const { error: updateErr } = await supabase
        .from("death_locations")
        .update({ burial_place_name: burialName })
        .eq("id", r.id);

      if (updateErr) {
        console.log(`  ❌ Update failed for ${r.title ?? r.id}: ${updateErr.message}`);
      } else {
        updated++;
        console.log(`  ✅ ${r.title ?? r.id} → ${burialName}`);
      }

      // tiny delay so we don't spam Supabase either
      await new Promise((r) => setTimeout(r, 120));
    }

    // polite pause between SPARQL batches
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`Done. Updated ${updated} rows.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});