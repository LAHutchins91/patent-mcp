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
  PatentInputError,
  PatentService,
  PatentSourceError,
  publicationId,
  rankByKeywordOverlap
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

  it("formats CPC subgroup queries so spaced USPTO bag values still match", () => {
    expect(buildUsptoBody({ cpc: "H04L", limit: 5 }).q).toBe("applicationMetaData.cpcClassificationBag:H04L*");
    expect(buildUsptoBody({ cpc: "H04L9/32", limit: 5 }).q).toBe(
      "(applicationMetaData.cpcClassificationBag:H04L9\\/32* OR applicationMetaData.cpcClassificationBag:H04L?9\\/32* OR applicationMetaData.cpcClassificationBag:H04L??9\\/32* OR applicationMetaData.cpcClassificationBag:H04L???9\\/32*)"
    );
    expect(buildUsptoBody({ cpc: "H04L 9/32", limit: 5 }).q).toBe(
      "(applicationMetaData.cpcClassificationBag:H04L9\\/32* OR applicationMetaData.cpcClassificationBag:H04L?9\\/32* OR applicationMetaData.cpcClassificationBag:H04L??9\\/32* OR applicationMetaData.cpcClassificationBag:H04L???9\\/32*)"
    );
    expect(buildUsptoBody({ cpc: "C07H19/207", limit: 5 }).q).toContain("C07H19\\/207*");
    expect(buildUsptoBody({ cpc: "C07H19/207", limit: 5 }).q).toContain("C07H???19\\/207*");
  });

  it("builds office queries without dropping the caller's dates", () => {
    const uspto = buildUsptoBody({ keywords: "nucleotide sequencing", cpc: "C12Q", assignee: "Pacific Biosciences", dateFrom: "2020-01-01", limit: 5 });
    expect(uspto.q).toContain("(nucleotide) AND (sequencing)");
    expect(uspto.q).not.toContain(" OR ");
    expect(uspto.q).toContain("C12Q");
    expect(uspto.q).toContain("Pacific");
    expect(uspto.pagination).toEqual({ offset: 0, limit: 5 });
    expect(buildEpoQuery({ claims: "nucleic acid sequencing", inventor: "SEBO", dateTo: "2024-06-04" })).toContain("cl all");
    expect(buildEpoQuery({ keywords: "pet water bowl" })).toBe('ta all "pet water bowl"');
  });

  it("builds a prior-art query that matches any keyword", () => {
    const uspto = buildUsptoBody({
      keywords: "water weighs smart track bowl",
      keywordMatch: "any",
      keywordField: "applicationMetaData.inventionTitle",
      limit: 25
    });
    expect(uspto.q).toBe("applicationMetaData.inventionTitle:((water) OR (weighs) OR (smart) OR (track) OR (bowl))");
    expect(uspto.q).not.toContain(" AND ");
    expect(buildUsptoBody({ keywords: "bowl", keywordMatch: "any", keywordField: "applicationMetaData.inventionTitle" }).q)
      .toBe("applicationMetaData.inventionTitle:(bowl)");
    expect(buildEpoQuery({ keywords: "pet water bowl", keywordMatch: "any" })).toBe('ta any "pet water bowl"');
  });

  it("ranks returned patents by words the office text actually contains", () => {
    const terms = keywordsFromIdea("A labeled nucleotide analog used for sequencing nucleic acids");
    expect(terms).toContain("nucleotide");
    const high = overlapScore(terms, { title: "Labeled nucleotide analogs for sequencing", abstract: "nucleic acids" });
    const low = overlapScore(terms, { title: "Chair leg", abstract: "furniture" });
    expect(high).toBeGreaterThan(low);
  });

  it("drops common verbs and stopwords from an idea", () => {
    expect(keywordsFromIdea("a porous separator that keeps battery electrodes apart")).toEqual([
      "porous",
      "separator",
      "battery",
      "electrodes"
    ]);
  });

  it("keeps short content words and reads past a long stopword preface", () => {
    const idea = "A smart pet water bowl that weighs the water to track how much a dog or cat drinks each day and sends an alert to the owner's phone if intake drops suddenly.";
    expect(keywordsFromIdea(idea)).toEqual(["water", "smart", "pet", "bowl", "weighs", "track", "dog", "cat"]);
    const preface = "the and for with that this those about their device system method should really have something ".repeat(40);
    expect(keywordsFromIdea(`${preface} graphene aerogel battery separator`)).toEqual([
      "graphene",
      "aerogel",
      "battery",
      "separator"
    ]);
    expect(keywordsFromIdea("smart, pet-water bowl!!! (dogs/cats)")).toEqual(["smart", "pet", "water", "bowl", "dogs", "cats"]);
    expect(keywordsFromIdea("")).toEqual([]);
    expect(keywordsFromIdea("   !!! ??? ... ###")).toEqual([]);
    expect(keywordsFromIdea("the and for with that this those how should something")).toEqual([]);
    expect(keywordsFromIdea(`${"battery ".repeat(80)}`)).toEqual(["battery"]);
  });

  it("ranks titles with more keyword hits first and ignores substrings", () => {
    const terms = ["smart", "pet", "water", "bowl"];
    const ranked = rankByKeywordOverlap(terms, [
      { title: "Municipal water", patentNumber: "1", abstract: "pipes" },
      { title: "Pet bowl", patentNumber: "2" },
      { title: "Smart pet water bowl", patentNumber: "3" },
      { title: "Catalyst for carpet cleaning", patentNumber: "4" }
    ]);
    expect(ranked.map((patent) => patent.patentNumber)).toEqual(["3", "2", "1", "4"]);
    expect(ranked.map((patent) => patent.keywordOverlap)).toEqual([8, 4, 2, 0]);
    expect(overlapScore(["water"], { title: "Waterproof case", abstract: "water" })).toBe(1);
    expect(overlapScore(["water"], { title: "Water bottle" })).toBe(2);
    expect(overlapScore(["bowl", "track", "cat"], { title: "Tracking bowls for cats" })).toBe(6);
    expect(overlapScore(["cat", "pet"], { title: "Catalyst petroleum" })).toBe(0);
    const tied = rankByKeywordOverlap(["water"], [
      { title: "Water filter", patentNumber: "US200" },
      { title: "Water pump", patentNumber: "US100" }
    ]);
    expect(tied.map((patent) => patent.patentNumber)).toEqual(["US100", "US200"]);
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
    expect(result.warnings).toEqual(["Patent covers US patents only. Try a US patent number (for example US10000000)."]);
  });

  it("treats a USPTO search 404 as zero results", async () => {
    const fetchImpl: typeof fetch = async () => new Response("missing", { status: 404 });
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key" });
    const result = await service.search({ keywords: "battery electrodes separator" });
    expect(result.patents).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("searches each prior-art keyword on its own and ranks the office hits", async () => {
    const queries: string[] = [];
    const idea = "A smart pet water bowl that weighs the water to track how much a dog or cat drinks each day and sends an alert to the owner's phone if intake drops suddenly.";
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { q?: string; pagination?: { limit?: number } };
      const query = body.q ?? "";
      queries.push(query);
      expect(body.pagination?.limit).toBe(25);
      const hit = (title: string, applicationNumber: string, patentNumber: string) => ({
        patentFileWrapperDataBag: [{
          applicationNumberText: applicationNumber,
          applicationMetaData: { inventionTitle: title, patentNumber }
        }]
      });
      if (query.includes("(bowl)")) return Response.json(hit("Smart pet water bowl", "300", "300"));
      if (query.includes("(water)")) return Response.json(hit("Municipal water treatment", "100", "100"));
      if (query.includes("(cat)")) return Response.json(hit("Catalyst carrier", "200", "200"));
      return Response.json({ patentFileWrapperDataBag: [] });
    };
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key" });
    const result = await service.priorArt(idea, 2);
    expect(queries.join("\n")).not.toContain(" AND ");
    for (const term of result.queryTerms) {
      expect(queries).toContain(`applicationMetaData.inventionTitle:(${term})`);
    }
    expect(result.queryTerms).toEqual(["water", "smart", "pet", "bowl", "weighs", "track", "dog", "cat"]);
    expect(result.patents.map((patent) => patent.patentNumber)).toEqual(["300", "100"]);
    expect(result.patents[0].keywordOverlap).toBeGreaterThan(result.patents[1].keywordOverlap ?? 0);
    expect(result.warnings).toEqual([]);
    const all = await service.priorArt(idea, 5);
    expect(all.patents.map((patent) => patent.patentNumber)).toEqual(["300", "100", "200"]);
    expect(all.patents[2].keywordOverlap).toBe(0);
    expect(all.patents).toHaveLength(3);
  });

  it("keeps prior-art hits when one keyword search fails", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const query = (JSON.parse(String(init?.body ?? "{}")) as { q?: string }).q ?? "";
      if (query.includes("(porous)")) return new Response("nope", { status: 500 });
      if (query.includes("(battery)")) return new Response("missing", { status: 404 });
      return Response.json(usptoSample);
    };
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key" });
    const result = await service.priorArt("a porous separator that keeps battery electrodes apart");
    expect(result.patents.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual(["USPTO Open Data Portal returned 500."]);
    expect(result.queryTerms).not.toContain("keeps");
    expect(result.queryTerms).not.toContain("apart");
  });

  it("does not search or invent records when the description has no distinctive words", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return Response.json({ patentFileWrapperDataBag: [] });
    };
    const service = new PatentService({ fetchImpl, usptoApiKey: "test-key" });
    await expect(service.priorArt("")).rejects.toBeInstanceOf(PatentInputError);
    await expect(service.priorArt("!!!! ???? .... ####")).rejects.toBeInstanceOf(PatentInputError);
    await expect(service.priorArt("the and for with that this those how should something")).rejects.toBeInstanceOf(PatentInputError);
    await expect(service.priorArt(`${"battery ".repeat(40)}`)).rejects.toBeInstanceOf(PatentInputError);
    expect(calls).toBe(0);
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
