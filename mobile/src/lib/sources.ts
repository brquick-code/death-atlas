// mobile/src/lib/sources.ts

export type SourceLink = {
  url: string;
  label: string;
  host: string;
  kind:
    | "wikipedia"
    | "wikidata"
    | "findagrave"
    | "findadeath"
    | "seeingstars"
    | "oddstops"
    | "other";
};

function safeUrl(u: string): string | null {
  const s = (u ?? "").toString().trim();
  if (!s) return null;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function classify(url: string): SourceLink["kind"] {
  const h = hostOf(url);

  if (h.endsWith("wikipedia.org")) return "wikipedia";
  if (h.endsWith("wikidata.org")) return "wikidata";
  if (h.endsWith("findagrave.com")) return "findagrave";
  if (h.endsWith("findadeath.com")) return "findadeath";
  if (h.endsWith("seeing-stars.com") || h.endsWith("seeing-stars.org"))
    return "seeingstars";
  if (h.endsWith("oddstops.com")) return "oddstops";
  return "other";
}

function labelFor(kind: SourceLink["kind"], url: string): string {
  switch (kind) {
    case "wikipedia":
      return "Wikipedia";
    case "wikidata":
      return "Wikidata";
    case "findagrave":
      return "Find a Grave";
    case "findadeath":
      return "Find-A-Death";
    case "seeingstars":
      return "Seeing-Stars";
    case "oddstops":
      return "OddStops";
    default: {
      const h = hostOf(url);
      return h ? h.replace(/^www\./, "") : "Source";
    }
  }
}

function sortWeight(kind: SourceLink["kind"]): number {
  switch (kind) {
    case "wikipedia":
      return 10;
    case "wikidata":
      return 20;
    case "findagrave":
      return 30;
    case "findadeath":
      return 40;
    case "seeingstars":
      return 50;
    case "oddstops":
      return 60;
    default:
      return 90;
  }
}

function dedupeUrls(urls: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const nu = (u ?? "").toString().trim();
    if (!nu) continue;
    if (seen.has(nu)) continue;
    seen.add(nu);
    out.push(nu);
  }
  return out;
}

export function normalizeSources(args: {
  sourceUrls?: string[] | null;
  legacySourceUrl?: string | null;
}): SourceLink[] {
  const urlsRaw: string[] = [];

  if (Array.isArray(args.sourceUrls)) urlsRaw.push(...args.sourceUrls);
  if (args.legacySourceUrl) urlsRaw.push(args.legacySourceUrl);

  const cleaned = urlsRaw
    .map((u) => safeUrl(u))
    .filter((u): u is string => !!u);

  const unique = dedupeUrls(cleaned);

  const links: SourceLink[] = unique.map((url) => {
    const kind = classify(url);
    return {
      url,
      kind,
      host: hostOf(url),
      label: labelFor(kind, url),
    };
  });

  links.sort((a, b) => {
    const dw = sortWeight(a.kind) - sortWeight(b.kind);
    if (dw !== 0) return dw;
    return a.label.localeCompare(b.label);
  });

  return links;
}
