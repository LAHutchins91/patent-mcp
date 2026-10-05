import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";
import type { Express } from "express";
import { createApp } from "../src/server.js";
import {
  blobPathFromEnv,
  blobStore,
  createStoreFromEnv,
  emptyState,
  type BlobStoreClient,
  type StoreState
} from "../src/storage.js";

function jsonStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

type StoredBlob = { body?: string; etag: string };

function mockBlob(options?: { failures?: number }) {
  const stored: StoredBlob = { etag: "etag-0" };
  let failuresLeft = options?.failures ?? 0;
  const gets: string[] = [];
  const puts: Array<{ path: string; body: string; ifMatch?: string }> = [];
  const client: BlobStoreClient = {
    async get(pathname, getOptions) {
      expect(getOptions).toEqual({ access: "private", useCache: false });
      gets.push(pathname);
      if (stored.body === undefined) return null;
      return { stream: jsonStream(stored.body), blob: { etag: stored.etag } };
    },
    async put(pathname, body, putOptions) {
      puts.push({ path: pathname, body, ifMatch: putOptions.ifMatch });
      expect(putOptions).toMatchObject({
        access: "private",
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: "application/json"
      });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const current = stored.body ? JSON.parse(stored.body) as StoreState : emptyState();
        current.users.push({
          id: `other-${failuresLeft}`,
          email: "other@example.com",
          passwordHash: "hash",
          passwordSalt: "salt",
          createdAt: "2026-10-05T00:00:00Z",
          trialEndsAt: "2026-10-19T00:00:00Z"
        });
        stored.body = JSON.stringify(current);
        stored.etag = `etag-raced-${failuresLeft}`;
        throw new BlobPreconditionFailedError();
      }
      if (putOptions.ifMatch && stored.body !== undefined && putOptions.ifMatch !== stored.etag) {
        throw new BlobPreconditionFailedError();
      }
      stored.body = body;
      stored.etag = `etag-${puts.length}`;
    }
  };
  return {
    client,
    gets,
    puts,
    stored,
    seed(state: StoreState) {
      stored.body = JSON.stringify(state);
      stored.etag = "etag-seed";
    }
  };
}

function future(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function past(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

describe("Vercel Blob account store", () => {
  it("treats a missing blob as an empty document", async () => {
    const blob = mockBlob();
    const store = blobStore("patent/accounts.json", blob.client);
    await expect(store.read()).resolves.toEqual(emptyState());
    blob.client.get = async () => {
      throw new BlobNotFoundError();
    };
    await expect(store.read()).resolves.toEqual(emptyState());
  });

  it("prunes expired auth codes and tokens on write", async () => {
    const blob = mockBlob();
    const store = blobStore("patent/accounts.json", blob.client);
    await store.update((draft) => {
      draft.codes.push({
        code: "expired-code",
        clientId: "client",
        userId: "user",
        redirectUri: "http://127.0.0.1/callback",
        codeChallenge: "challenge",
        scope: "patent:read",
        resource: "https://patent.example/mcp",
        expiresAt: past()
      }, {
        code: "live-code",
        clientId: "client",
        userId: "user",
        redirectUri: "http://127.0.0.1/callback",
        codeChallenge: "challenge",
        scope: "patent:read",
        resource: "https://patent.example/mcp",
        expiresAt: future(60_000)
      });
      draft.tokens.push({
        accessToken: "expired-access",
        refreshToken: "expired-refresh",
        clientId: "client",
        userId: "user",
        scope: "patent:read",
        resource: "https://patent.example/mcp",
        accessExpiresAt: past(),
        refreshExpiresAt: past()
      }, {
        accessToken: "live-access",
        refreshToken: "live-refresh",
        clientId: "client",
        userId: "user",
        scope: "patent:read",
        resource: "https://patent.example/mcp",
        accessExpiresAt: future(60_000),
        refreshExpiresAt: future(60_000)
      });
    });
    const saved = JSON.parse(blob.stored.body ?? "{}") as StoreState;
    expect(saved.codes.map((item) => item.code)).toEqual(["live-code"]);
    expect(saved.tokens.map((item) => item.refreshToken)).toEqual(["live-refresh"]);
    expect(blob.puts[0]?.ifMatch).toBeUndefined();
    expect(blob.puts[0]?.path).toBe("patent/accounts.json");
  });

  it("re-reads and retries when the blob etag changed", async () => {
    const blob = mockBlob({ failures: 2 });
    blob.seed(emptyState());
    const store = blobStore("patent/accounts.json", blob.client);
    const saved = await store.update((draft) => {
      draft.clients.push({
        clientId: "patent_local",
        redirectUris: ["http://127.0.0.1/callback"],
        clientName: "Local",
        tokenEndpointAuthMethod: "none",
        createdAt: "2026-10-05T00:00:00Z"
      });
    });
    expect(blob.puts).toHaveLength(3);
    expect(saved.users.map((user) => user.id).sort()).toEqual(["other-0", "other-1"]);
    expect(saved.clients.map((client) => client.clientId)).toEqual(["patent_local"]);
    expect(blob.gets.length).toBeGreaterThanOrEqual(3);
  });

  it("stops after a few precondition failures", async () => {
    const blob = mockBlob({ failures: 5 });
    blob.seed(emptyState());
    const store = blobStore("patent/accounts.json", blob.client);
    await expect(store.update((draft) => {
      draft.users.push({
        id: "user_local",
        email: "local@example.com",
        passwordHash: "hash",
        passwordSalt: "salt",
        createdAt: "2026-10-05T00:00:00Z",
        trialEndsAt: "2026-10-19T00:00:00Z"
      });
    })).rejects.toBeInstanceOf(BlobPreconditionFailedError);
    expect(blob.puts).toHaveLength(5);
  });

  it("selects the blob backend from the environment", () => {
    expect(blobPathFromEnv({})).toBe("patent/accounts.json");
    expect(() => createStoreFromEnv({ STORAGE_BACKEND: "blob" })).toThrow(/BLOB_READ_WRITE_TOKEN is required when STORAGE_BACKEND=blob/);
    const blob = mockBlob();
    const store = createStoreFromEnv({
      STORAGE_BACKEND: "blob",
      BLOB_READ_WRITE_TOKEN: "vercel-injected",
      STORAGE_BLOB_PATH: "custom/accounts.json"
    }, fetch, blob.client);
    expect(store.backend).toBe("blob");
    return store.read().then(() => {
      expect(blob.gets).toEqual(["custom/accounts.json"]);
    });
  });

  it("shares authorization codes across two blob-backed instances", async () => {
    const blob = mockBlob();
    const first = createApp({ env: { AUTH_SECRET: "test-auth-secret" }, store: blobStore("patent/accounts.json", blob.client) });
    const second = createApp({ env: { AUTH_SECRET: "test-auth-secret" }, store: blobStore("patent/accounts.json", blob.client) });
    const alpha = await listen(first);
    const beta = await listen(second);
    try {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const registered = await fetch(`${alpha.url}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/callback"] })
      });
      const client = await registered.json() as { client_id: string };
      const signup = await fetch(`${alpha.url}/account/register`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: "founder@example.com", password: "correct-horse" })
      });
      const cookie = signup.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
      const params = {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "cross-instance",
        scope: "patent:read"
      };
      const approved = await fetch(`${alpha.url}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ ...params, decision: "approve" }),
        redirect: "manual"
      });
      const code = new URL(approved.headers.get("location") ?? "http://127.0.0.1/callback").searchParams.get("code");
      const pending = JSON.parse(blob.stored.body ?? "{}") as StoreState;
      expect(pending.codes.map((item) => item.code)).toContain(code);
      const token = await fetch(`${beta.url}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1/callback",
          client_id: client.client_id,
          code_verifier: verifier
        })
      });
      expect(token.status).toBe(200);
      const redeemed = JSON.parse(blob.stored.body ?? "{}") as StoreState;
      expect(redeemed.codes).toEqual([]);
      expect(redeemed.tokens).toHaveLength(1);
      const again = await fetch(`${alpha.url}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1/callback",
          client_id: client.client_id,
          code_verifier: verifier
        })
      });
      expect(again.status).toBe(400);
    } finally {
      await alpha.close();
      await beta.close();
    }
  });

  it("does not issue a second token when another instance already redeemed the code", async () => {
    const blob = mockBlob();
    const code = "code-once";
    blob.seed({
      ...emptyState(),
      clients: [{
        clientId: "patent_client",
        redirectUris: ["http://127.0.0.1/callback"],
        clientName: "Client",
        tokenEndpointAuthMethod: "none",
        createdAt: "2026-10-05T00:00:00Z"
      }],
      codes: [{
        code,
        clientId: "patent_client",
        userId: "user_one",
        redirectUri: "http://127.0.0.1/callback",
        codeChallenge: createHash("sha256").update("verifier-verifier-verifier-verifier-verifier").digest("base64url"),
        scope: "patent:read",
        resource: "http://127.0.0.1:8787/mcp",
        expiresAt: future(60_000)
      }]
    });
    const originalPut = blob.client.put.bind(blob.client);
    let raced = false;
    blob.client.put = async (pathname, body, putOptions) => {
      if (!raced) {
        raced = true;
        const winner = JSON.parse(blob.stored.body ?? "{}") as StoreState;
        winner.codes = [];
        winner.tokens.push({
          accessToken: "winner-access",
          refreshToken: "winner-refresh",
          clientId: "patent_client",
          userId: "user_one",
          scope: "patent:read",
          resource: "http://127.0.0.1:8787/mcp",
          accessExpiresAt: future(60_000),
          refreshExpiresAt: future(60_000)
        });
        blob.stored.body = JSON.stringify(winner);
        blob.stored.etag = "etag-winner";
        throw new BlobPreconditionFailedError();
      }
      return originalPut(pathname, body, putOptions);
    };
    const app = createApp({
      env: { AUTH_SECRET: "test-auth-secret", APP_BASE_URL: "http://127.0.0.1:8787" },
      store: blobStore("patent/accounts.json", blob.client)
    });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1/callback",
          client_id: "patent_client",
          code_verifier: "verifier-verifier-verifier-verifier-verifier"
        })
      });
      expect(response.status).toBe(400);
      const saved = JSON.parse(blob.stored.body ?? "{}") as StoreState;
      expect(saved.tokens.map((item) => item.accessToken)).toEqual(["winner-access"]);
      expect(saved.codes).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("bundles the logo into the function and sends every path there", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      functions: { "api/index.ts": { includeFiles: string } };
      routes?: Array<{ src?: string; dest?: string }>;
      rewrites: Array<{ source?: string; destination?: string }>;
    };
    expect(config.functions["api/index.ts"].includeFiles).toBe("logo.jpg");
    const routed = (config.rewrites ?? []).some((route) => route.source === "/(.*)" && route.destination === "/api");
    expect(routed).toBe(true);
  });
});

async function listen(app: Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
