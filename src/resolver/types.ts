export type ResolverInput =
  | { kind: "arxiv"; id: string; prefetchedMeta?: ArxivMetaInput }
  | { kind: "doi"; doi: string }
  | { kind: "aclanthology"; paperId: string }
  | {
      kind: "title";
      title: string;
      authors?: string[];
      /** If a Scholar result links to ACL Anthology, we pass the paperId
       *  through so the resolver can hit the Anthology bib endpoint
       *  directly (covers ACL papers that aren't yet in DBLP/Crossref). */
      anthologyId?: string;
    };

/** Metadata the caller can pre-fetch (e.g. from an arXiv page DOM) to skip
 *  the arXiv API round-trip. Shape mirrors `ArxivMeta` in arxiv.ts. */
export interface ArxivMetaInput {
  title: string;
  authors: string[];
  year: string;
  doi?: string;
  journalRef?: string;
  comment?: string;
}

export type BibtexSource =
  | "crossref"
  | "dblp"
  | "openreview"
  | "aclanthology"
  | "arxiv";

export interface ResolvedPublished {
  isPublished: true;
  bibtex: string;
  source: BibtexSource;
  venue?: string;
  year?: number;
  doi?: string;
  /** True when we synthesized BibTeX from S2 fields (no DOI / DBLP entry). */
  lowConfidence?: boolean;
}

export interface ResolvedUnpublished {
  isPublished: false;
  /** arXiv BibTeX shown only as an explicit opt-in fallback (verbatim from arXiv). */
  arxivFallback?: string;
  arxivId?: string;
  /** Free-text hint extracted from arXiv comment (e.g. "REALM at ACL 2025"). */
  venueHint?: string;
  /** Best-guess @inproceedings synthesized from arXiv fields + venueHint.
   *  NOT copied from any database — opt-in only. */
  synthesizedBibtex?: string;
  /** Human-readable description of where the synthesized entry came from. */
  synthesizedSource?: string;
  reason: string;
}

export type ResolveResult = ResolvedPublished | ResolvedUnpublished;

/** Source identifiers reported in progress events. */
export type ResolverStep =
  | "arxiv-meta"
  | "aclanthology"
  | "dblp"
  | "crossref-doi"
  | "openreview"
  | "crossref-title"
  | "arxiv-comment";

export type ProgressEvent =
  | { kind: "start"; step: ResolverStep }
  | { kind: "hit"; step: ResolverStep; venue?: string }
  | { kind: "miss"; step: ResolverStep }
  | { kind: "error"; step: ResolverStep; message: string };

export type OnProgress = (event: ProgressEvent) => void;

/** Subset of fetch we actually need; lets us inject a mock in tests. */
export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;
