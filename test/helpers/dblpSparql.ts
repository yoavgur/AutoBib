/**
 * Builders for mocked sparql.dblp.org responses (SPARQL 1.1 JSON results).
 *
 * The resolver sends two queries to the same URL; mocks tell them apart by a
 * substring of the (URL-encoded) query text:
 *   DBLP_SEARCH — the title search (QLever text index)
 *   DBLP_RECORD — the full record of the chosen publication
 */
export const DBLP_SEARCH = "contains-word";
export const DBLP_RECORD = "signatureOrdinal";

const SCHEMA = "https://dblp.org/rdf/schema#";

type Term = { type: "uri" | "literal"; value: string };
const uri = (value: string): Term => ({ type: "uri", value });
const lit = (value: string): Term => ({ type: "literal", value });
const term = (v: string): Term => (/^https?:\/\//.test(v) ? uri(v) : lit(v));

function results(vars: string[], bindings: Record<string, Term>[]): string {
  return JSON.stringify({ head: { vars }, results: { bindings } });
}

export interface DblpCandidate {
  key: string;
  /** As DBLP stores it — with the trailing period. */
  title: string;
  /** rdf:type local name: "Inproceedings", "Article", "Informal", ... */
  type: string;
  year?: string;
  authors?: string[];
}

export function candidatesBody(cands: DblpCandidate[]): string {
  return results(
    ["pub", "type", "year", "title", "names"],
    cands.map((c) => ({
      pub: uri(`https://dblp.org/rec/${c.key}`),
      type: uri(SCHEMA + c.type),
      title: lit(c.title),
      names: lit((c.authors ?? []).join("|")),
      ...(c.year ? { year: lit(c.year) } : {}),
    })),
  );
}

export interface DblpRecord {
  /** dblp:schema local name → value, for the publication itself. */
  pub: Record<string, string>;
  /** Same, for the proceedings volume / book it is part of. */
  parent?: Record<string, string>;
  authors?: string[];
  editors?: string[];
}

/** Rows come back in reverse order, so tests also cover sorting signatures
 *  by ordinal rather than trusting the endpoint's row order. */
export function recordBody(rec: DblpRecord): string {
  const rows: Record<string, Term>[] = [];
  for (const [p, v] of Object.entries(rec.pub)) {
    rows.push({ src: lit("pub"), p: uri(SCHEMA + p), value: term(v) });
  }
  for (const [p, v] of Object.entries(rec.parent ?? {})) {
    rows.push({ src: lit("parent"), p: uri(SCHEMA + p), value: term(v) });
  }
  (rec.authors ?? []).forEach((n, i) =>
    rows.push({ src: lit("author"), ord: lit(String(i + 1)), value: lit(n) }),
  );
  (rec.editors ?? []).forEach((n, i) =>
    rows.push({ src: lit("editor"), ord: lit(String(i + 1)), value: lit(n) }),
  );
  return results(["src", "p", "ord", "value"], rows.reverse());
}

export const BIBTEX_INPROCEEDINGS = "http://purl.org/net/nknouf/ns/bibtex#Inproceedings";
export const BIBTEX_ARTICLE = "http://purl.org/net/nknouf/ns/bibtex#Article";

/** What dblp.org now serves to non-browser clients: HTTP 200, text/html. */
export const ANUBIS_PAGE =
  '<!doctype html><html lang="en"><head><title>Making sure you&#39;re not a bot!</title>' +
  '<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast","difficulty":16}}</script>' +
  "</head><body>Protected by Anubis</body></html>";
