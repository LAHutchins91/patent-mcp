import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp, safeReturnPath } from "../src/server.js";
import { accountHasAccess, hashSecret, memoryStore, type AccountStore } from "../src/storage.js";
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

const toolsListBaseline = JSON.parse(readFileSync(new URL("./tools-list.baseline.json", import.meta.url), "utf8")) as Array<{
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations: unknown;
  execution: unknown;
}>;

async function accessToken(url: string, options?: { email?: string; password?: string; register?: boolean }): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registered = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: ["http://127.0.0.1/callback"] })
  });
  const client = await registered.json() as { client_id: string };
  const email = options?.email ?? `founder-${randomBytes(4).toString("hex")}@example.com`;
  const password = options?.password ?? "correct-horse";
  const session = options?.register === false
    ? await fetch(`${url}/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password })
    })
    : await fetch(`${url}/account/register`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password })
    });
  expect(session.status).toBe(options?.register === false ? 200 : 201);
  const cookie = cookieFrom(session);
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
    expect(citations?.description).toContain("USPTO office-action citations");
    expect(citations?.description).not.toContain("EPO");
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
    expect(html).toContain("Patent by Ouroboros Apps");
    expect(html).toContain("Search US patents from the USPTO Open Data Portal");
    expect(html).toContain("United States patent records from the USPTO Open Data Portal");
    expect(html).not.toMatch(/EPO/);
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

  it("keeps tools/list schemas and changes only the USPTO descriptions", async () => {
    const app = createApp({ store: memoryStore(), env: { AUTH_SECRET: "test-auth-secret", NODE_ENV: "test" } });
    const server = await listen(app);
    closers.push(server.close);
    const listed = await mcp(server.url, "tools/list", {});
    expect(listed.status).toBe(200);
    const tools = (listed.body.result as { tools: typeof toolsListBaseline }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["search_patents", "get_patent", "find_patent_citations", "search_prior_art"]);
    const changed = new Set(["search_patents", "get_patent", "find_patent_citations"]);
    expect(tools).toHaveLength(toolsListBaseline.length);
    for (const tool of tools) {
      const before = toolsListBaseline.find((item) => item.name === tool.name);
      expect(before, tool.name).toBeDefined();
      expect(tool.title).toEqual(before?.title);
      expect(tool.inputSchema).toEqual(before?.inputSchema);
      expect(tool.annotations).toEqual({ ...(before?.annotations as object), destructiveHint: false, idempotentHint: true });
      expect(tool.annotations).toStrictEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof (tool.annotations as Record<string, unknown>)[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
      expect(tool.execution).toEqual(before?.execution);
      if (changed.has(tool.name)) {
        expect(tool.description).not.toEqual(before?.description);
        expect(tool.description).not.toMatch(/EPO/);
        expect(tool.description).toMatch(/US patent/);
        expect(tool.description).toContain("USPTO");
      } else {
        expect(tool.description).toEqual(before?.description);
      }
    }
  });

  it("serves privacy, terms, and support", async () => {
    const app = createApp({ store: memoryStore(), env: { AUTH_SECRET: "test-auth-secret" } });
    const server = await listen(app);
    closers.push(server.close);
    const privacy = await fetch(`${server.url}/privacy`);
    expect(privacy.status).toBe(200);
    expect(privacy.headers.get("content-type")).toMatch(/html/);
    const privacyHtml = await privacy.text();
    expect(privacyHtml).toContain("ouroborosplugins@gmail.com");
    expect(privacyHtml).toContain("USPTO");
    expect(privacyHtml).toContain("United States");
    expect(privacyHtml).not.toMatch(/EPO/);
    expect(privacyHtml).toContain("30 days");
    expect(privacyHtml).toContain("5 minutes");
    expect(privacyHtml).toMatch(/delet/i);
    expect(privacyHtml).not.toMatch(/\$\s?\d/);

    const terms = await fetch(`${server.url}/terms`);
    expect(terms.status).toBe(200);
    expect(terms.headers.get("content-type")).toMatch(/html/);
    const termsHtml = await terms.text();
    expect(termsHtml).toContain("Terms");
    expect(termsHtml).toContain("USPTO");
    expect(termsHtml).toContain("ouroborosplugins@gmail.com");
    expect(termsHtml).toContain("published by Ouroboros Apps");
    expect(termsHtml).not.toContain("Lawrence Hutchins");
    expect(termsHtml).not.toMatch(/\$\s?\d/);

    const support = await fetch(`${server.url}/support`);
    expect(support.status).toBe(200);
    expect(support.headers.get("content-type")).toMatch(/html/);
    const supportHtml = await support.text();
    expect(supportHtml).toContain("ouroborosplugins@gmail.com");
    expect(supportHtml).toMatch(/delet/i);
    expect(supportHtml).not.toMatch(/\$\s?\d/);

    const home = await fetch(server.url);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('href="/privacy"');
    expect(homeHtml).toContain('href="/terms"');
    expect(homeHtml).toContain('href="/support"');
  });

  it("lets a comped account search after the trial ends and blocks a normal account", async () => {
    const password = "correct-horse";
    const { hash, salt } = await hashSecret(password);
    const store = memoryStore();
    const app = createApp({
      store,
      fetchImpl: mockFetch,
      env: {
        AUTH_SECRET: "test-auth-secret",
        USPTO_API_KEY: "test-key",
        COMP_ACCOUNT_EMAILS: "comped@example.com",
        REVIEWER_LOGIN_EMAIL: "reviewer@example.com",
        REVIEWER_LOGIN_PASSWORD_HASH: `scrypt:${salt}:${hash}`
      }
    });
    const server = await listen(app);
    closers.push(server.close);

    const normal = await accessToken(server.url, { email: "founder@example.com" });
    await store.update((draft) => {
      const user = draft.users.find((item) => item.email === "founder@example.com");
      if (!user) return;
      user.trialEndsAt = new Date(Date.now() - 1000).toISOString();
      user.subscriptionStatus = undefined;
    });
    const denied = await mcp(server.url, "tools/call", { name: "search_patents", arguments: { keywords: "nucleotide" } }, normal);
    expect(denied.status).toBe(403);

    const comped = await accessToken(server.url, { email: "comped@example.com" });
    await store.update((draft) => {
      const user = draft.users.find((item) => item.email === "comped@example.com");
      if (!user) return;
      user.trialEndsAt = new Date(Date.now() - 1000).toISOString();
      user.subscriptionStatus = undefined;
    });
    const compedUser = (await store.read()).users.find((item) => item.email === "comped@example.com");
    expect(compedUser).toBeDefined();
    expect(accountHasAccess(compedUser!)).toBe(false);
    const allowed = await mcp(server.url, "tools/call", { name: "search_patents", arguments: { keywords: "nucleotide" } }, comped);
    expect(allowed.status).toBe(200);
    const allowedText = allowed.body.result?.content?.[0]?.text ?? "";
    expect(toolJson(allowedText).patents?.length).toBeGreaterThan(0);

    const signup = await fetch(`${server.url}/account/register`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: "reviewer@example.com", password })
    });
    expect(signup.status).toBe(409);
    const reviewer = await accessToken(server.url, { email: "reviewer@example.com", password, register: false });
    const reviewerUser = (await store.read()).users.find((item) => item.email === "reviewer@example.com");
    expect(reviewerUser).toBeDefined();
    expect(Date.parse(reviewerUser!.trialEndsAt)).toBeLessThan(Date.now());
    expect(accountHasAccess(reviewerUser!)).toBe(false);
    const reviewed = await mcp(server.url, "tools/call", { name: "get_patent", arguments: { patentNumber: "US12000000" } }, reviewer);
    expect(reviewed.status).toBe(200);
    const reviewedText = reviewed.body.result?.content?.[0]?.text ?? "";
    expect(toolJson(reviewedText).patents?.length).toBeGreaterThan(0);

    const wrong = await fetch(`${server.url}/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: "reviewer@example.com", password: "not-the-reviewer-password" })
    });
    expect(wrong.status).toBe(401);
  });
});


describe("OpenAI challenge and safe return paths", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
  });

  it("serves the OpenAI apps challenge from OPENAI_APPS_CHALLENGE", async () => {
    const missingApp = createApp({ store: memoryStore(), env: { AUTH_SECRET: "test-auth-secret", USPTO_API_KEY: "test-key" } });
    const missingServer = await listen(missingApp);
    closers.push(missingServer.close);
    const missing = await fetch(`${missingServer.url}/.well-known/openai-apps-challenge`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await missing.text()).toBe("Verification is not configured.");

    const presentApp = createApp({
      store: memoryStore(),
      env: { AUTH_SECRET: "test-auth-secret", USPTO_API_KEY: "test-key", OPENAI_APPS_CHALLENGE: "challenge-token-value" }
    });
    const presentServer = await listen(presentApp);
    closers.push(presentServer.close);
    const present = await fetch(`${presentServer.url}/.well-known/openai-apps-challenge`);
    expect(present.status).toBe(200);
    expect(present.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await present.text()).toBe("challenge-token-value");
  });

  it("rejects open redirects in login return paths", () => {
    expect(safeReturnPath("/account")).toBe("/account");
    expect(safeReturnPath("/authorize?x=1")).toBe("/authorize?x=1");
    expect(safeReturnPath("//evil.example")).toBe("/");
    expect(safeReturnPath("/\\evil.example")).toBe("/");
    expect(safeReturnPath("https://evil.example")).toBe("/");
    expect(safeReturnPath("\\evil.example")).toBe("/");
    expect(safeReturnPath("/ok/nested")).toBe("/ok/nested");
  });
});
