import type { FetchFn } from "./types.js";

/**
 * ACL Anthology hosts a per-paper BibTeX file at a stable URL pattern:
 *   https://aclanthology.org/{paperId}.bib
 * where paperId is e.g. "2025.inlg-main.37" or "P02-1040".
 *
 * Anthology has no proper search API, so we can only use this when the
 * caller already has the paperId (extracted from a URL on a Scholar result
 * or on the Anthology page itself).
 */
export async function fetchAnthologyBibtex(
  fetchFn: FetchFn,
  paperId: string,
): Promise<string | null> {
  const url = `https://aclanthology.org/${encodeURIComponent(paperId)}.bib`;
  const res = await fetchFn(url, {
    headers: { Accept: "application/x-bibtex" },
  });
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  if (!text.startsWith("@")) return null;
  return text;
}

/** Extract a paperId like `2025.inlg-main.37` or `P02-1040` from a URL. */
export function paperIdFromUrl(url: string): string | null {
  const m = /aclanthology\.org\/([A-Za-z0-9.\-]+?)(?:\/|\.pdf|\.bib)?(?:[?#]|$)/i.exec(
    url,
  );
  if (!m) return null;
  const id = m[1]!;
  // Filter out top-level paths like /search, /events, /people.
  if (/^(search|events|venues|sigs|volumes|people|info|posts|faq)$/i.test(id)) {
    return null;
  }
  return id;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Pull venue acronyms out of a free-text venue string. "REALM (First Workshop
 * for Research on Agent Language Models) at ACL 2025" → ["realm", "acl"].
 * Restricts to short ALL-CAPS tokens so we don't pick up arbitrary words.
 */
function extractAcronyms(venue: string): string[] {
  const seen = new Set<string>();
  for (const m of venue.matchAll(/\b([A-Z][A-Za-z0-9]{1,7})\b/g)) {
    const a = m[1]!;
    // Require either fully ALL-CAPS, or CamelCase acronym (NeurIPS, CoNLL).
    if (/^[A-Z][A-Z0-9]+$/.test(a) || /^[A-Z][a-z]?[A-Z]/.test(a)) {
      seen.add(a.toLowerCase());
    }
  }
  // Drop tiny noise tokens.
  return Array.from(seen).filter((a) => a.length >= 3);
}

/**
 * Given a venue hint and a year, generate plausible Anthology volume URLs
 * to probe. Each is fetched; the first that 200s and contains the target
 * title is the right one.
 */
function candidateVolumeIds(venueHint: string, year: number): string[] {
  const acros = extractAcronyms(venueHint);
  const variants = ["1", "main", "long", "short", "findings", "srw"];
  const out: string[] = [];
  for (const acro of acros) {
    for (const v of variants) out.push(`${year}.${acro}-${v}`);
  }
  return out;
}

/**
 * Search ACL Anthology for a paper given its title and a venue hint
 * (typically pulled from the arXiv comment field). Tries each plausible
 * volume URL, parses the HTML for paper-id + title pairs, and returns the
 * verbatim BibTeX of the first exact title match.
 *
 * Anthology has no proper search API, but the per-volume listing pages
 * are HTML and trivial to scrape.
 */
export async function fetchAnthologyByVenue(
  fetchFn: FetchFn,
  query: { title: string; venueHint: string; year: number },
): Promise<{ bibtex: string; paperId: string } | null> {
  const wantTitle = normalize(query.title);
  const candidates = candidateVolumeIds(query.venueHint, query.year);
  for (const volumeId of candidates) {
    const volRes = await fetchFn(
      `https://aclanthology.org/volumes/${volumeId}/`,
      { headers: { Accept: "text/html" } },
    );
    if (!volRes.ok) continue;
    const html = await volRes.text();
    // Each paper entry on the volume page renders as
    //   <strong><a class=align-middle href=/<paperId>/>Title</a></strong>
    // (Hugo emits unquoted attrs). Match that shape.
    // NOTE: paperId fragments include digits (e.g. "realm-1"), so the
    // middle char-class must include 0-9.
    const re = /<a [^>]*href=["']?\/(\d{4}\.[a-z0-9\-]+\.\d+)\/?["']?[^>]*>([^<]+)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const paperId = m[1]!;
      const titleText = m[2]!.replace(/&amp;/g, "&").replace(/&#x[0-9a-f]+;/gi, "").trim();
      if (normalize(titleText) === wantTitle) {
        const bib = await fetchAnthologyBibtex(fetchFn, paperId);
        if (bib) return { bibtex: bib, paperId };
      }
    }
  }
  return null;
}
