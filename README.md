# Autobib

Chrome extension (MV3) that adds an **Export Published BibTeX** button to paper
pages. Resolves arXiv preprints to their published venue and copies a clean
BibTeX entry to your clipboard.

When no published version exists, it tells you so — it never silently falls
back to the arXiv preprint.

## Supported pages

- arXiv abstract and PDF pages (`arxiv.org/abs/*`, `arxiv.org/pdf/*`)
- Semantic Scholar paper and search pages
- Google Scholar results

## Resolution cascade

Looks up the published version across, in order:

1. DBLP
2. Crossref (by DOI, then by title)
3. OpenReview
4. ACL Anthology (via venue hint from the arXiv comment)

## Install (from source)

```sh
npm install
npm run build
```

Then load the `dist/` directory as an unpacked extension at
`chrome://extensions` (enable Developer mode first).

## Resolver CLI

The resolver also runs standalone:

```sh
npm run cli -- 2005.14165                  # by arXiv ID
npm run cli -- 10.1145/3372297.3417883     # by DOI
npm run cli -- --title "Attention is all you need"
```

## Test

```sh
npm test
npm run typecheck
```

## License

MIT
