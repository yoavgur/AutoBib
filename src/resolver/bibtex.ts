/**
 * Minimal BibTeX parser/serializer. Good enough for entries returned by
 * Crossref / DBLP / arXiv; not a general-purpose parser.
 */

export interface BibEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
}

export function parseBibtex(input: string): BibEntry | null {
  const trimmed = input.trim();
  const header = /^@(\w+)\s*\{\s*([^,\s]+)\s*,/m.exec(trimmed);
  if (!header) return null;
  const type = header[1]!.toLowerCase();
  const key = header[2]!;
  const body = trimmed.slice(header[0].length, trimmed.lastIndexOf("}"));

  const fields: Record<string, string> = {};
  // Tokenize fields: name = {value} or name = "value", possibly nested braces.
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    if (i >= body.length) break;
    const nameMatch = /^([A-Za-z][\w-]*)\s*=\s*/.exec(body.slice(i));
    if (!nameMatch) break;
    i += nameMatch[0].length;
    const fieldName = nameMatch[1]!.toLowerCase();
    const open = body[i];
    let value = "";
    if (open === "{") {
      let depth = 0;
      i++;
      while (i < body.length) {
        const c = body[i]!;
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) {
            i++;
            break;
          }
          depth--;
        }
        value += c;
        i++;
      }
    } else if (open === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        value += body[i];
        i++;
      }
      if (body[i] === '"') i++;
    } else {
      // bare token (number, abbreviation)
      while (i < body.length && !/[,\s}]/.test(body[i]!)) {
        value += body[i];
        i++;
      }
    }
    fields[fieldName] = value.replace(/\s+/g, " ").trim();
  }
  return { type, key, fields };
}

export function formatBibtex(entry: BibEntry): string {
  const lines = [`@${entry.type}{${entry.key},`];
  const order = [
    "author",
    "title",
    "booktitle",
    "journal",
    "year",
    "month",
    "volume",
    "number",
    "pages",
    "publisher",
    "address",
    "editor",
    "series",
    "doi",
    "url",
    "eprint",
    "archiveprefix",
    "primaryclass",
    "note",
  ];
  const seen = new Set<string>();
  const emit = (name: string) => {
    const v = entry.fields[name];
    if (v === undefined) return;
    seen.add(name);
    lines.push(`  ${name} = {${v}},`);
  };
  for (const f of order) emit(f);
  for (const f of Object.keys(entry.fields)) {
    if (!seen.has(f)) emit(f);
  }
  // Trim trailing comma on last field for readability.
  const last = lines[lines.length - 1];
  if (last && last.endsWith(",")) lines[lines.length - 1] = last.slice(0, -1);
  lines.push("}");
  return lines.join("\n");
}

/** Strip braces / LaTeX from a name and lowercase-asciify for a citation key. */
function asciifyForKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[{}\\]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

/** First author last name from a BibTeX `author` field ("Last, First and ..."). */
export function firstAuthorLastName(authorField: string | undefined): string {
  if (!authorField) return "anon";
  const first = authorField.split(/\s+and\s+/i)[0]!.trim();
  if (first.includes(",")) return asciifyForKey(first.split(",")[0]!);
  // "First Middle Last" — last token.
  const tokens = first.split(/\s+/);
  return asciifyForKey(tokens[tokens.length - 1] ?? first);
}

/** First non-stopword from a title, lowercased + asciified. */
export function firstTitleWord(title: string | undefined): string {
  if (!title) return "untitled";
  const stop = new Set([
    "a",
    "an",
    "the",
    "on",
    "of",
    "in",
    "for",
    "to",
    "and",
    "or",
    "with",
    "from",
    "by",
    "is",
    "are",
    "as",
    "at",
    "into",
  ]);
  const words = title
    .replace(/[{}\\]/g, "")
    .split(/[\s\-:,;.!?]+/)
    .filter(Boolean);
  for (const w of words) {
    const a = asciifyForKey(w);
    if (a && !stop.has(a)) return a;
  }
  return asciifyForKey(words[0] ?? "untitled") || "untitled";
}

/** Default key scheme: <lastname><year><titleword>. */
export function generateKey(entry: BibEntry): string {
  const last = firstAuthorLastName(entry.fields.author);
  const year = (entry.fields.year ?? "").replace(/[^0-9]/g, "") || "nodate";
  const word = firstTitleWord(entry.fields.title);
  return `${last}${year}${word}`;
}

export function rekey(entry: BibEntry, scheme = generateKey): BibEntry {
  return { ...entry, key: scheme(entry) };
}

const WORKSHOP_RE =
  /\b(workshop|workshops|tutorial|tutorials|symposium|companion proceedings|student research|doctoral consortium|extended abstract|demonstration track|demo track)\b/i;

/** True if the BibTeX entry looks like a workshop / tutorial / non-archival
 *  track rather than a main-conference or journal paper. */
export function isWorkshopBibtex(bibtex: string): boolean {
  const e = parseBibtex(bibtex);
  if (!e) return false;
  return isWorkshopEntry(e);
}

export function isWorkshopEntry(e: BibEntry): boolean {
  // DBLP keys for workshop papers usually live under conf/<venue>w/ or
  // contain explicit "ws" or "Workshop" markers.
  if (/\/(workshop|w\d+|ws)\//i.test(e.key)) return true;
  // ACL Anthology paperIds for workshops use sub-volume codes like
  //   2025.acl-srw.X (student research workshop)
  //   2025.X-tutorials.Y, .demos., .ws., .findings-, etc.
  if (/^\d{4}\.[a-z\-]+-(ws|srw|tutorials?|demos?|industry)\b/i.test(e.key)) {
    return true;
  }
  const fields = [
    e.fields.booktitle,
    e.fields.series,
    e.fields.journal,
    e.fields.note,
  ];
  return fields.some((v) => v && WORKSHOP_RE.test(v));
}

/** Same check but on a free-text venue string (e.g. OpenReview's `venue`). */
export function isWorkshopVenue(venue: string | undefined): boolean {
  return Boolean(venue && WORKSHOP_RE.test(venue));
}

/** Aliases for venues that DBLP sometimes spells out instead of using the
 *  acronym. The pattern matches the spelled-out form in the booktitle/journal
 *  and we surface the short acronym instead. */
const VENUE_ALIASES: { acro: string; pattern: RegExp }[] = [
  { acro: "NeurIPS", pattern: /\bNeural Information Processing Systems\b/i },
  { acro: "ICML", pattern: /\bInternational Conference on Machine Learning\b/i },
  {
    acro: "ICLR",
    pattern: /\bInternational Conference on Learning Representations\b/i,
  },
  {
    acro: "ACL",
    pattern:
      /\bAnnual Meeting of the Association for Computational Linguistics\b/i,
  },
  {
    acro: "EMNLP",
    pattern: /\bEmpirical Methods in Natural Language Processing\b/i,
  },
  {
    acro: "NAACL",
    pattern:
      /\bNorth American Chapter of the Association for Computational Linguistics\b/i,
  },
  { acro: "INLG", pattern: /\bInternational Natural Language Generation\b/i },
  {
    acro: "AISTATS",
    pattern: /\bArtificial Intelligence and Statistics\b/i,
  },
  { acro: "AAAI", pattern: /\bAAAI Conference on Artificial Intelligence\b/i },
  { acro: "CVPR", pattern: /\bComputer Vision and Pattern Recognition\b/i },
];

/** Known venue acronyms we're willing to surface as a short label. Curated
 *  rather than auto-extracted because DBLP booktitles contain lots of caps
 *  noise (`{USA}`, `{ACL} 2025 - Volume 1` etc.) that would otherwise leak. */
const KNOWN_VENUES = [
  // ML
  "NeurIPS",
  "ICML",
  "ICLR",
  "AISTATS",
  "COLT",
  "UAI",
  "AAAI",
  "IJCAI",
  "TMLR",
  "JMLR",
  "COLM",
  // NLP
  "ACL",
  "EMNLP",
  "NAACL",
  "EACL",
  "COLING",
  "CoNLL",
  "TACL",
  "INLG",
  // CV
  "CVPR",
  "ICCV",
  "ECCV",
  "BMVC",
  "WACV",
  // Data / IR / ML adjacent
  "KDD",
  "WWW",
  "WSDM",
  "RecSys",
  "CIKM",
  "SIGIR",
  // HCI
  "CHI",
  "UIST",
  "CSCW",
  // Theory
  "STOC",
  "FOCS",
  "SODA",
  // Systems / PL
  "OSDI",
  "SOSP",
  "NSDI",
  "USENIX",
  "POPL",
  "PLDI",
  "OOPSLA",
  // General-purpose journals
  "Nature",
  "Science",
  "PNAS",
  "Cell",
];

/**
 * Extract a short, human-friendly venue label from a BibTeX entry. We look
 * for any of the venues in `KNOWN_VENUES` inside the booktitle/journal field
 * and combine with the entry's year. If no known venue matches, fall back to
 * a tidied/truncated booktitle.
 */
export function extractVenueLabel(bibtex: string): string | undefined {
  const e = parseBibtex(bibtex);
  if (!e) return undefined;
  const raw = e.fields.booktitle ?? e.fields.journal;
  if (!raw) return undefined;
  const cleaned = raw.replace(/[{}]/g, "");
  const year = e.fields.year ?? /\b(\d{4})\b/.exec(cleaned)?.[1];

  for (const v of KNOWN_VENUES) {
    const re = new RegExp(`\\b${v}\\b`, "i");
    if (re.test(cleaned)) {
      return year ? `${v} ${year}` : v;
    }
  }
  // No acronym in the booktitle — try the spelled-out alias patterns.
  for (const { acro, pattern } of VENUE_ALIASES) {
    if (pattern.test(cleaned)) {
      return year ? `${acro} ${year}` : acro;
    }
  }

  // Fall back: trim/truncate the raw booktitle.
  if (cleaned.length <= 70) return cleaned.trim();
  const comma = cleaned.indexOf(",");
  if (comma > 20 && comma <= 90) return cleaned.slice(0, comma).trim();
  return cleaned.slice(0, 70).replace(/\s+\S*$/, "").trim() + "…";
}
