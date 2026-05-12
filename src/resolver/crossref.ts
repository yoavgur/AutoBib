import type { FetchFn } from "./types.js";

/**
 * Crossref returns BibTeX directly via content negotiation:
 *   GET https://api.crossref.org/works/{doi}
 *   Accept: application/x-bibtex
 * (Note: doi.org content negotiation also works, but api.crossref.org is more
 * stable for our use.)
 */
export async function fetchCrossrefBibtex(
  fetchFn: FetchFn,
  doi: string,
): Promise<string | null> {
  const url = `https://api.crossref.org/works/${encodeURI(doi)}/transform/application/x-bibtex`;
  const res = await fetchFn(url, {
    headers: { Accept: "application/x-bibtex" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim().startsWith("@")) return null;
  return text.trim();
}

interface CrossrefWork {
  DOI: string;
  type?: string;
  title?: string[];
  author?: { family?: string; given?: string }[];
  issued?: { "date-parts"?: number[][] };
}

interface CrossrefSearch {
  message?: { items?: CrossrefWork[] };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Title-search Crossref. Useful for ACL/EMNLP/NAACL papers (and journal
 * articles) where DBLP doesn't yet have an entry but Crossref does. Returns
 * BibTeX of the best match, or null if nothing matches confidently.
 */
export async function fetchCrossrefByTitle(
  fetchFn: FetchFn,
  query: { title: string; year?: number; authors?: string[] },
): Promise<string | null> {
  const params = new URLSearchParams({
    "query.title": query.title,
    rows: "5",
    select: "DOI,type,title,author,issued",
  });
  const url = `https://api.crossref.org/works?${params.toString()}`;
  const res = await fetchFn(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as CrossrefSearch;
  const items = data.message?.items ?? [];
  if (items.length === 0) return null;

  const wantTitle = normalize(query.title);
  const wantAuthors = (query.authors ?? []).map(normalize);

  let best: { item: CrossrefWork; score: number } | null = null;
  for (const item of items) {
    const title = item.title?.[0];
    if (!title) continue;
    if (normalize(title) !== wantTitle) continue;
    const itemYear = item.issued?.["date-parts"]?.[0]?.[0];
    const yearScore =
      query.year && itemYear && Math.abs(itemYear - query.year) <= 1 ? 1 : 0;
    const itemAuthors = (item.author ?? []).map((a) =>
      normalize([a.given, a.family].filter(Boolean).join(" ")),
    );
    const overlap = wantAuthors.filter((a) =>
      itemAuthors.some((n) => n.includes(a) || a.includes(n)),
    ).length;
    // Skip Crossref's own arXiv-DOI records (10.48550/arXiv.X) — they're not
    // a published version, just a DOI for the preprint.
    if (/^10\.48550\/arxiv/i.test(item.DOI)) continue;
    const score = yearScore + overlap;
    if (!best || score > best.score) best = { item, score };
  }
  if (!best) return null;
  return fetchCrossrefBibtex(fetchFn, best.item.DOI);
}
