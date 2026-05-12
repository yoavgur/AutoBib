import type { FetchFn } from "./types.js";

interface DblpHit {
  info: {
    title: string;
    year?: string;
    authors?: { author: { text: string } | { text: string }[] };
    key: string;
    type?: string;
    venue?: string;
    url?: string;
  };
}

interface DblpSearchResponse {
  result?: {
    hits?: {
      hit?: DblpHit[];
    };
  };
}

const SEARCH = "https://dblp.org/search/publ/api";

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function authorNames(hit: DblpHit): string[] {
  const a = hit.info.authors?.author;
  if (!a) return [];
  return Array.isArray(a) ? a.map((x) => x.text) : [a.text];
}

function lastName(fullName: string): string {
  // "Tom B. Brown" → "Brown"; "Brown, Tom" → "Brown".
  if (fullName.includes(",")) return fullName.split(",")[0]!.trim();
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName;
}

function distinctiveTitleTokens(title: string, max = 4): string[] {
  const stop = new Set([
    "a","an","the","of","in","for","to","and","or","on","with","is","are","be",
    "as","at","by","from","into","you","we","our","this","that","it","its",
  ]);
  const toks = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !stop.has(t));
  return toks.slice(0, max);
}

/** True if the DBLP key represents an arXiv/preprint listing rather than a
 *  published venue. We never want to return one of these as `isPublished`. */
export function isPreprintKey(key: string): boolean {
  return key.startsWith("journals/corr/");
}

/**
 * Search DBLP. DBLP's relevance ranking is poor for famous papers (it ranks
 * recent papers above seminal ones), so we narrow the query with the first
 * author's last name + distinctive title tokens. Falls back to a plain title
 * search if the narrowed query returns no exact match.
 *
 * Returns null if the only matches are arXiv/CoRR preprint listings — those
 * are not "published" and the caller should surface that to the user.
 */
export async function fetchDblpBibtex(
  fetchFn: FetchFn,
  query: { title: string; year?: number; authors?: string[] },
): Promise<string | null> {
  const author = query.authors?.[0] ? lastName(query.authors[0]) : "";
  const titleTokens = distinctiveTitleTokens(query.title);

  const queries: string[] = [];
  if (author && titleTokens.length > 0) {
    // Don't filter by year — arXiv post date often differs from conference
    // publication year (e.g., paper posted 2020, conf 2021), and DBLP's
    // year: filter is exact-match.
    queries.push(`${author} ${titleTokens.join(" ")}`);
  }
  // Fallback: plain title search with more results.
  queries.push(query.title);

  let hits: DblpHit[] = [];
  for (const q of queries) {
    const url = `${SEARCH}?q=${encodeURIComponent(q)}&format=json&h=30`;
    const res = await fetchFn(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) continue;
    const data = (await res.json()) as DblpSearchResponse;
    hits = data.result?.hits?.hit ?? [];
    if (hits.length > 0) break;
  }
  if (hits.length === 0) return null;

  const wantTitle = normalize(query.title);
  const wantAuthors = (query.authors ?? []).map((n) => normalize(n));
  let best: DblpHit | null = null;
  let bestScore = -Infinity;

  for (const hit of hits) {
    const titleScore = normalize(hit.info.title) === wantTitle ? 3 : 0;
    if (titleScore === 0) continue;
    // Lenient ±1 year — arXiv post often precedes conference publication.
    const yearScore =
      query.year &&
      hit.info.year &&
      Math.abs(Number(hit.info.year) - query.year) <= 1
        ? 1
        : 0;
    const dblpAuthors = authorNames(hit).map((n) => normalize(n));
    const authorOverlap = wantAuthors.filter((a) =>
      dblpAuthors.some((d) => d.includes(a) || a.includes(d)),
    ).length;
    // Prefer conferences/journals over informal/withdrawn entries.
    const typePenalty =
      hit.info.type && /informal|withdrawn|editor/i.test(hit.info.type)
        ? -2
        : 0;
    const score = titleScore + yearScore + authorOverlap + typePenalty;
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }

  if (!best || bestScore < 3) return null;

  // Reject only true preprint-only entries: the key is journals/corr/* AND
  // DBLP classifies it as "Informal and Other Publications". DBLP sometimes
  // keeps a journals/corr/* key but upgrades type to "Conference and Workshop
  // Papers" once a venue exists (e.g., older ICLR papers like Bahdanau 2015) —
  // those entries DO contain proper booktitle info and should be returned.
  const bestType = best.info.type ?? "";
  if (isPreprintKey(best.info.key) && /informal/i.test(bestType)) return null;

  // Each DBLP entry has a stable BibTeX URL: https://dblp.org/rec/{key}.bib
  const bibUrl = `https://dblp.org/rec/${best.info.key}.bib`;
  const bibRes = await fetchFn(bibUrl, {
    headers: { Accept: "application/x-bibtex" },
  });
  if (!bibRes.ok) return null;
  const bibtex = (await bibRes.text()).trim();
  // DBLP returns multiple "condensed/standard/crossref" entries; the first
  // standard entry is what we want.
  const entries = bibtex.split(/\n(?=@)/);
  return entries[0] ?? null;
}
