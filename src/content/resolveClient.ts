import type {
  ProgressEvent,
  ResolveResult,
  ResolverInput,
} from "../resolver/types.js";

export interface ResolveStreamOptions {
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * Resolve via the background service worker, streaming progress events.
 * Resolves to the final ResolveResult or rejects with the error.
 */
export function resolveBibtex(
  input: ResolverInput,
  opts: ResolveStreamOptions = {},
): Promise<ResolveResult> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "autobib" });
    let settled = false;
    port.onMessage.addListener((msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as {
        kind?: string;
        event?: ProgressEvent;
        result?: ResolveResult;
        error?: string;
      };
      if (m.kind === "progress" && m.event) {
        opts.onProgress?.(m.event);
      } else if (m.kind === "result" && m.result) {
        settled = true;
        resolve(m.result);
      } else if (m.kind === "error") {
        settled = true;
        reject(new Error(m.error ?? "resolve failed"));
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) reject(new Error("Background disconnected"));
    });
    port.postMessage({ kind: "autobib:resolve", input });
  });
}
