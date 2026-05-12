import type { FetchFn } from "./types.js";

const SEARCH = "https://api2.openreview.net/notes/search";

interface OpenReviewNote {
  id?: string;
  content: {
    title?: { value?: string };
    authors?: { value?: string[] };
    venue?: { value?: string };
    venueid?: { value?: string };
    _bibtex?: { value?: string };
  };
}

interface SearchResponse {
  notes?: OpenReviewNote[];
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True if the venue indicates a preprint listing (e.g. "CoRR 2025" or
 * a venueid under `dblp.org/journals/CORR/...`). We never want to surface
 * one of those as the "published version".
 */
function isPreprintVenue(venue: string | undefined, venueid: string | undefined): boolean {
  if (venue && /^corr\b/i.test(venue.trim())) return true;
  if (venueid && /journals\/CORR/i.test(venueid)) return true;
  return false;
}

/** "Submitted to ICLR 2025" / "ICLR 2025 Submission" / "... Withdrawn" /
 *  "... Reject" — these are not accepted-and-published papers. */
function isUnacceptedSubmission(
  venue: string | undefined,
  venueid: string | undefined,
): boolean {
  const v = (venue ?? "").trim();
  if (/^submitted\b/i.test(v)) return true;
  if (/\b(submission|withdrawn|reject(ed)?|desk[- ]?reject)\b/i.test(v)) {
    return true;
  }
  if (venueid && /\/Submission\b/i.test(venueid)) return true;
  return false;
}

/**
 * Search OpenReview for a published version of the given paper. OpenReview
 * is the canonical source for ICLR / NeurIPS / COLM / TMLR (and others) and
 * often confirms a venue *before* DBLP indexes it.
 *
 * Returns the OpenReview-provided BibTeX with the venue name, or null.
 */
export async function fetchOpenReviewBibtex(
  fetchFn: FetchFn,
  query: { title: string; authors?: string[] },
): Promise<{ bibtex: string; venue: string } | null> {
  const url = `${SEARCH}?query=${encodeURIComponent(query.title)}&type=terms&limit=10`;
  const res = await fetchFn(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as SearchResponse;
  const notes = data.notes ?? [];
  if (notes.length === 0) return null;

  const wantTitle = normalize(query.title);
  const wantAuthors = (query.authors ?? []).map(normalize);

  let best: { note: OpenReviewNote; score: number } | null = null;
  for (const note of notes) {
    const title = note.content.title?.value;
    if (!title) continue;
    if (normalize(title) !== wantTitle) continue;
    const venue = note.content.venue?.value;
    const venueid = note.content.venueid?.value;
    // Skip preprint listings and not-yet-accepted submissions.
    if (!venue || isPreprintVenue(venue, venueid)) continue;
    if (isUnacceptedSubmission(venue, venueid)) continue;
    if (!note.content._bibtex?.value) continue;

    // Author overlap as a tiebreaker.
    const noteAuthors = (note.content.authors?.value ?? []).map(normalize);
    const overlap = wantAuthors.filter((a) =>
      noteAuthors.some((n) => n.includes(a) || a.includes(n)),
    ).length;
    const score = overlap;
    if (!best || score > best.score) best = { note, score };
  }

  if (!best) return null;
  return {
    bibtex: best.note.content._bibtex!.value!.trim(),
    venue: best.note.content.venue!.value!,
  };
}
