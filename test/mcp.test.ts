import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../src/server.js";
import { memoryStore, type AccountStore } from "../src/storage.js";
import { numbersInRecords } from "../src/patents.js";
import { DISCLAIMER } from "../src/disclaimer.js";
import { grounded, usptoSample } from "./fixtures.js";

const xml = `<?xml version="1.0"?><us-patent-grant><abstract><p>A labeled nucleotide analog for sequencing.</p></abstract><claims><claim><claim-text>1. A method of sequencing nucleic acids.</claim-text></claim></claims><us-references-cited><us-citation><patcit><document-id><country>US</country><doc-number>11466319</doc-number><kind>B2</kind></document-id></patcit></us-citation></us-references-cited></us-patent-grant>`;
const epo = {
  "exchange-document": {
    "bibliographic-data": {
      "invention-title": { $: "How citations are retrieved in OPS" },
      "abstract": { p: { $: "A published citation example." } },
      "publication-reference": { "document-id": { country: { $: "EP" }, "doc-number": { $: "0351918" }, kind: { $: "A1" } } }
    }
  }
};
const payloads = [JSON.stringify(usptoSample), xml, JSON.stringify(epo), JSON.stringify({ records: [{ referenceIdentifier: "12000000", applicationNumberText: "16111111" }] })];

function mockFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("accesstoken")) return Promise.resolve(Response.json({ access_token: "token", expires_in: 1200 }));
  if (url.includes("oa_citations")) return Promise.resolve(Response.json({ records: [{ referenceIdentifier: "12000000", applicationNumberText: "16111111" }] }));
  if (url.includes(".xml")) return Promise.resolve(new Response(xml, { status: 200, headers: { "content-type": "application/xml" } }));
  if (url.includes("ops.epo.org")) return Promise.resolve(Response.json(epo));
  if (url.includes("api.uspto.gov")) return Promise.resolve(Response.json(usptoSample));
  return Promise.resolve(new Response("not mocked", { status: 404 }));
}

async function listen(app: Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function cookieFrom(response: Response): string {
  return response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
}

async function accessToken(url: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registered = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: ["http://127.0.0.1/callback"] })
  });
  const client = await registered.json() as { client_id: string };
  const signup = await fetch(`${url}/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: `founder-${randomBytes(4).toString("hex")}@example.com`, password: "correct-horse" })
  });
  expect(signup.status).toBe(201);
  const cookie = cookieFrom(signup);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    scope: "patent:read"
  });
  const approved = await fetch(`${url}/authorize?${query}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ ...Object.fromEntries(query), decision: "approve" }),
    redirect: "manual"
  });
  const location = new URL(approved.headers.get("location") ?? "");
  const token = await fetch(`${url}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: location.searchParams.get("code"),
      redirect_uri: "http://127.0.0.1/callback",
      client_id: client.client_id,
      code_verifier: verifier
    })
  });
  const body = await token.json() as { access_token: string };
  expect(token.status).toBe(200);
  return body.access_token;
}

async function mcp(url: string, method: string, params: unknown, token?: string) {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: unknown } };
}

function toolJson(text: string): { patents?: Array<Record<string, unknown>>; disclaimer?: string; error?: string } {
  return JSON.parse(text.slice(text.indexOf("{"))) as { patents?: Array<Record<string, unknown>>; disclaimer?: string; error?: string };
}

describe("Streamable HTTP tools", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
  });

  it("lists tools and runs each one with office-backed results", async () => {
    const store: AccountStore = memoryStore();
    const app = createApp({
      store,
      fetchImpl: mockFetch,
      env: {
        AUTH_SECRET: "test-auth-secret",
        USPTO_API_KEY: "test-key",
        EPO_CONSUMER_KEY: "epo-key",
        EPO_CONSUMER_SECRET: "epo-secret"
      }
    });
    const server = await listen(app);
    closers.push(server.close);
    const listed = await mcp(server.url, "tools/list", {});
    expect(listed.status).toBe(200);
    const tools = (listed.body.result as { tools: Array<{ name: string; description: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["search_patents", "get_patent", "find_patent_citations", "search_prior_art"]);
    for (const tool of tools) expect(tool.description.toLowerCase()).toContain("not legal advice");
    const citations = tools.find((tool) => tool.name === "find_patent_citations");
    expect(citations?.description).toContain("EPO citation search when configured");
    expect(citations?.description).toContain("The PatentsView citation graph is paused");

    const denied = await mcp(server.url, "tools/call", { name: "search_patents", arguments: { keywords: "nucleotide" } });
    expect(denied.status).toBe(401);

    const token = await accessToken(server.url);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["search_patents", { keywords: "nucleotide sequencing", cpc: "C12Q", assignee: "Pacific", inventor: "SEBO", dateFrom: "2020-01-01" }],
      ["get_patent", { patentNumber: "US12000000" }],
      ["find_patent_citations", { patentNumber: "12000000", direction: "both" }],
      ["search_prior_art", { idea: "A labeled nucleotide analog for sequencing nucleic acids in a reaction mixture." }]
    ];
    for (const [name, args] of calls) {
      const response = await mcp(server.url, "tools/call", { name, arguments: args }, token);
      expect(response.status, name).toBe(200);
      const text = response.body.result?.content?.[0]?.text ?? "";
      expect(text.startsWith(DISCLAIMER), name).toBe(true);
      const payload = toolJson(text);
      expect(payload.disclaimer).toContain("not legal advice");
      expect(payload.error, JSON.stringify(payload)).toBeUndefined();
      const patents = (payload.patents ?? []) as never;
      expect(patents.length, name).toBeGreaterThan(0);
      const blob = payloads.join("\n");
      for (const number of numbersInRecords(patents)) expect(grounded(number, blob), `${name} ${number}`).toBe(true);
    }

    const home = await fetch(server.url);
    const html = await home.text();
    expect(html).toContain("/logo.jpg");
    expect(html).toContain("Patent by Ouroboros");
    expect(html).toContain("Search USPTO records (EPO when a free key is added)");
    expect(html).not.toContain("Search USPTO and EPO records");
    expect(html).toContain("Not legal advice");
    expect(html).not.toMatch(/\$\s?\d/);
  });

  it("blocks tool calls after the trial ends", async () => {
    const store = memoryStore();
    const app = createApp({
      store,
      fetchImpl: mockFetch,
      env: { AUTH_SECRET: "test-auth-secret", USPTO_API_KEY: "test-key" }
    });
    const server = await listen(app);
    closers.push(server.close);
    const token = await accessToken(server.url);
    await store.update((draft) => {
      draft.users[0].trialEndsAt = new Date(Date.now() - 1000).toISOString();
    });
    const response = await mcp(server.url, "tools/call", { name: "search_patents", arguments: { keywords: "nucleotide" } }, token);
    expect(response.status).toBe(403);
  });
});
