/**
 * Toast UI + clipboard helpers used by all content scripts.
 */
import type { ProgressEvent, ResolveResult, ResolverStep } from "../resolver/types.js";

const TOAST_ID = "autobib-toast";

const STEP_LABEL: Record<ResolverStep, string> = {
  "arxiv-meta": "arXiv",
  aclanthology: "ACL Anthology",
  dblp: "DBLP",
  "crossref-doi": "Crossref",
  openreview: "OpenReview",
  "crossref-title": "Crossref title search",
  "arxiv-comment": "arXiv comment",
};

/**
 * Robust clipboard write. The standard API requires document focus, which is
 * usually but not always present after a long-running click handler. Falls
 * back to `execCommand('copy')` via a hidden textarea, which works without
 * focus from a content-script context.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (document.hasFocus()) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy path.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function ensureToastContainer(): HTMLElement {
  let el = document.getElementById(TOAST_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = TOAST_ID;
  el.className = "autobib-toast-container";
  document.body.appendChild(el);
  return el;
}

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

interface ToastOptions {
  title: string;
  detail?: string;
  bibtex?: string;
  actions?: ToastAction[];
  variant?: "success" | "warning" | "error" | "info";
  durationMs?: number;
}

interface ToastHandle {
  el: HTMLElement;
  setTitle(text: string): void;
  setDetail(text: string): void;
  setBibtex(text: string | undefined): void;
  setVariant(v: NonNullable<ToastOptions["variant"]>): void;
  setActions(actions: ToastAction[]): void;
  setProgress(lines: string[]): void;
  remove(): void;
  scheduleAutoDismiss(ms: number): void;
}

function buildToast(opts: ToastOptions = { title: "" }): ToastHandle {
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `autobib-toast autobib-toast-${opts.variant ?? "info"}`;
  toast.innerHTML = `
    <div class="autobib-toast-body">
      <div class="autobib-toast-title"></div>
      <div class="autobib-toast-detail"></div>
      <div class="autobib-toast-progress" hidden></div>
    </div>
  `;
  const titleEl = toast.querySelector<HTMLElement>(".autobib-toast-title")!;
  const detailEl = toast.querySelector<HTMLElement>(".autobib-toast-detail")!;
  const progressEl = toast.querySelector<HTMLElement>(".autobib-toast-progress")!;

  titleEl.textContent = opts.title;
  if (opts.detail) detailEl.textContent = opts.detail;
  else detailEl.style.display = "none";

  const closeBtn = document.createElement("button");
  closeBtn.className = "autobib-toast-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.addEventListener("click", () => toast.remove());
  toast.appendChild(closeBtn);

  const actionsContainer = document.createElement("div");
  actionsContainer.className = "autobib-toast-actions";
  toast.appendChild(actionsContainer);

  let bibtexPre: HTMLPreElement | null = null;
  let showBtn: HTMLButtonElement | null = null;
  const renderBibtex = (text: string | undefined) => {
    if (showBtn) {
      showBtn.remove();
      showBtn = null;
    }
    if (bibtexPre) {
      bibtexPre.remove();
      bibtexPre = null;
    }
    if (!text) return;
    showBtn = document.createElement("button");
    showBtn.className = "autobib-toast-show";
    showBtn.textContent = "Show entry";
    bibtexPre = document.createElement("pre");
    bibtexPre.className = "autobib-toast-bibtex";
    bibtexPre.textContent = text;
    bibtexPre.hidden = true;
    showBtn.addEventListener("click", () => {
      if (!bibtexPre) return;
      bibtexPre.hidden = !bibtexPre.hidden;
      showBtn!.textContent = bibtexPre.hidden ? "Show entry" : "Hide entry";
    });
    toast.appendChild(showBtn);
    toast.appendChild(bibtexPre);
  };

  const renderActions = (actions: ToastAction[]) => {
    actionsContainer.replaceChildren();
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.className = "autobib-toast-action";
      btn.textContent = action.label;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await action.onClick();
        } finally {
          btn.disabled = false;
        }
      });
      actionsContainer.appendChild(btn);
    }
  };

  renderBibtex(opts.bibtex);
  renderActions(opts.actions ?? []);
  container.appendChild(toast);

  let dismissTimer: number | undefined;
  let pendingMs = 0;
  let hovered = false;
  const startTimer = () => {
    if (dismissTimer) window.clearTimeout(dismissTimer);
    if (pendingMs > 0 && !hovered) {
      dismissTimer = window.setTimeout(() => toast.remove(), pendingMs);
    }
  };
  // Pause auto-dismiss while the user is hovering or interacting; restart
  // (with the original duration) when they leave.
  toast.addEventListener("mouseenter", () => {
    hovered = true;
    if (dismissTimer) {
      window.clearTimeout(dismissTimer);
      dismissTimer = undefined;
    }
  });
  toast.addEventListener("mouseleave", () => {
    hovered = false;
    startTimer();
  });
  toast.addEventListener("focusin", () => {
    hovered = true;
    if (dismissTimer) {
      window.clearTimeout(dismissTimer);
      dismissTimer = undefined;
    }
  });
  toast.addEventListener("focusout", (e) => {
    // If focus moved to a child of the toast, treat as still focused.
    if (toast.contains(e.relatedTarget as Node)) return;
    hovered = false;
    startTimer();
  });

  const handle: ToastHandle = {
    el: toast,
    setTitle: (text) => {
      titleEl.textContent = text;
    },
    setDetail: (text) => {
      detailEl.textContent = text;
      detailEl.style.display = text ? "" : "none";
    },
    setBibtex: (text) => renderBibtex(text),
    setVariant: (v) => {
      toast.className = `autobib-toast autobib-toast-${v}`;
    },
    setActions: (actions) => renderActions(actions),
    setProgress: (lines) => {
      if (lines.length === 0) {
        progressEl.hidden = true;
        progressEl.replaceChildren();
        return;
      }
      progressEl.hidden = false;
      progressEl.replaceChildren();
      for (const line of lines) {
        const div = document.createElement("div");
        div.textContent = line;
        progressEl.appendChild(div);
      }
    },
    remove: () => toast.remove(),
    scheduleAutoDismiss: (ms) => {
      pendingMs = ms;
      startTimer();
    },
  };
  if (opts.durationMs && opts.durationMs > 0) {
    handle.scheduleAutoDismiss(opts.durationMs);
  }
  return handle;
}

/** Convenience for one-shot toasts that don't need to be updated. */
export function showToast(opts: ToastOptions): void {
  buildToast(opts);
}

/**
 * Open a progress toast that updates as the resolver streams events.
 * Call `finish(result)` when resolution completes to morph it into the
 * final result toast.
 */
export interface ProgressUI {
  apply(event: ProgressEvent): void;
  finish(result: ResolveResult): Promise<void>;
  fail(message: string): void;
}

export function openProgressToast(): ProgressUI {
  const toast = buildToast({
    title: "Resolving published version…",
    variant: "info",
  });
  // Track step states so the rendered list reflects history.
  type StepState = "running" | "hit" | "miss" | "error";
  const steps: {
    step: ResolverStep;
    state: StepState;
    venue?: string;
    error?: string;
  }[] = [];
  const render = () => {
    const lines = steps.map(({ step, state, venue, error }) => {
      const label = STEP_LABEL[step];
      if (state === "running") return `· ${label}…`;
      if (state === "hit") return `✓ ${label}${venue ? ` — ${venue}` : ""}`;
      if (state === "error") return `! ${label} (error: ${error ?? "unknown"})`;
      return `– ${label} (no match)`;
    });
    toast.setProgress(lines);
  };

  return {
    apply(event) {
      if (event.kind === "start") {
        steps.push({ step: event.step, state: "running" });
      } else {
        const last = [...steps].reverse().find((s) => s.step === event.step);
        if (last) {
          if (event.kind === "hit") {
            last.state = "hit";
            last.venue = event.venue;
          } else if (event.kind === "miss") {
            last.state = "miss";
          } else {
            last.state = "error";
            last.error = event.message;
          }
        }
      }
      render();
    },

    async finish(result) {
      if (result.isPublished) {
        toast.setVariant(result.lowConfidence ? "warning" : "success");
        const detail = [
          result.source,
          result.venue,
          result.year ? String(result.year) : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        toast.setTitle(
          result.lowConfidence
            ? "Found (low-confidence) BibTeX"
            : "Found published BibTeX",
        );
        toast.setDetail(detail);
        toast.setBibtex(result.bibtex);

        // Try to auto-copy. If focus has expired, the user will use the
        // explicit Copy button (a fresh user gesture).
        const copied = await copyToClipboard(result.bibtex);
        if (copied) {
          toast.setActions([
            {
              label: "Copy again",
              onClick: async () => {
                await copyToClipboard(result.bibtex);
              },
            },
          ]);
          // Update title to reflect that we already copied.
          toast.setTitle(
            result.lowConfidence
              ? "Copied (low-confidence) BibTeX"
              : "Copied published BibTeX",
          );
          toast.scheduleAutoDismiss(8000);
        } else {
          toast.setActions([
            {
              label: "Copy BibTeX",
              onClick: async () => {
                const ok = await copyToClipboard(result.bibtex);
                if (ok) toast.setTitle("Copied — paste with ⌘V");
              },
            },
          ]);
        }
        return;
      }

      // Unpublished. We don't have a published BibTeX, but if an arXiv
      // fallback is available we auto-copy it so the user has *something*
      // to paste — and we make it clear in the title that it's the arXiv
      // version, not a published one.
      toast.setVariant("warning");
      let titleSuffix = "";
      if (result.arxivFallback && !result.synthesizedBibtex) {
        const ok = await copyToClipboard(result.arxivFallback);
        if (ok) titleSuffix = " (copied arXiv)";
      }
      toast.setTitle(
        result.venueHint
          ? `Possibly published at: ${result.venueHint}${titleSuffix}`
          : `No published version found${titleSuffix}`,
      );
      toast.setDetail(result.reason);
      toast.setBibtex(result.synthesizedBibtex ?? result.arxivFallback);
      const actions: ToastAction[] = [];
      if (result.synthesizedBibtex) {
        actions.push({
          label: "Copy best-guess BibTeX",
          onClick: async () => {
            const ok = await copyToClipboard(result.synthesizedBibtex!);
            if (ok) {
              showToast({
                title: "Copied best-guess BibTeX",
                detail: `Synthesized from ${result.synthesizedSource ?? "arXiv metadata"} — please verify.`,
                variant: "warning",
                durationMs: 5000,
              });
            }
          },
        });
      }
      if (result.arxivFallback) {
        const alreadyCopied = titleSuffix === " (copied arXiv)";
        actions.push({
          label: alreadyCopied ? "Copy arXiv again" : "Copy arXiv BibTeX",
          onClick: async () => {
            const ok = await copyToClipboard(result.arxivFallback!);
            if (ok) {
              showToast({
                title: "Copied arXiv BibTeX",
                detail: "Cite a published venue if you can find one.",
                variant: "warning",
                durationMs: 5000,
              });
            }
          },
        });
      }
      toast.setActions(actions);
      // Auto-dismiss when we've already done the user's likely intended
      // action (auto-copy arXiv); otherwise stay sticky so they can decide.
      if (titleSuffix) toast.scheduleAutoDismiss(8000);
    },

    fail(message) {
      toast.setVariant("error");
      toast.setTitle("AutoBib failed");
      toast.setDetail(message);
      toast.scheduleAutoDismiss(6000);
    },
  };
}
