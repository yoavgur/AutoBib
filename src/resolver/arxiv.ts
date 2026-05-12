import { formatBibtex, generateKey } from "./bibtex.js";
import type { BibEntry } from "./bibtex.js";
import type { ArxivMetaInput, FetchFn } from "./types.js";

/**
 * Build an arXiv `@misc` BibTeX entry from already-known metadata. Pure —
 * no network. Used by the resolver as a fallback when no published version
 * is found, and we already have the metadata in hand (either from the page
 * DOM or from a prior `fetchArxivMeta` call).
 */
export function buildArxivBibtex(
  arxivId: string,
  meta: ArxivMetaInput | (ArxivMeta & { primaryClass?: string }),
): string {
  const entry: BibEntry = {
    type: "misc",
    key: "tmp",
    fields: {
      author: meta.authors.join(" and "),
      title: meta.title,
      year: meta.year,
      eprint: arxivId,
      archiveprefix: "arXiv",
      ...((meta as { primaryClass?: string }).primaryClass
        ? { primaryclass: (meta as { primaryClass?: string }).primaryClass! }
        : {}),
      url: `https://arxiv.org/abs/${arxivId}`,
    },
  };
  entry.key = generateKey(entry);
  return formatBibtex(entry);
}

/**
 * Fetch the canonical arXiv BibTeX from arxiv.org's own "Export BibTeX
 * citation" endpoint at `https://arxiv.org/bibtex/<id>`. This is the
 * verbatim string the arXiv page would produce — no client-side synthesis.
 * Returns null on non-200 (e.g. paper missing).
 */
export async function fetchArxivBibtex(
  fetchFn: FetchFn,
  arxivId: string,
): Promise<string | null> {
  const url = `https://arxiv.org/bibtex/${encodeURIComponent(arxivId)}`;
  const res = await fetchFn(url, {
    headers: { Accept: "application/x-bibtex, text/plain" },
  });
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  if (!text.startsWith("@")) return null;
  return text;
}

export interface ArxivMeta {
  title: string;
  authors: string[];
  year: string;
  primaryClass?: string;
  /** DOI of the published version, if arXiv author included one. */
  doi?: string;
  /** Free-text "Journal reference" e.g. "NeurIPS 2017". */
  journalRef?: string;
  /** Free-text comment, often where authors note acceptance ("Accepted at X"). */
  comment?: string;
}

export async function fetchArxivMeta(
  fetchFn: FetchFn,
  arxivId: string,
): Promise<ArxivMeta | null> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const res = await fetchFn(url, {
    headers: { Accept: "application/atom+xml" },
  });
  if (res.ok) {
    const xml = await res.text();
    return parseArxivAtom(xml);
  }
  // Surface 429/5xx as exceptions so the resolver reports them distinctly
  // from "paper genuinely not found". 4xx (except 429) means a real
  // not-found condition.
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`arXiv unavailable (HTTP ${res.status})`);
  }
  return null;
}

function parseArxivAtom(xml: string): ArxivMeta | null {
  const entryMatch = /<entry>([\s\S]*?)<\/entry>/.exec(xml);
  if (!entryMatch) return null;
  const entry = entryMatch[1]!;
  const title = textOf(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? "");
  const published = /<published>(\d{4})/.exec(entry)?.[1] ?? "";
  const authors: string[] = [];
  const authorRe = /<author>\s*<name>([\s\S]*?)<\/name>/g;
  let m: RegExpExecArray | null;
  while ((m = authorRe.exec(entry)) !== null) {
    authors.push(textOf(m[1]!));
  }
  const primary = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1];
  const doi = textOf(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/.exec(entry)?.[1] ?? "") || undefined;
  const journalRef =
    textOf(
      /<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/.exec(
        entry,
      )?.[1] ?? "",
    ) || undefined;
  const comment =
    textOf(
      /<arxiv:comment[^>]*>([\s\S]*?)<\/arxiv:comment>/.exec(entry)?.[1] ?? "",
    ) || undefined;
  return {
    title,
    authors,
    year: published,
    primaryClass: primary,
    doi,
    journalRef,
    comment,
  };
}

function textOf(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
