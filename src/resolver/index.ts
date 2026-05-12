import { fetchAnthologyBibtex, fetchAnthologyByVenue } from "./anthology.js";
import { fetchArxivBibtex, fetchArxivMeta } from "./arxiv.js";
import {
  extractVenueLabel,
  formatBibtex,
  generateKey,
  isWorkshopBibtex,
  isWorkshopVenue,
  parseBibtex,
  rekey,
} from "./bibtex.js";
import { fetchCrossrefBibtex, fetchCrossrefByTitle } from "./crossref.js";
import { fetchDblpBibtex } from "./dblp.js";
import { fetchOpenReviewBibtex } from "./openreview.js";
import type {
  FetchFn,
  OnProgress,
  ResolveResult,
  ResolverInput,
  ResolverStep,
} from "./types.js";

export interface ResolveOptions {
  fetch?: FetchFn;
  onProgress?: OnProgress;
}

const defaultFetch: FetchFn = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<FetchFn>;

function isArxivDoi(doi: string | undefined): doi is string {
  return Boolean(doi && /^10\.48550\/arxiv/i.test(doi));
}

/** Produce the venue string we surface to the progress UI for a hit. If the
 *  hit is a workshop / non-archival track, we tag it with "(workshop)" so
 *  the user can see we're still looking for a main-venue version. */
function workshopLabel(r: {
  bibtex: string;
  venue?: string;
}): string | undefined {
  const isWorkshop =
    isWorkshopBibtex(r.bibtex) || isWorkshopVenue(r.venue);
  if (!isWorkshop) return r.venue;
  return r.venue ? `${r.venue} (workshop — keep looking)` : "(workshop — keep looking)";
}

const noop: OnProgress = () => {};

export async function resolveBibtex(
  input: ResolverInput,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const fetchFn = opts.fetch ?? defaultFetch;
  const onProgress = opts.onProgress ?? noop;

  if (input.kind === "arxiv") {
    return resolveFromArxiv(
      fetchFn,
      input.id,
      onProgress,
      input.prefetchedMeta,
    );
  }
  if (input.kind === "doi") {
    return resolveFromDoi(fetchFn, input.doi);
  }
  if (input.kind === "aclanthology") {
    return resolveFromAnthology(fetchFn, input.paperId);
  }
  return resolveFromTitle(
    fetchFn,
    input.title,
    input.authors,
    onProgress,
    input.anthologyId,
  );
}

async function resolveFromArxiv(
  fetchFn: FetchFn,
  arxivId: string,
  onProgress: OnProgress,
  prefetchedMeta?: import("./types.js").ArxivMetaInput,
): Promise<ResolveResult> {
  const tap = (step: ResolverStep) => ({
    start: () => onProgress({ kind: "start", step }),
    hit: (venue?: string) => onProgress({ kind: "hit", step, venue }),
    miss: () => onProgress({ kind: "miss", step }),
    error: (message: string) => onProgress({ kind: "error", step, message }),
  });

  /**
   * Run a cascade step that fetches from a remote API. If the fetch throws
   * (network failure, CORS, etc.), report it as an error event and return
   * undefined so the cascade can continue. A missing-but-not-errored result
   * is the caller's responsibility to detect (and report as miss).
   */
  async function tryStep<T>(
    step: ResolverStep,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    tap(step).start();
    try {
      return await run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tap(step).error(msg);
      console.warn(`[autobib] ${step} errored:`, err);
      return undefined;
    }
  }

  // arXiv metadata is the only step that can't be skipped — without title /
  // authors / year, no downstream lookup is possible. The caller (e.g. our
  // arXiv content script) can pre-supply this from the page DOM to avoid
  // hitting the arXiv API entirely.
  let meta: import("./types.js").ArxivMetaInput | null;
  if (prefetchedMeta && prefetchedMeta.title) {
    tap("arxiv-meta").hit();
    meta = prefetchedMeta;
  } else {
    try {
      tap("arxiv-meta").start();
      meta = await fetchArxivMeta(fetchFn, arxivId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tap("arxiv-meta").error(msg);
      return {
        isPublished: false,
        reason: `Could not reach arXiv: ${msg}`,
      };
    }
    if (!meta || !meta.title) {
      tap("arxiv-meta").miss();
      return { isPublished: false, reason: "Paper not found on arXiv" };
    }
    tap("arxiv-meta").hit();
  }

  // Same paper sometimes appears in both a workshop AND a main venue. We'd
  // rather cite the main venue when it exists, so on a workshop hit we hold
  // it as "tentative" and keep checking later sources. The first non-workshop
  // hit wins; if every source only finds workshop versions, we use the
  // tentative one.
  let tentative: ResolveResult | null = null;
  const accept = (r: ResolveResult & { isPublished: true }): ResolveResult | null => {
    if (!isWorkshopBibtex(r.bibtex) && !isWorkshopVenue(r.venue)) {
      return r; // strong hit, stop the cascade
    }
    if (!tentative) tentative = r;
    return null; // keep looking
  };

  // Try DBLP — works for the vast majority of CS papers and is by far the
  // cleanest BibTeX source. Returns null for arXiv-only listings.
  if (meta.authors.length > 0) {
    const dblp = await tryStep("dblp", () =>
      fetchDblpBibtex(fetchFn, {
        title: meta!.title,
        year: meta!.year ? Number(meta!.year) : undefined,
        authors: meta!.authors,
      }),
    );
    if (dblp) {
      const bibtex = rekeyBibtex(dblp);
      const r = {
        isPublished: true as const,
        bibtex,
        source: "dblp" as const,
        venue: extractVenueLabel(bibtex) ?? meta.journalRef,
        year: meta.year ? Number(meta.year) : undefined,
        doi: meta.doi,
      };
      tap("dblp").hit(workshopLabel(r));
      const final = accept(r);
      if (final) return final;
    } else if (dblp === null) {
      tap("dblp").miss();
    }
  }

  // Try Crossref via the DOI arXiv stores in <arxiv:doi> — covers non-CS
  // papers when the author has updated arXiv metadata after publication.
  // Skip if the only DOI is arXiv's own (10.48550/arXiv.X).
  if (meta.doi && !isArxivDoi(meta.doi)) {
    const doi = meta.doi;
    const cr = await tryStep("crossref-doi", () =>
      fetchCrossrefBibtex(fetchFn, doi),
    );
    if (cr) {
      const bibtex = rekeyBibtex(cr);
      const r = {
        isPublished: true as const,
        bibtex,
        source: "crossref" as const,
        venue: extractVenueLabel(bibtex) ?? meta.journalRef,
        year: meta.year ? Number(meta.year) : undefined,
        doi,
      };
      tap("crossref-doi").hit(workshopLabel(r));
      const final = accept(r);
      if (final) return final;
    } else if (cr === null) {
      tap("crossref-doi").miss();
    }
  }

  // Try OpenReview — covers recently-accepted ICLR/NeurIPS/COLM/TMLR papers
  // before DBLP indexes them.
  if (meta.authors.length > 0) {
    const or = await tryStep("openreview", () =>
      fetchOpenReviewBibtex(fetchFn, {
        title: meta!.title,
        authors: meta!.authors,
      }),
    );
    if (or) {
      const bibtex = rekeyBibtex(or.bibtex);
      const r = {
        isPublished: true as const,
        bibtex,
        source: "openreview" as const,
        venue: or.venue ?? extractVenueLabel(bibtex),
        year: meta.year ? Number(meta.year) : undefined,
        doi: meta.doi && !isArxivDoi(meta.doi) ? meta.doi : undefined,
      };
      tap("openreview").hit(workshopLabel(r));
      const final = accept(r);
      if (final) return final;
    } else if (or === null) {
      tap("openreview").miss();
    }
  }

  // Crossref title search — catches ACL/EMNLP/NAACL papers (and journals)
  // that have a DOI but where the arXiv→DOI link is missing.
  const crByTitle = await tryStep("crossref-title", () =>
    fetchCrossrefByTitle(fetchFn, {
      title: meta!.title,
      year: meta!.year ? Number(meta!.year) : undefined,
      authors: meta!.authors,
    }),
  );
  if (crByTitle) {
    const bibtex = rekeyBibtex(crByTitle);
    const r = {
      isPublished: true as const,
      bibtex,
      source: "crossref" as const,
      venue: extractVenueLabel(bibtex) ?? meta.journalRef,
      year: meta.year ? Number(meta.year) : undefined,
    };
    tap("crossref-title").hit(workshopLabel(r));
    const final = accept(r);
    if (final) return final;
  } else if (crByTitle === null) {
    tap("crossref-title").miss();
  }

  // No main-venue hit; surface the tentative workshop hit if we have one.
  if (tentative) return tentative;

  // No verbatim published BibTeX from the standard sources. If the arXiv
  // comment names a venue, try to use that as a router into ACL Anthology —
  // their per-volume HTML pages list every paperId+title and are scrapeable
  // even when nothing else has indexed the workshop yet.
  tap("arxiv-comment").start();
  const venueHint = parseVenueHint(meta.comment);
  if (venueHint) tap("arxiv-comment").hit(venueHint);
  else tap("arxiv-comment").miss();

  if (venueHint && meta.year) {
    const aclByVenue = await tryStep("aclanthology", () =>
      fetchAnthologyByVenue(fetchFn, {
        title: meta!.title,
        venueHint,
        year: Number(meta!.year),
      }),
    );
    if (aclByVenue) {
      const bibtex = rekeyBibtex(aclByVenue.bibtex);
      const r = {
        isPublished: true as const,
        bibtex,
        source: "aclanthology" as const,
        venue: extractVenueLabel(bibtex),
        year: meta.year ? Number(meta.year) : undefined,
      };
      tap("aclanthology").hit(workshopLabel(r));
      const final = accept(r);
      if (final) return final;
      // Workshop hit — no later sources will check, so surface it now.
      if (tentative) return tentative;
    } else if (aclByVenue === null) {
      tap("aclanthology").miss();
    }
  }

  const synthesized = venueHint
    ? synthesizeFromHint({
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        venue: venueHint,
      })
    : undefined;
  // arXiv fallback BibTeX — fetched verbatim from arxiv.org's
  // "Export BibTeX citation" endpoint. We do NOT synthesize one ourselves;
  // if arxiv.org is unreachable we just leave it unset and the toast will
  // show no Copy-arXiv-BibTeX action.
  let arxivFallback: string | undefined;
  try {
    arxivFallback = (await fetchArxivBibtex(fetchFn, arxivId)) ?? undefined;
  } catch (err) {
    console.warn("[autobib] arXiv fallback fetch errored:", err);
  }
  return {
    isPublished: false,
    arxivId,
    arxivFallback,
    venueHint,
    synthesizedBibtex: synthesized,
    synthesizedSource: synthesized ? "arXiv comment + arXiv metadata" : undefined,
    reason: venueHint
      ? `Likely published at: ${venueHint} (per arXiv comment). No machine-readable record yet.`
      : "No published version found — only an arXiv preprint" +
        (meta.doi && isArxivDoi(meta.doi)
          ? " (arXiv DOI is not a publication DOI)"
          : ""),
  };
}

/**
 * Build a minimal @inproceedings from arXiv metadata + a venue string parsed
 * from the arXiv comment. Marked low-confidence: the venue string is
 * free-text and the entry lacks pages/editors/DOI.
 */
function synthesizeFromHint(opts: {
  title: string;
  authors: string[];
  year: string;
  venue: string;
}): string {
  const fields: Record<string, string> = {
    author: opts.authors.join(" and "),
    title: opts.title,
    booktitle: opts.venue,
  };
  if (opts.year) fields.year = opts.year;
  const entry = { type: "inproceedings", key: "tmp", fields };
  entry.key = generateKey(entry);
  return formatBibtex(entry);
}

async function resolveFromDoi(
  fetchFn: FetchFn,
  doi: string,
): Promise<ResolveResult> {
  if (isArxivDoi(doi)) {
    return {
      isPublished: false,
      reason:
        "DOI is an arXiv-issued DOI (10.48550/arXiv.X), not a publication DOI",
    };
  }
  const cr = await fetchCrossrefBibtex(fetchFn, doi);
  if (!cr) {
    return { isPublished: false, reason: "DOI not found on Crossref" };
  }
  const parsed = parseBibtex(cr);
  return {
    isPublished: true,
    bibtex: rekeyBibtex(cr),
    source: "crossref",
    year: parsed?.fields.year ? Number(parsed.fields.year) : undefined,
    doi,
  };
}

async function resolveFromAnthology(
  fetchFn: FetchFn,
  paperId: string,
): Promise<ResolveResult> {
  const bib = await fetchAnthologyBibtex(fetchFn, paperId);
  if (!bib) {
    return {
      isPublished: false,
      reason: `ACL Anthology has no bib for ${paperId}`,
    };
  }
  const bibtex = rekeyBibtex(bib);
  const parsed = parseBibtex(bibtex);
  return {
    isPublished: true,
    bibtex,
    source: "aclanthology",
    venue: extractVenueLabel(bibtex),
    year: parsed?.fields.year ? Number(parsed.fields.year) : undefined,
  };
}

async function resolveFromTitle(
  fetchFn: FetchFn,
  title: string,
  authors: string[] | undefined,
  onProgress: OnProgress,
  anthologyId?: string,
): Promise<ResolveResult> {
  const tap = (step: ResolverStep) => ({
    start: () => onProgress({ kind: "start", step }),
    hit: (venue?: string) => onProgress({ kind: "hit", step, venue }),
    miss: () => onProgress({ kind: "miss", step }),
    error: (message: string) => onProgress({ kind: "error", step, message }),
  });
  const tryStep = async <T>(
    step: ResolverStep,
    run: () => Promise<T>,
  ): Promise<T | undefined> => {
    tap(step).start();
    try {
      return await run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tap(step).error(msg);
      console.warn(`[autobib] ${step} errored:`, err);
      return undefined;
    }
  };

  // Workshop-vs-main accumulator: hold a workshop hit as tentative and keep
  // looking; first non-workshop hit wins; if all hits are workshop, return
  // the first one we found.
  let tentative: ResolveResult | null = null;
  const accept = (r: ResolveResult & { isPublished: true }): ResolveResult | null => {
    if (!isWorkshopBibtex(r.bibtex) && !isWorkshopVenue(r.venue)) return r;
    if (!tentative) tentative = r;
    return null;
  };

  // 0. ACL Anthology — only when the caller already has the paperId.
  if (anthologyId) {
    const acl = await tryStep("aclanthology", () =>
      fetchAnthologyBibtex(fetchFn, anthologyId),
    );
    if (acl) {
      const bibtex = rekeyBibtex(acl);
      const parsed = parseBibtex(bibtex);
      const r = {
        isPublished: true as const,
        bibtex,
        source: "aclanthology" as const,
        venue: extractVenueLabel(bibtex),
        year: parsed?.fields.year ? Number(parsed.fields.year) : undefined,
      };
      tap("aclanthology").hit(workshopLabel(r));
      const final = accept(r);
      if (final) return final;
    } else if (acl === null) {
      tap("aclanthology").miss();
    }
  }

  // 1. DBLP — title + authors (if any).
  const dblp = await tryStep("dblp", () =>
    fetchDblpBibtex(fetchFn, { title, authors }),
  );
  if (dblp) {
    const bibtex = rekeyBibtex(dblp);
    const parsed = parseBibtex(bibtex);
    const r = {
      isPublished: true as const,
      bibtex,
      source: "dblp" as const,
      venue: extractVenueLabel(bibtex),
      year: parsed?.fields.year ? Number(parsed.fields.year) : undefined,
    };
    tap("dblp").hit(workshopLabel(r));
    const final = accept(r);
    if (final) return final;
  } else if (dblp === null) {
    tap("dblp").miss();
  }

  // 2. OpenReview — title search; great for ICLR/NeurIPS/COLM/TMLR.
  const or = await tryStep("openreview", () =>
    fetchOpenReviewBibtex(fetchFn, { title, authors }),
  );
  if (or) {
    const bibtex = rekeyBibtex(or.bibtex);
    const r = {
      isPublished: true as const,
      bibtex,
      source: "openreview" as const,
      venue: or.venue ?? extractVenueLabel(bibtex),
    };
    tap("openreview").hit(workshopLabel(r));
    const final = accept(r);
    if (final) return final;
  } else if (or === null) {
    tap("openreview").miss();
  }

  // 3. Crossref title search — broad coverage across publishers.
  const cr = await tryStep("crossref-title", () =>
    fetchCrossrefByTitle(fetchFn, { title, authors }),
  );
  if (cr) {
    const bibtex = rekeyBibtex(cr);
    const parsed = parseBibtex(bibtex);
    const r = {
      isPublished: true as const,
      bibtex,
      source: "crossref" as const,
      venue: extractVenueLabel(bibtex),
      year: parsed?.fields.year ? Number(parsed.fields.year) : undefined,
    };
    tap("crossref-title").hit(workshopLabel(r));
    const final = accept(r);
    if (final) return final;
  } else if (cr === null) {
    tap("crossref-title").miss();
  }

  if (tentative) return tentative;
  return {
    isPublished: false,
    reason: "No published version found via DBLP, OpenReview, or Crossref",
  };
}

/**
 * Pull a venue hint out of the arXiv `<arxiv:comment>` field. Authors write
 * these in many forms — "Accepted at NeurIPS 2024", "To appear in X", or
 * just bare declarations like "Emergent Communication Workshop @ NeurIPS
 * 2018". We try lead-in patterns first, then fall back to a heuristic that
 * accepts any comment containing a venue-y keyword + a 4-digit year.
 */
export function parseVenueHint(
  comment: string | undefined,
): string | undefined {
  if (!comment) return undefined;

  const cleanup = (s: string) =>
    s.replace(/\s+/g, " ").trim().replace(/[,.;]+$/, "");

  const leadIns = [
    /\b(?:accepted|to appear|to be published)(?:\s+as\s+(?:an?\s+)?\w+)?(?:\s+(?:at|to|in|for))?\s+([^.;\n]+)/i,
    /\bpublished (?:in|at)\s+([^.;\n]+)/i,
    /\b(?:appears?|appeared) in\s+([^.;\n]+)/i,
  ];
  for (const re of leadIns) {
    const m = re.exec(comment);
    if (m && m[1]) return cleanup(m[1]);
  }

  // No lead-in. Accept the comment as a venue hint if it looks like one:
  //   it mentions a venue keyword (workshop/conference/symposium/etc., or a
  //   well-known acronym) AND contains a 4-digit year.
  const venueWord =
    /\b(workshop|conference|symposium|tutorial|journal|proceedings|nips|neurips|icml|iclr|acl|emnlp|naacl|eacl|colt|aaai|ijcai|cvpr|iccv|eccv|kdd|sigir|chi|uist|tacl|tmlr|inlg|coling|conll)\b/i;
  if (venueWord.test(comment) && /\b(19|20)\d{2}\b/.test(comment)) {
    // Use the whole comment, but trim parenthetical author counts /
    // figure counts that often precede the venue ("13 pages, 4 figures.
    // Accepted at X" handled by lead-ins; raw stuff like "13 pages.
    // NeurIPS 2018 Workshop" — strip the "13 pages" prefix).
    let s = comment;
    const sentences = s.split(/(?<=[.;])\s+/);
    const venueSentence = sentences.find(
      (sen) => venueWord.test(sen) && /\b(19|20)\d{2}\b/.test(sen),
    );
    if (venueSentence) s = venueSentence;
    return cleanup(s);
  }

  return undefined;
}

function rekeyBibtex(bibtex: string): string {
  const parsed = parseBibtex(bibtex);
  if (!parsed) return bibtex;
  return formatBibtex(rekey(parsed, generateKey));
}
