/**
 * Background service worker. Content scripts can't fetch cross-origin URLs
 * directly under MV3 (CORS still applies); the service worker can, since
 * `host_permissions` give it full network access.
 *
 * We use `chrome.runtime.connect()` with a long-lived port so we can stream
 * progress events back to the content script as the cascade runs, then send
 * the final result.
 */
import { resolveBibtex } from "./resolver/index.js";
import type { FetchFn, ProgressEvent, ResolverInput } from "./resolver/types.js";

/** Force `credentials: "omit"` so the browser doesn't attach the user's
 *  cookies for hosts like openreview.net / dblp.org — stale sessions can
 *  return 401 when we want anonymous read-only access. */
const fetchFn: FetchFn = (url, init) =>
  fetch(url, {
    ...(init as RequestInit | undefined),
    credentials: "omit",
  }) as unknown as ReturnType<FetchFn>;

interface ResolveStart {
  kind: "autobib:resolve";
  input: ResolverInput;
}

type Outbound =
  | { kind: "progress"; event: ProgressEvent }
  | { kind: "result"; result: Awaited<ReturnType<typeof resolveBibtex>> }
  | { kind: "error"; error: string };

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "autobib") return;

  port.onMessage.addListener((msg: unknown) => {
    if (
      typeof msg !== "object" ||
      msg === null ||
      (msg as { kind?: string }).kind !== "autobib:resolve"
    ) {
      return;
    }
    const start = msg as ResolveStart;
    const post = (m: Outbound) => {
      try {
        port.postMessage(m);
      } catch {
        // Port may have been disconnected if the user closed the tab.
      }
    };

    resolveBibtex(start.input, {
      fetch: fetchFn,
      onProgress: (event) => post({ kind: "progress", event }),
    })
      .then((result) => post({ kind: "result", result }))
      .catch((err) => {
        console.error("[autobib] resolve error", err);
        post({ kind: "error", error: String(err) });
      })
      .finally(() => {
        try {
          port.disconnect();
        } catch {}
      });
  });
});
