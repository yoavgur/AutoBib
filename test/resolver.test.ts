import { describe, expect, it } from "vitest";
import { resolveBibtex } from "../src/resolver/index.js";
import type { FetchFn } from "../src/resolver/types.js";

interface MockResponse {
  status?: number;
  body: string;
  json?: unknown;
}

function makeMockFetch(routes: Record<string, MockResponse>): FetchFn {
  return async (url) => {
    const matchKey = Object.keys(routes).find((pattern) =>
      url.includes(pattern),
    );
    if (!matchKey) {
      throw new Error(`no mock for ${url}`);
    }
    const r = routes[matchKey]!;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => r.body,
      json: async () => (r.json !== undefined ? r.json : JSON.parse(r.body)),
    };
  };
}

const arxivAtom = (opts: {
  title: string;
  authors: string[];
  year: string;
  doi?: string;
}) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"
xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>
  <title>${opts.title}</title>
  <published>${opts.year}-01-01T00:00:00Z</published>
  ${opts.authors.map((n) => `<author><name>${n}</name></author>`).join("")}
  ${opts.doi ? `<arxiv:doi>${opts.doi}</arxiv:doi>` : ""}
</entry></feed>`;

describe("resolveBibtex (mocked)", () => {
  it("returns DBLP entry for a CS conference paper", async () => {
    const fetchFn = makeMockFetch({
      "export.arxiv.org/api/query": {
        body: arxivAtom({
          title: "Language Models are Few-Shot Learners",
          authors: ["Tom B. Brown", "Benjamin Mann"],
          year: "2020",
        }),
      },
      "dblp.org/search/publ/api": {
        body: JSON.stringify({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    title: "Language Models are Few-Shot Learners",
                    year: "2020",
                    authors: {
                      author: [
                        { text: "Tom B. Brown" },
                        { text: "Benjamin Mann" },
                      ],
                    },
                    key: "conf/nips/BrownMRSKDNSSAA20",
                    type: "Conference and Workshop Papers",
                  },
                },
              ],
            },
          },
        }),
      },
      "dblp.org/rec/conf/nips/BrownMRSKDNSSAA20.bib": {
        body: `@inproceedings{DBLP:conf/nips/BrownMRSKDNSSAA20,
  author = {Tom B. Brown and Benjamin Mann},
  title = {Language Models are Few-Shot Learners},
  booktitle = {NeurIPS},
  year = {2020}
}`,
      },
    });

    const result = await resolveBibtex(
      { kind: "arxiv", id: "2005.14165" },
      { fetch: fetchFn },
    );
    expect(result.isPublished).toBe(true);
    if (result.isPublished) {
      expect(result.source).toBe("dblp");
      expect(result.bibtex).toContain("brown2020language");
      expect(result.bibtex).toContain("booktitle = {NeurIPS}");
    }
  });

  it("falls back to Crossref when DBLP misses but arXiv has a DOI", async () => {
    const fetchFn = makeMockFetch({
      "export.arxiv.org/api/query": {
        body: arxivAtom({
          title: "An Article",
          authors: ["Jane Smith"],
          year: "2022",
          doi: "10.1038/x",
        }),
      },
      "dblp.org/search/publ/api": {
        body: JSON.stringify({ result: { hits: { hit: [] } } }),
      },
      "api.crossref.org/works/10.1038/x/transform": {
        body: `@article{Smith_2022,
  author = {Smith, Jane},
  title = {An Article},
  journal = {Nature},
  year = {2022}
}`,
      },
    });
    const result = await resolveBibtex(
      { kind: "arxiv", id: "1234.56789" },
      { fetch: fetchFn },
    );
    expect(result.isPublished).toBe(true);
    if (result.isPublished) {
      expect(result.source).toBe("crossref");
      expect(result.bibtex).toContain("smith2022article");
      expect(result.bibtex).toContain("journal = {Nature}");
    }
  });

  it("returns isPublished: false when DBLP only has the preprint listing", async () => {
    const fetchFn = makeMockFetch({
      "export.arxiv.org/api/query": {
        body: arxivAtom({
          title: "Brand New Preprint",
          authors: ["Anon"],
          year: "2026",
        }),
      },
      "dblp.org/search/publ/api": {
        body: JSON.stringify({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    title: "Brand New Preprint",
                    year: "2026",
                    authors: { author: { text: "Anon" } },
                    key: "journals/corr/abs-9999-99999",
                    type: "Informal and Other Publications",
                  },
                },
              ],
            },
          },
        }),
      },
      "api2.openreview.net": {
        body: JSON.stringify({ notes: [] }),
      },
      "api.crossref.org/works?": {
        body: JSON.stringify({ message: { items: [] } }),
      },
      "arxiv.org/bibtex/": {
        body: `@misc{anon2026brand,
  title={Brand New Preprint},
  author={Anon},
  year={2026},
  eprint={9999.99999},
  archivePrefix={arXiv}
}`,
      },
    });
    const result = await resolveBibtex(
      { kind: "arxiv", id: "9999.99999" },
      { fetch: fetchFn },
    );
    expect(result.isPublished).toBe(false);
    if (!result.isPublished) {
      expect(result.reason).toMatch(/preprint/i);
      expect(result.arxivFallback).toContain("eprint={9999.99999}");
    }
  });

  it("uses OpenReview when DBLP has only the preprint and arXiv has no DOI", async () => {
    const fetchFn = makeMockFetch({
      "export.arxiv.org/api/query": {
        body: arxivAtom({
          title: "Mixing Mechanisms",
          authors: ["Yoav Gur-Arieh", "Mor Geva", "Atticus Geiger"],
          year: "2025",
        }),
      },
      "dblp.org/search/publ/api": {
        body: JSON.stringify({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    title: "Mixing Mechanisms",
                    year: "2025",
                    authors: {
                      author: [
                        { text: "Yoav Gur-Arieh" },
                        { text: "Mor Geva" },
                        { text: "Atticus Geiger" },
                      ],
                    },
                    key: "journals/corr/abs-2510-06182",
                    type: "Informal and Other Publications",
                  },
                },
              ],
            },
          },
        }),
      },
      "api2.openreview.net": {
        body: JSON.stringify({
          notes: [
            {
              id: "C1",
              content: {
                title: { value: "Mixing Mechanisms" },
                authors: { value: ["Yoav Gur-Arieh"] },
                venue: { value: "CoRR 2025" },
                venueid: { value: "dblp.org/journals/CORR/2025" },
                _bibtex: { value: "@article{x, ...}" },
              },
            },
            {
              id: "I1",
              content: {
                title: { value: "Mixing Mechanisms" },
                authors: {
                  value: ["Yoav Gur-Arieh", "Mor Geva", "Atticus Geiger"],
                },
                venue: { value: "ICLR 2026 Poster" },
                venueid: { value: "ICLR.cc/2026/Conference" },
                _bibtex: {
                  value:
                    "@inproceedings{gur-arieh2026mixing,\n  title={Mixing Mechanisms},\n  author={Yoav Gur-Arieh and Mor Geva and Atticus Geiger},\n  booktitle={ICLR},\n  year={2026}\n}",
                },
              },
            },
          ],
        }),
      },
    });
    const result = await resolveBibtex(
      { kind: "arxiv", id: "2510.06182" },
      { fetch: fetchFn },
    );
    expect(result.isPublished).toBe(true);
    if (result.isPublished) {
      expect(result.source).toBe("openreview");
      expect(result.venue).toBe("ICLR 2026 Poster");
      expect(result.bibtex).toContain("booktitle = {ICLR}");
    }
  });

  it("rejects an arXiv-issued DOI as a publication", async () => {
    const fetchFn = makeMockFetch({});
    const result = await resolveBibtex(
      { kind: "doi", doi: "10.48550/arXiv.2510.06182" },
      { fetch: fetchFn },
    );
    expect(result.isPublished).toBe(false);
    if (!result.isPublished) {
      expect(result.reason).toMatch(/arXiv-issued DOI/i);
    }
  });
});
