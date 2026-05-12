import { resolveBibtex } from "./resolveClient.js";
import type { ArxivMetaInput } from "../resolver/types.js";
import { openProgressToast } from "./ui.js";

const BUTTON_ID = "autobib-button";
const BUTTON_LABEL = "Export BibTex with AutoBib";

function extractArxivId(): string | null {
  const m = /\/abs\/([^/?#]+)/.exec(location.pathname);
  if (m) return m[1]!.replace(/v\d+$/, "");
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="citation_arxiv_id"]',
  );
  return meta?.content ?? null;
}

/**
 * Read paper metadata directly from the arXiv abstract page DOM. arXiv embeds
 * `citation_*` meta tags with all the fields we need; reading them here lets
 * the resolver skip the arXiv API entirely (which is rate-limited per IP).
 *
 * Returns null if any of the required fields (title, authors) are missing —
 * the caller will fall back to the arXiv API in that case.
 */
function extractArxivMetaFromDom(): ArxivMetaInput | null {
  const title =
    document
      .querySelector<HTMLMetaElement>('meta[name="citation_title"]')
      ?.content?.trim() ?? "";
  if (!title) return null;
  const authors = Array.from(
    document.querySelectorAll<HTMLMetaElement>('meta[name="citation_author"]'),
  )
    .map((m) => m.content.trim())
    .filter(Boolean)
    // arXiv writes authors as "Last, First". Convert to "First Last" so DBLP /
    // OpenReview / Crossref author matching works against their natural form.
    .map((name) => {
      if (!name.includes(",")) return name;
      const [last, first] = name.split(",", 2);
      return `${(first ?? "").trim()} ${(last ?? "").trim()}`.trim();
    });
  if (authors.length === 0) return null;
  const date =
    document.querySelector<HTMLMetaElement>('meta[name="citation_date"]')
      ?.content ?? "";
  const year = /\d{4}/.exec(date)?.[0] ?? "";
  const doi =
    document
      .querySelector<HTMLMetaElement>('meta[name="citation_doi"]')
      ?.content?.trim() || undefined;

  // Comments / journal-ref live in the abstract page table, not in meta tags.
  // Both are optional; absence is fine.
  const comment = readTableCell("comments");
  const journalRef = readTableCell("jref");

  return { title, authors, year, doi, comment, journalRef };
}

/** arXiv abstract pages render their metadata table as
 *  <td class="tablecell label">Comments:</td><td class="tablecell comments mathjax">…</td>
 *  — fish out the value cell by class. */
function readTableCell(cls: string): string | undefined {
  const el = document.querySelector<HTMLElement>(`td.tablecell.${cls}`);
  if (!el) return undefined;
  const text = el.textContent?.replace(/\s+/g, " ").trim();
  return text && text.length > 0 ? text : undefined;
}

/** True when the element is part of the rendered layout (not display:none /
 *  detached / inside a hidden ancestor). offsetParent is null in those cases. */
function isVisible(el: HTMLElement): boolean {
  // <body> and elements with `position: fixed` can have a null offsetParent
  // even when visible; check getClientRects as a backup.
  if (el.offsetParent !== null) return true;
  return el.getClientRects().length > 0;
}

/**
 * Find a place on the arXiv abstract page to inject the button. arXiv has
 * shipped multiple layouts; we try in order of "nicest neighbour first" and
 * degrade gracefully. As an absolute last resort we inject just inside
 * <body> as a floating block, so the button always shows up somewhere
 * visible even if all our selectors are stale.
 */
function findInjectionPoint(): { anchor: HTMLElement; placeAfter: boolean } | null {
  // 1. The "Export BibTeX citation" anchor (legacy + current layouts) — only
  //    if it's actually visible, since on the modern layout it's inside a
  //    collapsed popover.
  const links = Array.from(
    document.querySelectorAll<HTMLElement>("a, button"),
  );
  const exportLink = links.find((el) => {
    const text = (el.textContent ?? "").trim();
    const matches =
      /export\s+bibtex\s+citation/i.test(text) ||
      /^bibtex$/i.test(text) ||
      /citation_export/.test((el as HTMLAnchorElement).href ?? "");
    return matches && isVisible(el);
  });
  if (exportLink) return { anchor: exportLink, placeAfter: true };

  // 2. Right-column action lists across layouts. Always visible when present.
  //    Place AFTER the box so we don't disrupt its border styling.
  const extra =
    document.querySelector<HTMLElement>(".extra-services") ??
    document.querySelector<HTMLElement>(".extra-ref-cite") ??
    document.querySelector<HTMLElement>(".full-text") ??
    document.querySelector<HTMLElement>(".abs-button-ref-cite");
  if (extra && isVisible(extra)) return { anchor: extra, placeAfter: true };

  // 3. Just below the abstract block.
  const abs =
    document.querySelector<HTMLElement>("blockquote.abstract") ??
    document.querySelector<HTMLElement>(".abstract");
  if (abs && isVisible(abs)) return { anchor: abs, placeAfter: true };

  // 4. Below the page title.
  const h1 = document.querySelector<HTMLElement>("h1.title, h1");
  if (h1 && isVisible(h1)) return { anchor: h1, placeAfter: true };

  // 6. Absolute fallback: inject as the first child of <body> so it's
  //    impossible to miss. This shouldn't normally happen.
  if (document.body) {
    return { anchor: document.body, placeAfter: false };
  }
  return null;
}

function inject(): void {
  if (document.getElementById(BUTTON_ID)) return;
  const arxivId = extractArxivId();
  if (!arxivId) return;
  const target = findInjectionPoint();
  if (!target) return;

  const wrapper = document.createElement("div");
  wrapper.style.margin = "8px 0";
  wrapper.style.textAlign = "center";
  // If we anchored to the right-column sidebar (.extra-services etc.), match
  // its width and position so the button sits directly under that block.
  if (target.placeAfter && target.anchor.classList.contains("extra-services")) {
    const rect = target.anchor.getBoundingClientRect();
    wrapper.style.width = rect.width + "px";
    wrapper.style.marginLeft = "auto";
    wrapper.style.marginRight = "0";
  }
  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.className = "autobib-button";
  btn.textContent = BUTTON_LABEL;
  btn.title =
    "Resolve this arXiv paper to its published venue and copy BibTeX";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Resolving…";
    const ui = openProgressToast();
    try {
      // Skip the arXiv API by handing over metadata scraped from the page.
      // Falls through to API-fetch only if the DOM doesn't have what we need.
      const prefetchedMeta = extractArxivMetaFromDom() ?? undefined;
      const result = await resolveBibtex(
        { kind: "arxiv", id: arxivId, prefetchedMeta },
        { onProgress: (e) => ui.apply(e) },
      );
      await ui.finish(result);
    } catch (err) {
      ui.fail(String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = BUTTON_LABEL;
    }
  });
  wrapper.appendChild(btn);

  if (target.placeAfter) {
    // Place directly after the "Export BibTeX citation" link / element.
    target.anchor.insertAdjacentElement("afterend", wrapper);
  } else {
    target.anchor.appendChild(wrapper);
  }
}

// Run injection at multiple lifecycle points: arXiv occasionally ships
// pages where the bibtex link isn't in the initial DOM.
function tryInject(): void {
  try {
    inject();
  } catch {
    // Silently skip — re-attempted on next mutation.
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", tryInject, { once: true });
} else {
  tryInject();
}
window.addEventListener("load", tryInject, { once: true });
// In case the right column lazy-renders.
if (document.body) {
  const observer = new MutationObserver(tryInject);
  observer.observe(document.body, { childList: true, subtree: true });
}
