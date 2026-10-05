import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BlobNotFoundError, BlobPreconditionFailedError, get, put } from "@vercel/blob";

export const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
  trialEndsAt: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string;
  currentPeriodEnd?: string;
};

export type ClientRecord = {
  clientId: string;
  clientSecretHash?: string;
  clientSecretSalt?: string;
  redirectUris: string[];
  clientName: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  createdAt: string;
};

export type CodeRecord = {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: string;
};

export type TokenRecord = {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  userId: string;
  scope: string;
  resource: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

/**
 * One JSON document. This is the only persisted shape.
 * OAuth clients, authorization codes, refresh tokens, and accounts live here,
 * not in process memory, so another serverless instance can finish the flow.
 */
export type StoreState = {
  users: UserRecord[];
  clients: ClientRecord[];
  codes: CodeRecord[];
  tokens: TokenRecord[];
};

export const DEFAULT_BLOB_PATH = "patent/accounts.json";
const BLOB_WRITE_ATTEMPTS = 5;

export function emptyState(): StoreState {
  return { users: [], clients: [], codes: [], tokens: [] };
}

export interface AccountStore {
  readonly backend: string;
  read(): Promise<StoreState>;
  update(mutate: (draft: StoreState) => void): Promise<StoreState>;
}

function prune(state: StoreState, now = Date.now()) {
  state.codes = state.codes.filter((code) => Date.parse(code.expiresAt) > now);
  state.tokens = state.tokens.filter((token) => Date.parse(token.refreshExpiresAt) > now);
}

function isState(value: unknown): value is StoreState {
  if (!value || typeof value !== "object") return false;
  const record = value as StoreState;
  return Array.isArray(record.users) && Array.isArray(record.clients) && Array.isArray(record.codes) && Array.isArray(record.tokens);
}

export function memoryStore(initial?: StoreState): AccountStore {
  let state: StoreState = initial ?? emptyState();
  let chain = Promise.resolve();
  return {
    backend: "memory",
    async read() {
      return structuredClone(state);
    },
    update(mutate) {
      const run = chain.then(async () => {
        const draft = structuredClone(state);
        prune(draft);
        mutate(draft);
        prune(draft);
        state = draft;
        return structuredClone(state);
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    }
  };
}

export function fileStore(filePath: string): AccountStore {
  let chain = Promise.resolve();
  async function load(): Promise<StoreState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      return isState(parsed) ? parsed : emptyState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }
  return {
    backend: "file",
    async read() {
      return load();
    },
    update(mutate) {
      const run = chain.then(async () => {
        const draft = await load();
        prune(draft);
        mutate(draft);
        prune(draft);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(draft), "utf8");
        return structuredClone(draft);
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    }
  };
}

export function httpStore(url: string, token: string, fetchImpl: typeof fetch): AccountStore {
  let chain = Promise.resolve();
  const headers = (): Headers => {
    const result = new Headers({ accept: "application/json" });
    if (token) result.set("authorization", `Bearer ${token}`);
    return result;
  };
  async function load(): Promise<StoreState> {
    const response = await fetchImpl(url, { method: "GET", headers: headers(), signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return emptyState();
    const text = await response.text();
    if (!response.ok) throw new Error(`Storage backend returned ${response.status}`);
    if (!text) return emptyState();
    const parsed: unknown = JSON.parse(text);
    return isState(parsed) ? parsed : emptyState();
  }
  return {
    backend: "http",
    async read() {
      return load();
    },
    update(mutate) {
      const run = chain.then(async () => {
        const draft = await load();
        prune(draft);
        mutate(draft);
        prune(draft);
        const putHeaders = headers();
        putHeaders.set("content-type", "application/json");
        const response = await fetchImpl(url, {
          method: "PUT",
          headers: putHeaders,
          body: JSON.stringify(draft),
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`Storage backend returned ${response.status}`);
        return structuredClone(draft);
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    }
  };
}

export type BlobGetResult = {
  stream: ReadableStream<Uint8Array> | null;
  blob?: { etag?: string };
} | null;

/** Enough of `@vercel/blob` for tests to stand in for the real client. */
export type BlobStoreClient = {
  get(pathname: string, options: { access: "private"; useCache: false }): Promise<BlobGetResult>;
  put(
    pathname: string,
    body: string,
    options: {
      access: "private";
      allowOverwrite: true;
      addRandomSuffix: false;
      contentType: "application/json";
      ifMatch?: string;
    }
  ): Promise<unknown>;
};

export function blobPathFromEnv(env: NodeJS.ProcessEnv): string {
  return env.STORAGE_BLOB_PATH || DEFAULT_BLOB_PATH;
}

function blobFailure(error: unknown, name: string, type: new () => Error): boolean {
  return error instanceof type || (error instanceof Error && error.name === name);
}

function liveBlobClient(token: string | undefined): BlobStoreClient {
  const auth = token ? { token } : {};
  return {
    get(pathname, options) {
      return get(pathname, { ...options, ...auth });
    },
    put(pathname, body, options) {
      return put(pathname, body, { ...options, ...auth });
    }
  };
}

/**
 * Private Vercel Blob document. `BLOB_READ_WRITE_TOKEN` is read by the client
 * (Vercel injects it). Expired authorization codes and refresh tokens are
 * removed on every write. `ifMatch` plus a short retry keeps two instances
 * from dropping each other's update.
 */
export function blobStore(pathname: string, client?: BlobStoreClient, token?: string): AccountStore {
  const blobs = client ?? liveBlobClient(token);
  let chain = Promise.resolve();
  async function load(): Promise<{ state: StoreState; etag?: string }> {
    try {
      const result = await blobs.get(pathname, { access: "private", useCache: false });
      if (!result) return { state: emptyState() };
      const etag = result.blob?.etag || undefined;
      if (!result.stream) return { state: emptyState(), etag };
      const text = await new Response(result.stream).text();
      if (!text) return { state: emptyState(), etag };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Storage document is not valid JSON");
      }
      if (!isState(parsed)) throw new Error("Storage document has an unexpected shape");
      return { state: parsed, etag };
    } catch (error) {
      if (blobFailure(error, "BlobNotFoundError", BlobNotFoundError)) return { state: emptyState() };
      throw error;
    }
  }
  return {
    backend: "blob",
    async read() {
      return (await load()).state;
    },
    update(mutate) {
      const run = chain.then(async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt < BLOB_WRITE_ATTEMPTS; attempt += 1) {
          const loaded = await load();
          const draft = structuredClone(loaded.state);
          prune(draft);
          mutate(draft);
          prune(draft);
          try {
            await blobs.put(pathname, JSON.stringify(draft), {
              access: "private",
              allowOverwrite: true,
              addRandomSuffix: false,
              contentType: "application/json",
              ifMatch: loaded.etag
            });
            return structuredClone(draft);
          } catch (error) {
            lastError = error;
            if (!blobFailure(error, "BlobPreconditionFailedError", BlobPreconditionFailedError) || attempt === BLOB_WRITE_ATTEMPTS - 1) throw error;
          }
        }
        throw lastError;
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    }
  };
}

export function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, blobClient?: BlobStoreClient): AccountStore {
  const backend = (env.STORAGE_BACKEND ?? "memory").toLowerCase();
  if (backend === "file") return fileStore(env.STORAGE_PATH || "./data/patent-store.json");
  if (backend === "http") {
    if (!env.STORAGE_URL) throw new Error("STORAGE_URL is required when STORAGE_BACKEND=http");
    return httpStore(env.STORAGE_URL, env.STORAGE_TOKEN ?? "", fetchImpl);
  }
  if (backend === "blob") {
    if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required when STORAGE_BACKEND=blob");
    return blobStore(blobPathFromEnv(env), blobClient, env.BLOB_READ_WRITE_TOKEN);
  }
  if (backend !== "memory") throw new Error(`Unknown STORAGE_BACKEND: ${backend}`);
  return memoryStore();
}

export function accountHasAccess(user: UserRecord, now = new Date()): boolean {
  const status = user.subscriptionStatus ?? "";
  if (status === "active" || status === "trialing") {
    if (!user.currentPeriodEnd) return true;
    if (Date.parse(user.currentPeriodEnd) > now.getTime()) return true;
  }
  return Date.parse(user.trialEndsAt) > now.getTime();
}

export async function hashSecret(secret: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("base64url");
  const hash = (await scryptAsync(secret, salt)) as Buffer;
  return { hash: hash.toString("base64url"), salt };
}

export async function verifySecret(secret: string, hash: string, salt: string): Promise<boolean> {
  const actual = (await scryptAsync(secret, salt)) as Buffer;
  const expected = Buffer.from(hash, "base64url");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function scryptAsync(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}
