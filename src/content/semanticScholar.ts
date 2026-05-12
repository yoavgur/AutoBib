import { resolveBibtex } from "./resolveClient.js";
import type { ResolverInput } from "../resolver/types.js";
import { openProgressToast } from "./ui.js";

const BUTTON_ID = "autobib-button";
const BUTTON_LABEL = "Export BibTex with AutoBib";
const RESULT_MARK = "data-autobib-injected";

function isPaperPage(): boolean {
  return location.pathname.startsWith("/paper/");
}

function isSearchPage(): boolean {
  return location.pathname.startsWith("/search");
}

// ─── Paper page (single button) ──────────────────────────────────────────

function inferPaperInput(): ResolverInput | null {
  const doi = document.querySelector<HTMLMetaElement>(
    'meta[name="citation_doi"]',
  )?.content;
  if (doi) return { kind: "doi", doi };

  const arxiv = document.querySelector<HTMLMetaElement>(
    'meta[name="citation_arxiv_id"]',
  )?.content;
  if (arxiv) return { kind: "arxiv", id: arxiv };

  const title = document.querySelector<HTMLMetaElement>(
    'meta[name="citation_title"]',
  )?.content;
  if (title) return { kind: "title", title };

  return null;
}

function findPaperInjectionPoint(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("button, a"),
  );
  const citeBtn = candidates.find((el) => {
    const text = (el.textContent ?? "").trim().toLowerCase();
    if (text === "cite" || text.startsWith("cite ")) return true;
    const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
    return aria === "cite" || aria.startsWith("cite ");
  });
  if (citeBtn?.parentElement) return citeBtn.parentElement;

  const byTestId =
    document.querySelector<HTMLElement>('[data-test-id="paper-action-bar"]') ??
    document.querySelector<HTMLElement>('[data-test-id="cite-button"]')
      ?.parentElement;
  if (byTestId) return byTestId;

  const h1 = document.querySelector<HTMLElement>("h1");
  if (h1?.parentElement) return h1.parentElement;
  return null;
}

function injectPaperPage(): void {
  if (document.getElementById(BUTTON_ID)) return;
  const input = inferPaperInput();
  if (!input) return;
  const target = findPaperInjectionPoint();
  if (!target) return;
  const btn = makeButton(input, BUTTON_LABEL);
  btn.id = BUTTON_ID;
  btn.style.marginLeft = "8px";
  target.appendChild(btn);
}

// ─── Search results page (per-result buttons) ────────────────────────────

/** Find the title link inside a result row and use it to derive an input. */
function inferResultInput(row: HTMLElement): ResolverInput | null {
  // S2 result links look like /paper/<slug>/<paperId> — the paperId is the
  // 40-char hash; we hand the title to the resolver since it's more useful.
  const titleLink =
    row.querySelector<HTMLAnchorElement>('a[data-test-id="title-link"]') ??
    row.querySelector<HTMLAnchorElement>('a[href*="/paper/"]');
  if (!titleLink) return null;
  const title = titleLink.textContent?.trim();
  if (!title) return null;

  // Try to find any visible arXiv link inside the row, which gives us a much
  // better identifier than the title.
  const arxivLink = row.querySelector<HTMLAnchorElement>('a[href*="arxiv.org"]');
  if (arxivLink) {
    const m = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(arxivLink.href);
    if (m) return { kind: "arxiv", id: m[1]! };
  }

  return { kind: "title", title };
}

/** Find candidate result rows on the search page. */
function findResultRows(): HTMLElement[] {
  const selectors = [
    '[data-test-id="search-result"]',
    '[data-paper-id]',
    "article",
    ".result-page .cl-paper-row",
  ];
  for (const sel of selectors) {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(sel));
    if (rows.length > 0) return rows;
  }
  // Last resort: find every link to /paper/ and walk up to the closest
  // container that looks like a result block.
  const titleLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/paper/"]'),
  );
  const rows = new Set<HTMLElement>();
  for (const link of titleLinks) {
    const row = link.closest<HTMLElement>(
      '[data-test-id], article, [class*="result"], [class*="paper"]',
    );
    if (row && row !== document.body) rows.add(row);
  }
  return Array.from(rows);
}

/** Find the row's existing actions strip (Save / Cite / etc.). */
function findRowActions(row: HTMLElement): HTMLElement | null {
  // Look for the existing Cite button and use its parent.
  const cite = Array.from(row.querySelectorAll<HTMLElement>("button, a")).find(
    (el) => {
      const text = (el.textContent ?? "").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
      return (
        text === "cite" ||
        text.startsWith("cite ") ||
        aria === "cite" ||
        aria.startsWith("cite ")
      );
    },
  );
  return cite?.parentElement ?? null;
}

function injectInResultRow(row: HTMLElement): void {
  if (row.hasAttribute(RESULT_MARK)) return;
  const input = inferResultInput(row);
  if (!input) return;
  const actions = findRowActions(row);
  if (!actions) return;
  row.setAttribute(RESULT_MARK, "1");

  const btn = makeButton(input, "AutoBib");
  btn.classList.add("autobib-button-compact");
  btn.style.marginLeft = "12px";
  actions.appendChild(btn);
}

function injectSearchPage(): void {
  for (const row of findResultRows()) {
    injectInResultRow(row);
  }
}

// ─── Shared button factory ───────────────────────────────────────────────

function makeButton(input: ResolverInput, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "autobib-button";
  btn.textContent = label;
  btn.title = "Resolve this paper to its published venue and copy BibTeX";
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "Resolving…";
    const ui = openProgressToast();
    try {
      const result = await resolveBibtex(input, {
        onProgress: (event) => ui.apply(event),
      });
      await ui.finish(result);
    } catch (err) {
      ui.fail(String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  return btn;
}

// ─── Driver: re-run on SPA navigation ────────────────────────────────────

function tick(): void {
  try {
    if (isPaperPage()) injectPaperPage();
    else if (isSearchPage()) injectSearchPage();
  } catch {
    // Silently skip — re-attempted on next mutation.
  }
}

const observer = new MutationObserver(tick);
observer.observe(document.body, { childList: true, subtree: true });
tick();
