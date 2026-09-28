import { describe, expect, it } from "vitest";
import { resolveBibtex } from "../src/resolver/index.js";
import type { FetchFn, ProgressEvent } from "../src/resolver/types.js";
import {
  ANUBIS_PAGE,
  BIBTEX_INPROCEEDINGS,
  DBLP_RECORD,
  DBLP_SEARCH,
  candidatesBody,
  recordBody,
} from "./helpers/dblpSparql.js";

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
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "conf/nips/BrownMRSKDNSSAA20",
            title: "Language Models are Few-Shot Learners.",
            type: "Inproceedings",
            year: "2020",
            authors: ["Tom B. Brown", "Benjamin Mann"],
          },
        ]),
      },
      [DBLP_RECORD]: {
        body: recordBody({
          pub: {
            bibtexType: BIBTEX_INPROCEEDINGS,
            title: "Language Models are Few-Shot Learners.",
            yearOfPublication: "2020",
          },
          parent: {
            title:
              "Advances in Neural Information Processing Systems 33: Annual Conference on Neural Information Processing Systems 2020, NeurIPS 2020, December 6-12, 2020, virtual",
          },
          authors: ["Tom B. Brown", "Benjamin Mann"],
        }),
      },
    });

    const result = await resolveBibtex(
      { kind: "arxiv", id: "2005.14165" },
      { fetch: fetchFn },
    );
    expect(result.isPublished).toBe(true);
    if (result.isPublished) {
      expect(result.source).toBe("dblp");
      expect(result.venue).toBe("NeurIPS 2020");
      expect(result.bibtex).toContain("brown2020language");
      expect(result.bibtex).toContain("{NeurIPS} 2020, December 6-12, 2020, virtual}");
    }
  });

  it("reports a DBLP bot-check page as a step error and keeps resolving", async () => {
    const events: ProgressEvent[] = [];
    const fetchFn = makeMockFetch({
      "export.arxiv.org/api/query": {
        body: arxivAtom({
          title: "An Article",
          authors: ["Jane Smith"],
          year: "2022",
          doi: "10.1038/x",
        }),
      },
      [DBLP_SEARCH]: { body: ANUBIS_PAGE },
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
      { fetch: fetchFn, onProgress: (e) => events.push(e) },
    );

    expect(result.isPublished).toBe(true);
    const dblpError = events.find((e) => e.kind === "error" && e.step === "dblp");
    expect(dblpError).toMatchObject({ message: expect.stringMatching(/bot check/i) });
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
      [DBLP_SEARCH]: { body: candidatesBody([]) },
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
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "journals/corr/abs-9999-99999",
            title: "Brand New Preprint.",
            type: "Informal",
            year: "2026",
            authors: ["Anon"],
          },
        ]),
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
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "journals/corr/abs-2510-06182",
            title: "Mixing Mechanisms.",
            type: "Informal",
            year: "2025",
            authors: ["Yoav Gur-Arieh", "Mor Geva", "Atticus Geiger"],
          },
        ]),
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
