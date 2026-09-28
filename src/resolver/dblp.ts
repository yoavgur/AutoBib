import { formatBibtex } from "./bibtex.js";
import type { FetchFn } from "./types.js";

/**
 * DBLP lookups go through DBLP's public SPARQL service, not dblp.org.
 *
 * dblp.org — both the search API and the /rec/{key}.bib export — sits behind
 * an Anubis proof-of-work bot wall that answers non-browser clients with a
 * 200 HTML challenge page. sparql.dblp.org serves the same records as JSON,
 * so we search there and build the BibTeX from the record's fields (the ones
 * dblp.org/rec/{key}.bib is generated from).
 *
 * sparql.dblp.org is deliberately NOT in manifest host_permissions: it sends
 * `Access-Control-Allow-Origin: *`, so plain CORS works, and an update that
 * adds a host makes Chrome disable the extension until users re-approve.
 */
const SPARQL = "https://sparql.dblp.org/sparql";
const SCHEMA = "https://dblp.org/rdf/schema#";
const REC = "https://dblp.org/rec/";

const PREFIXES = `PREFIX dblp: <${SCHEMA}>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX ql: <http://qlever.cs.uni-freiburg.de/builtin-functions/>
`;

type Binding = Record<string, { value: string } | undefined>;

interface SparqlResults {
  results?: { bindings?: Binding[] };
}

async function sparqlSelect(
  fetchFn: FetchFn,
  query: string,
): Promise<Binding[]> {
  const url = `${SPARQL}?query=${encodeURIComponent(PREFIXES + query)}`;
  const res = await fetchFn(url, {
    headers: { Accept: "application/sparql-results+json" },
  });
  // A rate limit or outage is an error, not "DBLP has no such paper".
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  // Bot walls and proxy error pages are HTML, often served with a 200.
  if (body.trimStart().startsWith("<")) {
    throw new Error("got an HTML page instead of data (bot check?)");
  }
  try {
    return (JSON.parse(body) as SparqlResults).results?.bindings ?? [];
  } catch {
    throw new Error("response was not valid JSON");
  }
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** ".../schema#Informal" → "Informal". */
function localName(iri: string | undefined): string {
  return iri?.replace(/^.*[#/]/, "") ?? "";
}

/** Words for the QLever text index, which tokenizes on non-alphanumerics.
 *  Only whole ASCII words — "schr" from "Schrödinger" is not an index word
 *  and would match nothing. Longest first, as they're the most selective. */
function searchWords(title: string): string[] {
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => /^[a-z0-9]+$/.test(w));
  const unique = [...new Set(words)].sort((a, b) => b.length - a.length);
  const long = unique.filter((w) => w.length >= 3);
  return (long.length > 0 ? long : unique).slice(0, 6);
}

/** True if the DBLP key represents an arXiv/preprint listing rather than a
 *  published venue. We never want to return one of these as `isPublished`. */
export function isPreprintKey(key: string): boolean {
  return key.startsWith("journals/corr/");
}

/**
 * Search DBLP. The text index narrows candidates to titles containing the
 * query's distinctive words, and a regex keeps only titles equal to it under
 * `normalize()` (same [a-z0-9] token sequence) — so, unlike DBLP's search
 * API, there's no relevance ranking to work around. Year and first author
 * aren't used to filter: arXiv post dates and author spellings drift from
 * the published version, so they only score candidates below.
 *
 * Returns null if the only matches are arXiv/CoRR preprint listings — those
 * are not "published" and the caller should surface that to the user.
 * Throws when DBLP can't be queried, so the caller reports an error rather
 * than a miss.
 */
export async function fetchDblpBibtex(
  fetchFn: FetchFn,
  query: { title: string; year?: number; authors?: string[] },
): Promise<string | null> {
  const tokens = normalize(query.title).split(" ").filter(Boolean);
  const words = searchWords(query.title);
  if (tokens.length === 0 || words.length === 0) return null;

  // Tokens and words are [a-z0-9]+, so they're safe to splice into the query.
  // The author join must not be OPTIONAL: QLever plans an OPTIONAL group on
  // its own — a join of two full signature indexes, ~2s — while in the main
  // group it starts from the handful of title matches. (It also drops
  // proceedings volumes, which have editor signatures only.)
  const exactTitle = `^[^a-z0-9]*${tokens.join("[^a-z0-9]+")}[^a-z0-9]*$`;
  const rows = await sparqlSelect(
    fetchFn,
    `SELECT ?pub ?type ?year ?title (GROUP_CONCAT(?name; SEPARATOR="|") AS ?names) WHERE {
  ?text ql:contains-word "${words.join(" ")}" .
  ?text ql:contains-entity ?title .
  ?pub dblp:title ?title .
  FILTER(REGEX(LCASE(STR(?title)), "${exactTitle}"))
  ?pub rdf:type ?type .
  FILTER(?type != dblp:Publication)
  OPTIONAL { ?pub dblp:yearOfPublication ?year }
  ?pub dblp:hasSignature ?sig .
  ?sig a dblp:AuthorSignature ; dblp:signatureDblpName ?name .
}
GROUP BY ?pub ?type ?year ?title
LIMIT 200`,
  );

  const wantTitle = normalize(query.title);
  const wantAuthors = (query.authors ?? []).map((n) => normalize(n));
  let best: { key: string; type: string } | null = null;
  let bestScore = -Infinity;

  for (const row of rows) {
    const iri = row.pub?.value ?? "";
    const key = iri.slice(REC.length);
    const title = row.title?.value;
    if (!iri.startsWith(REC) || !/^[\w./-]+$/.test(key)) continue;
    if (!title || normalize(title) !== wantTitle) continue;
    const type = localName(row.type?.value);
    const year = row.year?.value;
    // Lenient ±1 year — arXiv post often precedes conference publication.
    const yearScore =
      query.year && year && Math.abs(Number(year) - query.year) <= 1 ? 1 : 0;
    const dblpAuthors = (row.names?.value ?? "")
      .split("|")
      .filter(Boolean)
      .map((n) => normalize(n));
    const authorOverlap = wantAuthors.filter((a) =>
      dblpAuthors.some((d) => d.includes(a) || a.includes(d)),
    ).length;
    // Prefer conferences/journals over informal/withdrawn entries and
    // proceedings volumes (dblp:Editorship).
    const typePenalty = /informal|withdrawn|editor/i.test(type) ? -2 : 0;
    const score = 3 + yearScore + authorOverlap + typePenalty;
    if (score > bestScore) {
      bestScore = score;
      best = { key, type };
    }
  }

  if (!best || bestScore < 3) return null;

  // Reject only true preprint-only entries: the key is journals/corr/* AND
  // DBLP types it as Informal. DBLP sometimes keeps a journals/corr/* key but
  // types it as a conference paper once a venue exists (e.g., older ICLR
  // papers like Bahdanau 2015) — those have a proper booktitle and are kept.
  if (isPreprintKey(best.key) && /informal/i.test(best.type)) return null;

  return fetchRecordBibtex(fetchFn, best.key);
}

/**
 * Fetch one record, plus the proceedings volume / book it's part of, and
 * render the fields dblp.org/rec/{key}.bib carries. Signature rows carry
 * their author/editor position in ?ord; everything else is (?p, ?value).
 */
async function fetchRecordBibtex(
  fetchFn: FetchFn,
  key: string,
): Promise<string | null> {
  const pub = `<${REC}${key}>`;
  const rows = await sparqlSelect(
    fetchFn,
    `SELECT ?src ?p ?ord ?value WHERE {
  { ${pub} ?p ?value . BIND("pub" AS ?src) }
  UNION {
    ${pub} dblp:publishedAsPartOf ?parent . ?parent ?p ?value .
    BIND("parent" AS ?src)
  }
  UNION {
    ${pub} dblp:hasSignature ?sig .
    ?sig a dblp:AuthorSignature ; dblp:signatureOrdinal ?ord ; dblp:signatureDblpName ?value .
    BIND("author" AS ?src)
  }
  UNION {
    ${pub} dblp:publishedAsPartOf ?parent . ?parent dblp:hasSignature ?sig .
    ?sig a dblp:EditorSignature ; dblp:signatureOrdinal ?ord ; dblp:signatureDblpName ?value .
    BIND("editor" AS ?src)
  }
}`,
  );

  // First value per schema property, for the record and for its parent.
  const own: Record<string, string> = {};
  const parent: Record<string, string> = {};
  const people = { author: [] as [number, string][], editor: [] as [number, string][] };
  for (const row of rows) {
    const src = row.src?.value;
    const value = row.value?.value;
    if (value === undefined) continue;
    if (src === "author" || src === "editor") {
      people[src].push([Number(row.ord?.value), value]);
    } else if (src === "pub" || src === "parent") {
      const bag = src === "pub" ? own : parent;
      const prop = localName(row.p?.value);
      if (!(prop in bag)) bag[prop] = value;
    }
  }
  if (!own.title) return null;

  // Citation order, minus DBLP's homonym number ("Jian Sun 0001").
  const names = (list: [number, string][]) =>
    list
      .sort((a, b) => a[0] - b[0])
      .map(([, n]) => n.replace(/\s+\d{4}$/, ""))
      .join(" and ");
  const text = (s: string | undefined) => (s ? latexEscape(s) : undefined);

  const type = localName(own.bibtexType).toLowerCase() || "misc";
  const fields: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value) fields[name] = value;
  };
  // DBLP titles often end with a period that isn't part of the title.
  const titleText = (s: string) =>
    protectCase(latexEscape(s.replace(/\.$/, "")));

  set("author", names(people.author));
  set("editor", names(people.editor));
  set("title", titleText(own.title));
  if (type === "article") {
    set("journal", text(own.publishedInJournal));
    set("volume", own.publishedInJournalVolume);
    set("number", own.publishedInJournalVolumeIssue);
  } else {
    // A record with no parent volume keeps its short booktitle, e.g. "ICLR".
    const booktitle = parent.title ?? own.publishedInBook;
    set("booktitle", booktitle && titleText(booktitle));
    set("series", text(parent.publishedInSeries ?? own.publishedInSeries));
    set("volume", parent.publishedInSeriesVolume ?? own.publishedInSeriesVolume);
    set("publisher", text(parent.publishedBy ?? own.publishedBy));
  }
  set("pages", own.pagination?.replace(/-+/g, "--"));
  set("year", own.yearOfPublication);
  set("url", own.primaryDocumentPage);
  set("doi", own.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
  set("biburl", `https://dblp.org/rec/${key}.bib`);
  set("bibsource", "dblp computer science bibliography, https://dblp.org");
  return formatBibtex({ type, key: `DBLP:${key}`, fields });
}

const LATEX_SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/** DBLP stores plain Unicode text; escape what LaTeX would choke on. */
function latexEscape(s: string): string {
  return s.replace(/[\\{}&%$#_~^]/g, (c) => LATEX_SPECIAL[c]!);
}

/** Brace words where a capital follows a letter or digit — acronyms and
 *  CamelCase ("BERT:", "GPT-4", "ImageNet", "3D") — so sentence-casing
 *  styles keep them. Title-Case words ("Few-Shot", "(Long") stay unbraced
 *  so the style can lowercase them. */
function protectCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (/[\p{L}\p{N}]\p{Lu}/u.test(w) ? `{${w}}` : w))
    .join(" ");
}
