import { describe, expect, it } from "vitest";
import { fetchDblpBibtex } from "../src/resolver/dblp.js";
import type { FetchFn } from "../src/resolver/types.js";
import {
  ANUBIS_PAGE,
  BIBTEX_ARTICLE,
  BIBTEX_INPROCEEDINGS,
  DBLP_RECORD,
  DBLP_SEARCH,
  candidatesBody,
  recordBody,
} from "./helpers/dblpSparql.js";

type Reply = { status?: number; body: string };

/** Mock fetch that records every URL and routes by substring. dblp.org
 *  itself always answers like the real site does today: 200 + Anubis page. */
function mockFetch(routes: Record<string, Reply>, calls: string[] = []): FetchFn {
  return async (url) => {
    calls.push(url);
    const reply: Reply | undefined = url.startsWith("https://dblp.org/")
      ? { body: ANUBIS_PAGE }
      : Object.entries(routes).find(([pattern]) => url.includes(pattern))?.[1];
    if (!reply) throw new Error(`no mock for ${url}`);
    const status = reply.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => reply.body,
      json: async () => JSON.parse(reply.body),
    };
  };
}

const ATTENTION = {
  title: "Attention Is All You Need",
  year: 2017,
  authors: ["Ashish Vaswani", "Noam Shazeer", "Jian Sun"],
};

const attentionCandidates = candidatesBody([
  {
    key: "journals/corr/VaswaniSPUJGKP17",
    title: "Attention Is All You Need.",
    type: "Informal",
    year: "2017",
    authors: ["Ashish Vaswani", "Noam Shazeer", "Jian Sun 0001"],
  },
  {
    key: "conf/nips/VaswaniSPUJGKP17",
    title: "Attention is All you Need.",
    type: "Inproceedings",
    year: "2017",
    authors: ["Ashish Vaswani", "Noam Shazeer", "Jian Sun 0001"],
  },
]);

const attentionRecord = recordBody({
  pub: {
    bibtexType: BIBTEX_INPROCEEDINGS,
    title: "Attention is All you Need.",
    yearOfPublication: "2017",
    pagination: "5998-6008",
    primaryDocumentPage:
      "https://proceedings.neurips.cc/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html",
    publishedInBook: "NIPS",
  },
  parent: {
    title:
      "Advances in Neural Information Processing Systems 30: Annual Conference on Neural Information Processing Systems 2017, December 4-9, 2017, Long Beach, CA, USA",
  },
  // "0001" is DBLP's homonym disambiguator — never part of a citation.
  authors: ["Ashish Vaswani", "Noam Shazeer", "Jian Sun 0001"],
  editors: ["Isabelle Guyon", "Ulrike von Luxburg"],
});

describe("fetchDblpBibtex (SPARQL)", () => {
  it("resolves via sparql.dblp.org and never touches dblp.org, which now serves a bot-check page", async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch(
      { [DBLP_SEARCH]: { body: attentionCandidates }, [DBLP_RECORD]: { body: attentionRecord } },
      calls,
    );

    const bib = await fetchDblpBibtex(fetchFn, ATTENTION);

    expect(bib).toContain("@inproceedings{DBLP:conf/nips/VaswaniSPUJGKP17,");
    expect(calls.length).toBe(2);
    expect(calls.every((u) => u.startsWith("https://sparql.dblp.org/sparql?"))).toBe(true);
  });

  it("builds the entry from DBLP's fields the way dblp.org/rec/*.bib did", async () => {
    const fetchFn = mockFetch({
      [DBLP_SEARCH]: { body: attentionCandidates },
      [DBLP_RECORD]: { body: attentionRecord },
    });

    const bib = (await fetchDblpBibtex(fetchFn, ATTENTION))!;

    expect(bib).toContain("author = {Ashish Vaswani and Noam Shazeer and Jian Sun},");
    expect(bib).toContain("editor = {Isabelle Guyon and Ulrike von Luxburg},");
    expect(bib).toContain("title = {Attention is All you Need},");
    expect(bib).toContain(
      "booktitle = {Advances in Neural Information Processing Systems 30: Annual Conference on Neural Information Processing Systems 2017, December 4-9, 2017, Long Beach, {CA,} {USA}},",
    );
    expect(bib).toContain("pages = {5998--6008},");
    expect(bib).toContain("year = {2017},");
    expect(bib).toContain(
      "url = {https://proceedings.neurips.cc/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html},",
    );
    expect(bib).toContain("biburl = {https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17.bib},");
  });

  it("sends only whole ASCII words to the text index and matches the full title exactly", async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch(
      { [DBLP_SEARCH]: { body: candidatesBody([]) } },
      calls,
    );

    await fetchDblpBibtex(fetchFn, {
      title: "Schrödinger's Pre-training: A Study",
      authors: ["A. Author"],
    });

    const query = new URL(calls[0]!).searchParams.get("query")!;
    const words = /ql:contains-word "([^"]*)"/.exec(query)![1]!.split(" ");
    // "schr"/"dinger" are fragments of a non-ASCII word, not index words.
    expect(words.sort()).toEqual(["pre", "study", "training"]);
    expect(query).toContain(
      '"^[^a-z0-9]*schr[^a-z0-9]+dinger[^a-z0-9]+s[^a-z0-9]+pre[^a-z0-9]+training[^a-z0-9]+a[^a-z0-9]+study[^a-z0-9]*$"',
    );
  });

  it("protects capitals and escapes LaTeX specials in titles", async () => {
    const fetchFn = mockFetch({
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "conf/x/Y24",
            title: "BERT & GPT-4: 100% Pre-training for ImageNet_v2.",
            type: "Inproceedings",
            year: "2024",
            authors: ["Ann Lee"],
          },
        ]),
      },
      [DBLP_RECORD]: {
        body: recordBody({
          pub: {
            bibtexType: BIBTEX_INPROCEEDINGS,
            title: "BERT & GPT-4: 100% Pre-training for ImageNet_v2.",
            yearOfPublication: "2024",
            publishedInBook: "X",
          },
          authors: ["Ann Lee"],
        }),
      },
    });

    const bib = (await fetchDblpBibtex(fetchFn, {
      title: "BERT & GPT-4: 100% Pre-training for ImageNet_v2",
      authors: ["Ann Lee"],
    }))!;

    expect(bib).toContain(
      "title = {{BERT} \\& {GPT-4:} 100\\% Pre-training for {ImageNet\\_v2}},",
    );
  });

  it("leaves Title-Case words for the style to lowercase and strips DBLP's trailing periods", async () => {
    const title = "LoRA for 3D (Long) Few-Shot End-to-End Models.";
    const fetchFn = mockFetch({
      [DBLP_SEARCH]: {
        body: candidatesBody([
          { key: "conf/x/Z24", title, type: "Inproceedings", year: "2024", authors: ["Ann Lee"] },
        ]),
      },
      [DBLP_RECORD]: {
        body: recordBody({
          pub: { bibtexType: BIBTEX_INPROCEEDINGS, title, yearOfPublication: "2024" },
          parent: { title: "Proceedings of Something 2024, Volume 1 (Long Papers), virtual." },
          authors: ["Ann Lee"],
        }),
      },
    });

    const bib = (await fetchDblpBibtex(fetchFn, {
      title: "LoRA for 3D (Long) Few-Shot End-to-End Models",
      authors: ["Ann Lee"],
    }))!;

    expect(bib).toContain("title = {{LoRA} for {3D} (Long) Few-Shot End-to-End Models},");
    expect(bib).toContain("booktitle = {Proceedings of Something 2024, Volume 1 (Long Papers), virtual},");
  });

  it("maps journal articles and strips the doi.org prefix", async () => {
    const fetchFn = mockFetch({
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "journals/nature/LeCunBH15",
            title: "Deep learning.",
            type: "Article",
            year: "2015",
            authors: ["Yann LeCun", "Yoshua Bengio", "Geoffrey E. Hinton"],
          },
        ]),
      },
      [DBLP_RECORD]: {
        body: recordBody({
          pub: {
            bibtexType: BIBTEX_ARTICLE,
            title: "Deep learning.",
            yearOfPublication: "2015",
            publishedInJournal: "Nat.",
            publishedInJournalVolume: "521",
            publishedInJournalVolumeIssue: "7553",
            pagination: "436-444",
            doi: "https://doi.org/10.1038/NATURE14539",
            primaryDocumentPage: "https://doi.org/10.1038/NATURE14539",
          },
          authors: ["Yann LeCun", "Yoshua Bengio", "Geoffrey E. Hinton"],
        }),
      },
    });

    const bib = (await fetchDblpBibtex(fetchFn, {
      title: "Deep learning",
      year: 2015,
      authors: ["Yann LeCun"],
    }))!;

    expect(bib).toMatch(/^@article\{DBLP:journals\/nature\/LeCunBH15,/);
    expect(bib).toContain("journal = {Nat.},");
    expect(bib).toContain("volume = {521},");
    expect(bib).toContain("number = {7553},");
    expect(bib).toContain("pages = {436--444},");
    expect(bib).toContain("doi = {10.1038/NATURE14539},");
    expect(bib).not.toContain("booktitle");
  });

  it("takes series, volume and publisher from the proceedings (LNCS)", async () => {
    const fetchFn = mockFetch({
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "conf/eccv/CarionMSUKZ20",
            title: "End-to-End Object Detection with Transformers.",
            type: "Inproceedings",
            year: "2020",
            authors: ["Nicolas Carion"],
          },
        ]),
      },
      [DBLP_RECORD]: {
        body: recordBody({
          pub: {
            bibtexType: BIBTEX_INPROCEEDINGS,
            title: "End-to-End Object Detection with Transformers.",
            yearOfPublication: "2020",
            pagination: "213-229",
            publishedInBook: "ECCV (1)",
          },
          parent: {
            title: "Computer Vision - ECCV 2020 - 16th European Conference, Proceedings, Part I",
            publishedBy: "Springer",
            publishedInSeries: "Lecture Notes in Computer Science",
            publishedInSeriesVolume: "12346",
          },
          authors: ["Nicolas Carion"],
        }),
      },
    });

    const bib = (await fetchDblpBibtex(fetchFn, {
      title: "End-to-End Object Detection with Transformers",
      authors: ["Nicolas Carion"],
    }))!;

    expect(bib).toContain(
      "booktitle = {Computer Vision - {ECCV} 2020 - 16th European Conference, Proceedings, Part I},",
    );
    expect(bib).toContain("series = {Lecture Notes in Computer Science},");
    expect(bib).toContain("volume = {12346},");
    expect(bib).toContain("publisher = {Springer},");
  });

  it("returns null when the only exact match is the CoRR preprint", async () => {
    const fetchFn = mockFetch({
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "journals/corr/abs-2601-00001",
            title: "Brand New Preprint.",
            type: "Informal",
            year: "2026",
            authors: ["Anon"],
          },
        ]),
      },
    });

    const bib = await fetchDblpBibtex(fetchFn, {
      title: "Brand New Preprint",
      year: 2026,
      authors: ["Anon"],
    });
    expect(bib).toBeNull();
  });

  it("accepts a journals/corr key that DBLP types as a conference paper (old ICLR)", async () => {
    const fetchFn = mockFetch({
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "journals/corr/BahdanauCB14",
            title: "Neural Machine Translation by Jointly Learning to Align and Translate.",
            type: "Inproceedings",
            year: "2015",
            authors: ["Dzmitry Bahdanau", "Kyunghyun Cho", "Yoshua Bengio"],
          },
        ]),
      },
      [DBLP_RECORD]: {
        body: recordBody({
          pub: {
            bibtexType: BIBTEX_INPROCEEDINGS,
            title: "Neural Machine Translation by Jointly Learning to Align and Translate.",
            yearOfPublication: "2015",
            primaryDocumentPage: "http://arxiv.org/abs/1409.0473",
          },
          parent: {
            title:
              "3rd International Conference on Learning Representations, ICLR 2015, San Diego, CA, USA, May 7-9, 2015, Conference Track Proceedings",
          },
          authors: ["Dzmitry Bahdanau", "Kyunghyun Cho", "Yoshua Bengio"],
          editors: ["Yoshua Bengio", "Yann LeCun"],
        }),
      },
    });

    const bib = (await fetchDblpBibtex(fetchFn, {
      title: "Neural Machine Translation by Jointly Learning to Align and Translate",
      year: 2014,
      authors: ["Dzmitry Bahdanau", "Kyunghyun Cho", "Yoshua Bengio"],
    }))!;

    expect(bib).toContain("@inproceedings{DBLP:journals/corr/BahdanauCB14,");
    expect(bib).toContain("{ICLR} 2015");
  });

  it("returns null when no DBLP title matches", async () => {
    const fetchFn = mockFetch({
      [DBLP_SEARCH]: {
        body: candidatesBody([
          {
            key: "conf/x/Other24",
            title: "Attention Is All You Need for Something Else.",
            type: "Inproceedings",
            year: "2024",
          },
        ]),
      },
    });

    expect(await fetchDblpBibtex(fetchFn, ATTENTION)).toBeNull();
  });

  it("reports a bot-check page as a readable error, not a JSON parse failure", async () => {
    const fetchFn = mockFetch({ [DBLP_SEARCH]: { body: ANUBIS_PAGE } });

    const err = await fetchDblpBibtex(fetchFn, ATTENTION).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/bot check/i);
    expect((err as Error).message).not.toMatch(/Unexpected token/);
  });

  it("reports HTTP errors such as rate limiting instead of a silent miss", async () => {
    const fetchFn = mockFetch({ [DBLP_SEARCH]: { status: 429, body: "Too Many Requests" } });

    await expect(fetchDblpBibtex(fetchFn, ATTENTION)).rejects.toThrow("HTTP 429");
  });
});
