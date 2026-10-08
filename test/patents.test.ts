import { describe, expect, it } from "vitest";
import {
  buildEpoQuery,
  buildUsptoBody,
  googlePatentsUrl,
  keywordsFromIdea,
  mapOfficeActionCitations,
  mapUsptoSearch,
  numbersInRecords,
  overlapScore,
  parseUsptoGrantXml,
  PatentService,
  PatentSourceError,
  publicationId
} from "../src/patents.js";
import { grounded, usptoSample } from "./fixtures.js";

describe("patent office mapping", () => {
  it("copies USPTO numbers only from the response", () => {
    const patents = mapUsptoSearch(usptoSample);
    expect(patents).toHaveLength(1);
    expect(patents[0].patentNumber).toBe("12000000");
    expect(patents[0].publicationNumber).toBe("US20230366018A1");
    expect(patents[0].title).toContain("LABELED NUCLEOTIDE");
    expect(patents[0].googlePatentsUrl).toBe("https://patents.google.com/patent/US20230366018A1/en");
    expect(patents[0].family.map((member) => member.patentNumber)).toEqual(["11466319", "10781483"]);
    const raw = JSON.stringify(usptoSample);
    for (const number of numbersInRecords(patents)) expect(raw).toContain(number);
  });

  it("returns nothing when the office payload has no identifiers", () => {
    expect(mapUsptoSearch({ count: 1, patentFileWrapperDataBag: [{ applicationMetaData: { inventionTitle: "Untitled" } }] })).toEqual([]);
  });

  it("reads abstract, claims, and citations from grant XML", () => {
    const xml = `<?xml version="1.0"?><us-patent-grant><abstract><p>A labeled nucleotide analog.</p></abstract><claims><claim><claim-text>1. A method of sequencing.</claim-text></claim></claims><us-references-cited><us-citation><patcit><document-id><country>US</country><doc-number>11466319</doc-number><kind>B2</kind></document-id></patcit></us-citation></us-references-cited></us-patent-grant>`;
    const parsed = parseUsptoGrantXml(xml);
    expect(parsed.abstract).toBe("A labeled nucleotide analog.");
    expect(parsed.claims[0]).toContain("method of sequencing");
    expect(parsed.cited[0].patentNumber).toBe("11466319");
    expect(xml).toContain(parsed.cited[0].patentNumber);
  });

  it("keeps office-action citations that name a different application", () => {
    const body = { records: [{ referenceIdentifier: "12000000", applicationNumberText: "16111111" }, { referenceIdentifier: "999", applicationNumberText: "18045436" }] };
    const citations = mapOfficeActionCitations(body, "12000000");
    expect(citations.map((item) => item.applicationNumber)).toEqual(["16111111"]);
  });

  it("builds office queries without dropping the caller's dates", () => {
    const uspto = buildUsptoBody({ keywords: "nucleotide sequencing", cpc: "C12Q", assignee: "Pacific Biosciences", dateFrom: "2020-01-01", limit: 5 });
    expect(uspto.q).toContain("nucleotide");
    expect(uspto.q).toContain("C12Q");
    expect(uspto.q).toContain("Pacific");
    expect(uspto.pagination).toEqual({ offset: 0, limit: 5 });
    expect(buildEpoQuery({ claims: "nucleic acid sequencing", inventor: "SEBO", dateTo: "2024-06-04" })).toContain("cl all");
  });

  it("ranks returned patents by words the office text actually contains", () => {
    const terms = keywordsFromIdea("A labeled nucleotide analog used for sequencing nucleic acids");
    expect(terms).toContain("nucleotide");
    const high = overlapScore(terms, { title: "Labeled nucleotide analogs for sequencing", abstract: "nucleic acids" });
    const low = overlapScore(terms, { title: "Chair leg", abstract: "furniture" });
    expect(high).toBeGreaterThan(low);
  });

  it("drops common verbs and stopwords from an idea", () => {
    expect(keywordsFromIdea("a porous separator that keeps battery electrodes apart").slice(0, 4)).toEqual([
      "electrodes",
      "separator",
      "battery",
      "porous"
    ]);
  });

  it("says a non-US number needs EPO credentials when they are missing", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("missing", { status: 404 });
    };
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key" });
    const result = await service.getPatent("EP0351918");
    expect(calls).toBe(0);
    expect(result.patents).toEqual([]);
    expect(result.warnings).toEqual(["Non-US numbers need EPO_CONSUMER_KEY and EPO_CONSUMER_SECRET on the server."]);
  });

  it("treats a USPTO search 404 as zero results", async () => {
    const fetchImpl: typeof fetch = async () => new Response("missing", { status: 404 });
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key" });
    const result = await service.search({ keywords: "battery electrodes separator" });
    expect(result.patents).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("retries prior art with the longest terms when USPTO returns 404", async () => {
    const queries: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const query = (JSON.parse(String(init?.body ?? "{}")) as { q?: string }).q ?? "";
      queries.push(query);
      if (query.includes("(porous)")) return new Response("missing", { status: 404 });
      return Response.json(usptoSample);
    };
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key" });
    const result = await service.priorArt("a porous separator that keeps battery electrodes apart");
    expect(queries[0]).toContain("(electrodes) AND (separator) AND (battery) AND (porous)");
    expect(queries[0]).not.toContain("keeps");
    expect(queries[0]).not.toContain("apart");
    expect(queries[1]).toBe("(electrodes) AND (separator) AND (battery)");
    expect(result.patents.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).not.toMatch(/404/);
    expect(result.queryTerms).not.toContain("keeps");
    expect(result.queryTerms).not.toContain("apart");
  });

  it("returns an empty prior-art list and a warning when USPTO search stays 404", async () => {
    const fetchImpl: typeof fetch = async () => new Response("missing", { status: 404 });
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key" });
    const result = await service.priorArt("a porous separator that keeps battery electrodes apart");
    expect(result.patents).toEqual([]);
    expect(result.warnings).toEqual(["No office returned records for those terms."]);
  });

  it("does not double the WO prefix on a PCT citation", () => {
    expect(publicationId({ country: "WO", doc: "WO 2005/080928", kind: "A1" })).toBe("WO2005/080928A1");
    expect(publicationId({ country: "EP", doc: "0351918", kind: "A1" })).toBe("EP0351918A1");
    const xml = `<?xml version="1.0"?><us-patent-grant><us-references-cited><us-citation><patcit><document-id><country>WO</country><doc-number>WO 2005/080928</doc-number><kind>A1</kind></document-id></patcit></us-citation></us-references-cited></us-patent-grant>`;
    const parsed = parseUsptoGrantXml(xml);
    expect(parsed.cited[0]?.publicationNumber).toBe("WO2005/080928A1");
    expect(parsed.cited[0]?.publicationNumber.includes("WOWO")).toBe(false);
  });

  it("does not invent a Google Patents link from an empty number", () => {
    expect(googlePatentsUrl("US", "")).toBeUndefined();
    expect(googlePatentsUrl("US", "12")).toBeUndefined();
  });

  it("refuses to search when no office credentials are configured", async () => {
    const service = new PatentService({});
    await expect(service.search({ keywords: "battery separator" })).rejects.toBeInstanceOf(PatentSourceError);
  });

  it("returns only patents present in the mocked office payloads", async () => {
    const payloads: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("accesstoken")) return Response.json({ access_token: "token", expires_in: 600 });
      if (url.includes("ops.epo.org")) {
        const body = { "exchange-document": { "bibliographic-data": { "invention-title": { $: "Citation example" }, "publication-reference": { "document-id": { country: { $: "EP" }, "doc-number": { $: "0351918" }, kind: { $: "A1" } } } } } };
        payloads.push(JSON.stringify(body));
        return Response.json(body);
      }
      payloads.push(JSON.stringify(usptoSample));
      expect(init?.headers && new Headers(init.headers).get("x-api-key")).toBe("test-key");
      return Response.json(usptoSample);
    };
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key", epoConsumerKey: "key", epoConsumerSecret: "secret" });
    const result = await service.search({ keywords: "nucleotide", limit: 5 });
    const blob = payloads.join("\n");
    expect(result.patents.length).toBeGreaterThan(0);
    for (const number of numbersInRecords(result.patents)) expect(grounded(number, blob), number).toBe(true);
    expect(result.disclaimer.toLowerCase()).toContain("not legal advice");
  });
});
