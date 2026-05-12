import { describe, expect, it } from "vitest";
import {
  firstAuthorLastName,
  firstTitleWord,
  formatBibtex,
  generateKey,
  parseBibtex,
  rekey,
} from "../src/resolver/bibtex.js";
import {
  isWorkshopBibtex,
  isWorkshopVenue,
} from "../src/resolver/bibtex.js";
import { parseVenueHint } from "../src/resolver/index.js";

describe("parseBibtex", () => {
  it("parses a Crossref-style entry with nested braces", () => {
    const input = `@inproceedings{Brown_2020,
  author = {Brown, Tom and Mann, Benjamin},
  title = {Language Models are Few-Shot Learners},
  booktitle = {Advances in {NeurIPS}},
  year = 2020,
  pages = {1877--1901}
}`;
    const e = parseBibtex(input)!;
    expect(e.type).toBe("inproceedings");
    expect(e.key).toBe("Brown_2020");
    expect(e.fields.author).toBe("Brown, Tom and Mann, Benjamin");
    expect(e.fields.booktitle).toBe("Advances in {NeurIPS}");
    expect(e.fields.year).toBe("2020");
    expect(e.fields.pages).toBe("1877--1901");
  });

  it("returns null for non-BibTeX input", () => {
    expect(parseBibtex("not bibtex at all")).toBeNull();
  });
});

describe("key generation", () => {
  it("derives last name from 'Last, First'", () => {
    expect(firstAuthorLastName("Brown, Tom and Mann, Benjamin")).toBe("brown");
  });

  it("derives last name from 'First Last'", () => {
    expect(firstAuthorLastName("Tom Brown and Benjamin Mann")).toBe("brown");
  });

  it("strips diacritics for keys", () => {
    expect(firstAuthorLastName("Bahdanau, Dzmitry")).toBe("bahdanau");
  });

  it("skips stopwords in title", () => {
    expect(firstTitleWord("Attention is all you need")).toBe("attention");
    expect(firstTitleWord("On the dangers of stochastic parrots")).toBe(
      "dangers",
    );
  });

  it("composes a key with author+year+titleword", () => {
    const e = parseBibtex(
      `@article{x, author={Smith, Jane}, title={A Cool Paper}, year=2021}`,
    )!;
    expect(generateKey(e)).toBe("smith2021cool");
  });
});

describe("isWorkshopBibtex / isWorkshopVenue", () => {
  it("flags ACL workshop sub-volume keys", () => {
    expect(
      isWorkshopBibtex(
        `@inproceedings{x2025foo, author={A}, title={t}, booktitle={Proceedings of the realm Workshop}, year=2025}`,
      ),
    ).toBe(true);
    expect(
      isWorkshopBibtex(
        `@inproceedings{2025.acl-srw.5, author={A}, title={t}, booktitle={ACL SRW}, year=2025}`,
      ),
    ).toBe(true);
  });
  it("does not flag main-conference entries", () => {
    expect(
      isWorkshopBibtex(
        `@inproceedings{vaswani2017attention, author={Vaswani}, title={Attention is All You Need}, booktitle={Advances in Neural Information Processing Systems 30}, year=2017}`,
      ),
    ).toBe(false);
  });
  it("flags workshop venue strings", () => {
    expect(isWorkshopVenue("ICLR 2024 Workshop on Foundation Models")).toBe(true);
    expect(isWorkshopVenue("NeurIPS 2023")).toBe(false);
    expect(isWorkshopVenue(undefined)).toBe(false);
  });
});

describe("parseVenueHint", () => {
  it("extracts venue from 'Accepted at X' comments", () => {
    expect(
      parseVenueHint(
        "Accepted as a spotlight to REALM (First Workshop for Research on Agent Language Models) at ACL 2025",
      ),
    ).toMatch(/REALM/);
  });
  it("extracts venue from 'To appear in X' comments", () => {
    expect(parseVenueHint("To appear in NeurIPS 2024")).toBe("NeurIPS 2024");
  });
  it("extracts venue from 'Published in X' comments", () => {
    expect(parseVenueHint("Published in Nature 2023")).toBe("Nature 2023");
  });
  it("returns undefined for non-matching comments", () => {
    expect(parseVenueHint("13 pages, 4 figures")).toBeUndefined();
    expect(parseVenueHint(undefined)).toBeUndefined();
  });
});

describe("rekey roundtrip", () => {
  it("re-keys without losing fields", () => {
    const e = parseBibtex(
      `@inproceedings{old, author={Brown, Tom}, title={Language Models}, year=2020, booktitle={NeurIPS}}`,
    )!;
    const out = formatBibtex(rekey(e));
    expect(out).toContain("@inproceedings{brown2020language,");
    expect(out).toContain("author = {Brown, Tom}");
    expect(out).toContain("booktitle = {NeurIPS}");
  });
});
