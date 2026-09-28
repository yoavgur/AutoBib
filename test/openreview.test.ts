import { describe, expect, it } from "vitest";
import { fetchOpenReviewBibtex } from "../src/resolver/openreview.js";
import type { FetchFn } from "../src/resolver/types.js";

/** Mimics api2.openreview.net/notes/search today: the old `query=` parameter
 *  is rejected with a 400; `term=` works. */
const openReview: FetchFn = async (url) => {
  const params = new URL(url).searchParams;
  const body = params.has("term")
    ? JSON.stringify({
        notes: [
          {
            content: {
              title: { value: "Mamba: Linear-Time Sequence Modeling with Selective State Spaces" },
              authors: { value: ["Albert Gu", "Tri Dao"] },
              venue: { value: "COLM" },
              venueid: { value: "colmweb.org/COLM/2024/Conference" },
              _bibtex: { value: "@inproceedings{gu2024mamba,\n  title={Mamba},\n  booktitle={COLM}\n}" },
            },
          },
        ],
      })
    : JSON.stringify({
        name: "ValidationError",
        message: "request requires at least one of term, terms as parameter",
        status: 400,
      });
  const status = params.has("term") ? 200 : 400;
  return {
    ok: status < 400,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
};

describe("fetchOpenReviewBibtex", () => {
  it("searches with the `term` parameter the API now requires", async () => {
    const r = await fetchOpenReviewBibtex(openReview, {
      title: "Mamba: Linear-Time Sequence Modeling with Selective State Spaces",
      authors: ["Albert Gu", "Tri Dao"],
    });
    expect(r?.venue).toBe("COLM");
  });

  it("reports HTTP errors instead of a silent miss", async () => {
    const rejecting: FetchFn = async () => ({
      ok: false,
      status: 400,
      text: async () => "{}",
      json: async () => ({}),
    });
    await expect(
      fetchOpenReviewBibtex(rejecting, { title: "Anything" }),
    ).rejects.toThrow("HTTP 400");
  });
});
