import { resolveBibtex } from "./resolveClient.js";
import type { ResolverInput } from "../resolver/types.js";
import { openProgressToast } from "./ui.js";

const MARK_ATTR = "data-autobib-injected";

/**
 * Pull authors out of the meta line that Scholar renders below each result
 * (`.gs_a`), which looks like:
 *   "M Turpin, J Michael, E Perez… - arXiv preprint arXiv:2305.04388, 2023"
 * The first segment (before the dash) is the author list, comma-separated.
 * Scholar truncates with "…" when there are many authors, but the first few
 * are enough for DBLP/OpenReview matching.
 */
function extractAuthors(row: Element): string[] {
  const meta = row.querySelector<HTMLElement>(".gs_a");
  if (!meta) return [];
  const text = meta.textContent ?? "";
  // Split on the dash that separates authors from venue/year.
  const dashIdx = text.search(/\s[-–]\s/);
  const head = dashIdx >= 0 ? text.slice(0, dashIdx) : text;
  return head
    .split(/[,;]/)
    .map((s) => s.replace(/…|\.\.\.$/g, "").trim())
    .filter((s) => s.length >= 2 && !/^\d+$/.test(s));
}

/** Find an aclanthology.org link in any of the row's anchors and pull out
 *  the paperId. Useful for very recent ACL papers that aren't yet in DBLP /
 *  Crossref / OpenReview. */
function extractAnthologyId(row: Element): string | null {
  const anchors = Array.from(row.querySelectorAll<HTMLAnchorElement>("a[href]"));
  for (const a of anchors) {
    const href = a.href || "";
    const m = /aclanthology\.org\/([A-Za-z0-9.\-]+?)(?:\/|\.pdf|\.bib)?(?:[?#]|$)/i.exec(
      href,
    );
    if (!m) continue;
    const id = m[1]!;
    if (/^(search|events|venues|sigs|volumes|people|info|posts|faq)$/i.test(id))
      continue;
    return id;
  }
  return null;
}

function extractFromResult(row: Element): ResolverInput | null {
  // Look for arXiv and DOI patterns in the visible result blob.
  const text = row.textContent ?? "";
  const arxivMatch =
    /arxiv(?:\.org)?[:/]?\s*(\d{4}\.\d{4,5})/i.exec(text) ??
    /\barXiv:(\d{4}\.\d{4,5})/i.exec(text);
  if (arxivMatch) return { kind: "arxiv", id: arxivMatch[1]! };

  const doiMatch = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i.exec(text);
  if (doiMatch) return { kind: "doi", doi: doiMatch[0] };

  const titleEl = row.querySelector<HTMLAnchorElement>("h3 a");
  if (titleEl?.textContent) {
    return {
      kind: "title",
      title: titleEl.textContent.trim(),
      authors: extractAuthors(row),
      anthologyId: extractAnthologyId(row) ?? undefined,
    };
  }
  return null;
}

function injectInRow(row: HTMLElement): void {
  if (row.hasAttribute(MARK_ATTR)) return;
  const actions = row.querySelector<HTMLElement>(".gs_fl");
  if (!actions) return;
  const input = extractFromResult(row);
  if (!input) return;
  row.setAttribute(MARK_ATTR, "1");

  const sep = document.createTextNode(" · ");
  const btn = document.createElement("a");
  btn.href = "#";
  btn.className = "autobib-button autobib-button-compact";
  btn.textContent = "AutoBib";
  btn.title = "Copy BibTeX of the published version (AutoBib)";
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const orig = btn.textContent;
    btn.textContent = "AutoBib…";
    const ui = openProgressToast();
    try {
      const result = await resolveBibtex(input, {
        onProgress: (e) => ui.apply(e),
      });
      await ui.finish(result);
    } catch (err) {
      ui.fail(String(err));
    } finally {
      btn.textContent = orig;
    }
  });
  actions.appendChild(sep);
  actions.appendChild(btn);
}

function scan(): void {
  for (const row of document.querySelectorAll<HTMLElement>(".gs_or, .gs_ri")) {
    injectInRow(row);
  }
}

const observer = new MutationObserver(scan);
observer.observe(document.body, { childList: true, subtree: true });
scan();
