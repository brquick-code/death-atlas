#!/usr/bin/env python3
"""
Seeing-Stars decade pages -> permissive .txt extraction

Fields requested:
Name, Date of death, Location, Cause, Wikipedia (if available)

This version is intentionally "loose":
- converts <br> to newline so entries become lines
- collects lines that contain a recognizable date/year pattern
- attempts to extract wikipedia link if present in the same block

Output:
seeing-stars-summaries.txt
"""

import re
from datetime import datetime
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

URLS = [
    "https://www.seeing-stars.com/Died/2010s.shtml",
    "https://www.seeing-stars.com/Died/2000s.shtml",
    "https://www.seeing-stars.com/Died/90s.shtml",
    "https://www.seeing-stars.com/Died/80s.shtml",
    "https://www.seeing-stars.com/Died/70s.shtml",
    "https://www.seeing-stars.com/Died/60s.shtml",
    "https://www.seeing-stars.com/Died/50s_20s.shtml#20s",
]

OUTFILE = "seeing-stars-summaries.txt"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeathAtlas/1.0"
}

MONTH_RE = r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
DATE_PAT = re.compile(
    rf"({MONTH_RE}\s+\d{{1,2}},\s+\d{{4}})|(\d{{1,2}}/\d{{1,2}}/\d{{2,4}})|\b(19\d{{2}}|20\d{{2}})\b",
    re.IGNORECASE
)
WIKI_PAT = re.compile(r"wikipedia\.org/wiki/", re.IGNORECASE)

def fetch_html(url: str) -> str:
    r = requests.get(url, headers=HEADERS, timeout=45)
    r.raise_for_status()

    # Try best-effort decoding
    enc = r.encoding or r.apparent_encoding or "utf-8"
    try:
        return r.content.decode(enc, errors="replace")
    except Exception:
        return r.content.decode("latin-1", errors="replace")

def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()

def main():
    out = []
    out.append("Seeing-Stars Summary Extract")
    out.append(f"Generated: {datetime.now().isoformat(timespec='seconds')}")
    out.append("Requested fields: Name | Date of death | Location | Cause | Wikipedia (if available)")
    out.append("NOTE: This is a loose extraction. Some lines may need manual cleanup.")
    out.append("")

    total_lines = 0

    for url in URLS:
        out.append("=" * 90)
        out.append(f"SOURCE: {url}")
        out.append("=" * 90)

        try:
            html = fetch_html(url)
        except Exception as e:
            out.append(f"[ERROR] Could not fetch page: {e}")
            out.append("")
            continue

        soup = BeautifulSoup(html, "html.parser")

        # Convert <br> tags into newlines so entries become individual lines
        for br in soup.find_all("br"):
            br.replace_with("\n")

        # Also keep anchor hrefs for wiki extraction
        page_text = soup.get_text("\n")
        lines = [clean(x) for x in page_text.split("\n") if clean(x)]

        # Grab wikipedia links on the page (we'll attach if the line contains the name text)
        wiki_links = []
        for a in soup.find_all("a"):
            href = a.get("href") or ""
            if WIKI_PAT.search(href):
                wiki_links.append(href)

        # Keep lines that look like entries: contain a date/year pattern
        kept = []
        for ln in lines:
            if len(ln) < 10:
                continue
            if DATE_PAT.search(ln):
                kept.append(ln)

        # If we still somehow kept nothing, dump the first 200 raw lines so we can see formatting
        if not kept:
            out.append("[DEBUG] No date-like lines found. First 200 raw lines from page:")
            for ln in lines[:200]:
                out.append(f"- RAW: {ln}")
            out.append("")
            continue

        # Write as "summary cards" (loose)
        for ln in kept:
            total_lines += 1
            # very loose parse: name often at start before dash/paren
            name_guess = clean(re.split(r"[-–—]|\\(|\\[", ln, maxsplit=1)[0])

            wiki_guess = ""
            # If any wiki link includes the name-like token, attach it
            token = re.sub(r"[^a-z0-9]+", "_", name_guess.lower()).strip("_")
            for w in wiki_links:
                if token and token in w.lower():
                    wiki_guess = w
                    break

            out.append(f"- Name: {name_guess}")
            out.append(f"  Summary line: {ln}")
            out.append(f"  Wikipedia: {wiki_guess}")
            out.append("")

        out.append("")

    with open(OUTFILE, "w", encoding="utf-8") as f:
        f.write("\n".join(out))

    print(f"Done. Wrote {total_lines} entry lines to {OUTFILE}")

if __name__ == "__main__":
    main()
