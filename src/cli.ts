#!/usr/bin/env tsx
import { resolveBibtex } from "./resolver/index.js";
import type { ResolverInput } from "./resolver/types.js";

function parseArgs(argv: string[]): ResolverInput | { error: string } {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { error: "usage: cli <arxivId|doi> | --title <title>" };
  }
  if (args[0] === "--title") {
    const title = args.slice(1).join(" ").trim();
    if (!title) return { error: "missing title" };
    return { kind: "title", title };
  }
  const raw = args[0]!.replace(/^arXiv:/i, "");
  if (/^10\./.test(raw) || raw.startsWith("doi:")) {
    return { kind: "doi", doi: raw.replace(/^doi:/i, "") };
  }
  // arXiv IDs: 4digit.5digit (new) or category/9999999 (old)
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(raw) || /^[a-z\-]+\/\d{7}$/i.test(raw)) {
    return { kind: "arxiv", id: raw };
  }
  // ACL Anthology paperId, e.g. "2025.inlg-main.37" or "P02-1040".
  if (/^\d{4}\.[a-z\-]+\.\d+$/i.test(raw) || /^[A-Z]\d{2}-\d+$/.test(raw)) {
    return { kind: "aclanthology", paperId: raw };
  }
  return { error: `unrecognized identifier: ${raw}` };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }

  const result = await resolveBibtex(parsed);

  if (result.isPublished) {
    process.stderr.write(
      `% source: ${result.source}` +
        (result.venue ? ` · ${result.venue}` : "") +
        (result.year ? ` ${result.year}` : "") +
        (result.lowConfidence ? " (low confidence)" : "") +
        "\n",
    );
    process.stdout.write(result.bibtex + "\n");
    return;
  }

  process.stderr.write(`% ${result.reason}\n`);
  // Print the best-guess synthesized entry first if we have one — it's more
  // useful than @misc for citing — but clearly label it as not verbatim. Then
  // show the arXiv fallback as a commented-out alternative.
  if (result.synthesizedBibtex) {
    process.stderr.write(
      `% best-guess @inproceedings (synthesized from ${result.synthesizedSource ?? "arXiv metadata"} — verify before citing)\n`,
    );
    process.stdout.write(result.synthesizedBibtex + "\n");
    if (result.arxivFallback) {
      process.stderr.write("% alternative: arXiv fallback (verbatim from arXiv)\n");
      const commented = result.arxivFallback
        .split("\n")
        .map((l) => `% ${l}`)
        .join("\n");
      process.stdout.write(commented + "\n");
    }
    process.exit(1);
  }
  if (result.arxivFallback) {
    process.stderr.write(
      "% (arXiv fallback follows; cite a published venue if you can find one)\n",
    );
    process.stdout.write(result.arxivFallback + "\n");
    process.exit(1);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
