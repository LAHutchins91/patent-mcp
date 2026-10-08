import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DISCLAIMER, SERVICE_NAME, VERSION } from "./disclaimer.js";
import { authorizePage, connectPage, escapeHtml, homePage, privacyPage, supportPage, termsPage } from "./pages.js";
import { PatentService } from "./patents.js";
import {
  accountHasAccess,
  createStoreFromEnv,
  hashSecret,
  memoryStore,
  TRIAL_MS,
  verifySecret,
  type AccountStore,
  type UserRecord
} from "./storage.js";
import { registerPatentTools } from "./tools.js";

const MCP_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "gemini.google.com",
  "grok.com",
  "grok.x.com",
  "cursor.com",
  "www.cursor.com"
]);

const CORS = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "600"
};

const buckets = new Map<string, { count: number; reset: number }>();
const ephemeralSecret = randomBytes(32).toString("base64url");

export type AppOptions = {
  env?: NodeJS.ProcessEnv;
  store?: AccountStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.cwd(), path.resolve(here, ".."), path.resolve(here, "..", "..")];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "logo.jpg"))) return candidate;
  }
  return path.resolve(here, "..");
}

function allow(key: string, limit: number, windowMs: number): boolean {
  if (process.env.NODE_ENV === "test") return true;
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.reset < now) {
    if (buckets.size > 10000) buckets.clear();
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function originOf(req: Request, env: NodeJS.ProcessEnv): string {
  const configured = (env.APP_BASE_URL ?? "").replace(/\/$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}`;
}

function authSecret(env: NodeJS.ProcessEnv): string {
  return env.AUTH_SECRET || ephemeralSecret;
}

function reviewerLoginEmail(env: NodeJS.ProcessEnv): string {
  return (env.REVIEWER_LOGIN_EMAIL ?? "").trim().toLowerCase();
}

/** `scrypt:<base64url salt>:<base64url hash>` from Node scrypt(password, salt, 32). */
function parseReviewerPasswordHash(value: string | undefined): { salt: string; hash: string } | undefined {
  const match = /^scrypt:([A-Za-z0-9_-]{8,128}):([A-Za-z0-9_-]{16,256})$/.exec((value ?? "").trim());
  if (!match) return undefined;
  return { salt: match[1], hash: match[2] };
}

function compedEmails(env: NodeJS.ProcessEnv): Set<string> {
  const emails = new Set<string>();
  for (const part of (env.COMP_ACCOUNT_EMAILS ?? "").split(",")) {
    const email = part.trim().toLowerCase();
    if (email.includes("@") && !email.includes(" ")) emails.add(email);
  }
  const reviewer = reviewerLoginEmail(env);
  if (reviewer.includes("@") && !reviewer.includes(" ")) emails.add(reviewer);
  return emails;
}

function originAllowed(origin: string | undefined, appOrigin: string): boolean {
  if (!origin) return true;
  if (origin === appOrigin) return true;
  try {
    const url = new URL(origin);
    if (MCP_HOSTS.has(url.hostname)) return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
  } catch {
    return false;
  }
  return false;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.header("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function signSession(userId: string, secret: string, now: number): string {
  const body = Buffer.from(JSON.stringify({ uid: userId, exp: now + 30 * 24 * 60 * 60 * 1000 })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(token: string | undefined, secret: string, now: number): string | undefined {
  if (!token) return undefined;
  const [body, sig] = token.split(".");
  if (!body || !sig) return undefined;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { uid?: string; exp?: number };
    if (!parsed.uid || typeof parsed.exp !== "number" || parsed.exp < now) return undefined;
    return parsed.uid;
  } catch {
    return undefined;
  }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128 || !/^[-A-Za-z0-9._~]+$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const left = Buffer.from(actual);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeReturn(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function wantsJson(req: Request): boolean {
  return Boolean(req.is("json") || req.get("accept")?.includes("application/json"));
}

function fail(req: Request, res: Response, status: number, message: string) {
  if (wantsJson(req)) return res.status(status).json({ error: message });
  const back = safeReturn(req.body?.returnTo);
  return res.status(status).type("html").send(`<!doctype html><meta charset="utf-8"><title>Patent by Ouroboros</title><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(back)}">Back</a></p>`);
}

function validRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function bearer(req: Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function basicClient(req: Request): { id?: string; secret?: string } {
  const header = req.header("authorization") ?? "";
  if (!header.startsWith("Basic ")) return {};
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const split = decoded.indexOf(":");
  if (split < 0) return {};
  return { id: decoded.slice(0, split), secret: decoded.slice(split + 1) };
}

function resourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    resource_name: "Patent by Ouroboros",
    authorization_servers: [origin],
    scopes_supported: ["patent:read"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/connect`
  };
}

function authorizationMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["patent:read"],
    service_documentation: `${origin}/connect`
  };
}

function billingConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_MONTHLY && env.STRIPE_PRICE_YEARLY);
}

async function stripeForm(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, pathName: string, params: URLSearchParams): Promise<{ id?: string; url?: string }> {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Billing is not configured.");
  const response = await fetchImpl(`https://api.stripe.com/v1/${pathName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Stripe could not start the request.");
  return JSON.parse(text) as { id?: string; url?: string };
}

function stripeEvent(rawBody: Buffer, signatureHeader: string, secret: string): { type: string; data: { object: Record<string, unknown> } } {
  const fields = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = fields.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) throw new Error("Malformed Stripe signature");
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error("Expired Stripe signature");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  const valid = signatures.some((signature) => signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected)));
  if (!valid) throw new Error("Invalid Stripe signature");
  return JSON.parse(rawBody.toString("utf8")) as { type: string; data: { object: Record<string, unknown> } };
}

function setSession(res: Response, userId: string, secret: string, secure: boolean, now: number) {
  const cookie = `patent_session=${encodeURIComponent(signSession(userId, secret, now))}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
  res.setHeader("set-cookie", cookie);
}

function clearSession(res: Response) {
  res.setHeader("set-cookie", "patent_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

export function createApp(options: AppOptions = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowFn = options.now ?? (() => new Date());
  const store = options.store ?? (() => {
    try {
      return createStoreFromEnv(env, fetchImpl);
    } catch (error) {
      if ((env.STORAGE_BACKEND ?? "").toLowerCase() === "blob") throw error;
      return memoryStore();
    }
  })();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Cache-Control": "no-store" });
    next();
  });

  app.get("/logo.jpg", (_req, res) => {
    res.type("image/jpeg").sendFile(path.join(projectRoot(), "logo.jpg"));
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: SERVICE_NAME,
      name: "Patent by Ouroboros",
      version: VERSION,
      billingConfigured: billingConfigured(env),
      stripeWebhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
      usptoConfigured: Boolean(env.USPTO_API_KEY),
      epoConfigured: Boolean(env.EPO_CONSUMER_KEY && env.EPO_CONSUMER_SECRET),
      patentsViewSearch: "paused",
      storageBackend: store.backend,
      authSecretConfigured: Boolean(env.AUTH_SECRET)
    });
  });

  app.post("/billing/webhook", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
    try {
      const signature = req.header("stripe-signature");
      if (!signature || !Buffer.isBuffer(req.body) || !env.STRIPE_WEBHOOK_SECRET) return res.status(400).send("Missing Stripe signature");
      const event = stripeEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);
      const object = event.data.object;
      const metadata = (object.metadata ?? {}) as Record<string, unknown>;
      const userId = typeof metadata.user_id === "string"
        ? metadata.user_id
        : typeof object.client_reference_id === "string"
          ? object.client_reference_id
          : undefined;
      if (userId && (event.type === "checkout.session.completed" || event.type.startsWith("customer.subscription."))) {
        const status = typeof object.status === "string" ? object.status : undefined;
        const periodEnd = typeof object.current_period_end === "number" ? new Date(object.current_period_end * 1000).toISOString() : undefined;
        await store.update((draft) => {
          const user = draft.users.find((item) => item.id === userId);
          if (!user) return;
          if (typeof object.customer === "string") user.stripeCustomerId = object.customer;
          if (event.type === "checkout.session.completed" && typeof object.subscription === "string") user.stripeSubscriptionId = object.subscription;
          if (event.type.startsWith("customer.subscription.")) {
            if (typeof object.id === "string") user.stripeSubscriptionId = object.id;
            if (status) user.subscriptionStatus = status;
            if (periodEnd) user.currentPeriodEnd = periodEnd;
          }
        });
      }
      res.json({ received: true });
    } catch {
      res.status(400).send("Webhook could not be processed");
    }
  });

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const metadataRoutes = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];
  app.get(metadataRoutes, (req, res) => {
    res.set("Access-Control-Allow-Origin", "*").json(resourceMetadata(originOf(req, env)));
  });
  app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration"], (req, res) => {
    res.set("Access-Control-Allow-Origin", "*").json(authorizationMetadata(originOf(req, env)));
  });

  async function currentUser(req: Request): Promise<UserRecord | undefined> {
    const userId = readSession(readCookie(req, "patent_session"), authSecret(env), nowFn().getTime());
    if (!userId) return undefined;
    const state = await store.read();
    return state.users.find((user) => user.id === userId);
  }

  async function userFromBearer(req: Request): Promise<UserRecord | undefined> {
    const token = bearer(req);
    if (!token) return undefined;
    const state = await store.read();
    const record = state.tokens.find((item) => item.accessToken === token && Date.parse(item.accessExpiresAt) > nowFn().getTime());
    if (!record) return undefined;
    return state.users.find((user) => user.id === record.userId);
  }

  app.get("/", async (req, res) => {
    const user = await currentUser(req);
    const checkout = typeof req.query.checkout === "string" ? req.query.checkout : "";
    res.type("html").send(homePage({
      origin: originOf(req, env),
      user,
      now: nowFn(),
      comped: Boolean(user && compedEmails(env).has(user.email.toLowerCase())),
      notice: checkout === "success" ? "Checkout completed. Subscription status updates when Stripe notifies this server." : undefined,
      error: checkout === "cancelled" ? "Checkout was cancelled. No changes were made." : undefined
    }));
  });

  app.get("/connect", (req, res) => {
    res.type("html").send(connectPage(originOf(req, env)));
  });

  app.get("/privacy", (req, res) => {
    res.type("html").send(privacyPage(originOf(req, env)));
  });

  app.get("/terms", (req, res) => {
    res.type("html").send(termsPage(originOf(req, env)));
  });

  app.get("/support", (req, res) => {
    res.type("html").send(supportPage(originOf(req, env)));
  });

  app.post("/register", async (req, res) => {
    if (!allow(`register:${req.ip}`, 30, 60 * 60 * 1000)) return res.status(429).json({ error: "too_many_requests" });
    const parsed = z.object({
      client_name: z.string().trim().max(120).optional(),
      redirect_uris: z.array(z.string().max(500)).min(1).max(10),
      grant_types: z.array(z.string()).max(5).optional(),
      response_types: z.array(z.string()).max(5).optional(),
      token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_client_metadata" });
    const grants = parsed.data.grant_types ?? ["authorization_code", "refresh_token"];
    const responses = parsed.data.response_types ?? ["code"];
    if (grants.some((grant) => !["authorization_code", "refresh_token"].includes(grant)) || responses.some((item) => item !== "code")) {
      return res.status(400).json({ error: "invalid_client_metadata" });
    }
    if (parsed.data.redirect_uris.some((uri) => !validRedirect(uri))) return res.status(400).json({ error: "invalid_redirect_uri" });
    const method = parsed.data.token_endpoint_auth_method ?? "none";
    const clientId = `patent_${randomBytes(16).toString("base64url")}`;
    let clientSecret: string | undefined;
    let secretHash: { hash: string; salt: string } | undefined;
    if (method !== "none") {
      clientSecret = randomBytes(24).toString("base64url");
      secretHash = await hashSecret(clientSecret);
    }
    await store.update((draft) => {
      draft.clients.push({
        clientId,
        clientSecretHash: secretHash?.hash,
        clientSecretSalt: secretHash?.salt,
        redirectUris: parsed.data.redirect_uris,
        clientName: parsed.data.client_name || "MCP client",
        tokenEndpointAuthMethod: method,
        createdAt: nowFn().toISOString()
      });
    });
    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: parsed.data.client_name || "MCP client",
      redirect_uris: parsed.data.redirect_uris,
      grant_types: grants,
      response_types: ["code"],
      token_endpoint_auth_method: method
    });
  });

  app.get("/authorize", async (req, res) => {
    const query = oauthQuery(req);
    if (!query.ok) return res.status(400).type("html").send(authorizePage({ origin: originOf(req, env), clientName: "this application", redirectUri: "", scope: "patent:read", error: query.error, hidden: {} }));
    const state = await store.read();
    const client = state.clients.find((item) => item.clientId === query.value.client_id);
    if (!client || !client.redirectUris.includes(query.value.redirect_uri)) {
      return res.status(400).type("html").send(authorizePage({ origin: originOf(req, env), clientName: "this application", redirectUri: query.value.redirect_uri, scope: query.value.scope, error: "Unknown client or return address.", hidden: query.value }));
    }
    const user = await currentUser(req);
    res.type("html").send(authorizePage({
      origin: originOf(req, env),
      clientName: client.clientName,
      redirectUri: query.value.redirect_uri,
      scope: query.value.scope,
      email: user?.email,
      hidden: query.value
    }));
  });

  app.post("/authorize", async (req, res) => {
    const query = oauthQuery(req);
    if (!query.ok) return res.status(400).json({ error: query.error });
    const user = await currentUser(req);
    const state = await store.read();
    const client = state.clients.find((item) => item.clientId === query.value.client_id);
    if (!client || !client.redirectUris.includes(query.value.redirect_uri)) return res.status(400).json({ error: "invalid_request" });
    const redirect = new URL(query.value.redirect_uri);
    if (query.value.state) redirect.searchParams.set("state", query.value.state);
    if (!user || req.body?.decision !== "approve") {
      redirect.searchParams.set("error", "access_denied");
      return res.redirect(redirect.toString());
    }
    const code = randomBytes(24).toString("base64url");
    await store.update((draft) => {
      draft.codes.push({
        code,
        clientId: client.clientId,
        userId: user.id,
        redirectUri: query.value.redirect_uri,
        codeChallenge: query.value.code_challenge,
        scope: query.value.scope,
        resource: query.value.resource || `${originOf(req, env)}/mcp`,
        expiresAt: new Date(nowFn().getTime() + 5 * 60 * 1000).toISOString()
      });
    });
    redirect.searchParams.set("code", code);
    res.redirect(redirect.toString());
  });

  app.post("/token", async (req, res) => {
    const grant = String(req.body?.grant_type ?? "");
    const basic = basicClient(req);
    const clientId = String(req.body?.client_id ?? basic.id ?? "");
    const clientSecret = String(req.body?.client_secret ?? basic.secret ?? "");
    const state = await store.read();
    const client = state.clients.find((item) => item.clientId === clientId);
    if (!client) return res.status(401).json({ error: "invalid_client" });
    if (client.tokenEndpointAuthMethod !== "none") {
      if (!client.clientSecretHash || !client.clientSecretSalt || !(await verifySecret(clientSecret, client.clientSecretHash, client.clientSecretSalt))) {
        return res.status(401).json({ error: "invalid_client" });
      }
    }
    if (grant === "authorization_code") {
      const code = String(req.body?.code ?? "");
      const verifier = String(req.body?.code_verifier ?? "");
      const redirectUri = String(req.body?.redirect_uri ?? "");
      const preliminary = state.codes.find((item) => item.code === code && item.clientId === client.clientId);
      if (!preliminary || preliminary.redirectUri !== redirectUri || Date.parse(preliminary.expiresAt) <= nowFn().getTime() || !pkceMatches(verifier, preliminary.codeChallenge)) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      let issued: ReturnType<typeof issueToken> | undefined;
      await store.update((draft) => {
        issued = undefined;
        const index = draft.codes.findIndex((item) => item.code === code && item.clientId === client.clientId);
        const record = index >= 0 ? draft.codes[index] : undefined;
        if (!record || record.redirectUri !== redirectUri || Date.parse(record.expiresAt) <= nowFn().getTime() || !pkceMatches(verifier, record.codeChallenge)) return;
        issued = issueToken(client.clientId, record.userId, record.scope, record.resource);
        draft.codes.splice(index, 1);
        draft.tokens.push(issued.record);
      });
      if (!issued) return res.status(400).json({ error: "invalid_grant" });
      return res.json(issued.response);
    }
    if (grant === "refresh_token") {
      const refresh = String(req.body?.refresh_token ?? "");
      const preliminary = state.tokens.find((item) => item.refreshToken === refresh && item.clientId === client.clientId && Date.parse(item.refreshExpiresAt) > nowFn().getTime());
      if (!preliminary) return res.status(400).json({ error: "invalid_grant" });
      let issued: ReturnType<typeof issueToken> | undefined;
      await store.update((draft) => {
        issued = undefined;
        const index = draft.tokens.findIndex((item) => item.refreshToken === refresh && item.clientId === client.clientId && Date.parse(item.refreshExpiresAt) > nowFn().getTime());
        if (index < 0) return;
        const record = draft.tokens[index];
        issued = issueToken(client.clientId, record.userId, record.scope, record.resource);
        draft.tokens.splice(index, 1);
        draft.tokens.push(issued.record);
      });
      if (!issued) return res.status(400).json({ error: "invalid_grant" });
      return res.json(issued.response);
    }
    return res.status(400).json({ error: "unsupported_grant_type" });
  });

  app.post("/revoke", async (req, res) => {
    const token = String(req.body?.token ?? "");
    await store.update((draft) => {
      draft.tokens = draft.tokens.filter((item) => item.accessToken !== token && item.refreshToken !== token);
    });
    res.status(200).json({});
  });

  app.post("/account/register", async (req, res) => {
    if (!allow(`signup:${req.ip}`, 10, 60 * 60 * 1000)) return res.status(429).json({ error: "Too many attempts. Try again later." });
    const parsed = z.object({
      email: z.string().trim().email().max(254),
      password: z.string().min(10).max(200),
      returnTo: z.string().optional()
    }).safeParse(req.body);
    if (!parsed.success) return fail(req, res, 400, "Use a valid email and a password of at least 10 characters.");
    const email = parsed.data.email.toLowerCase();
    if (reviewerLoginEmail(env) && email === reviewerLoginEmail(env)) {
      return fail(req, res, 409, "An account with that email already exists.");
    }
    const existing = (await store.read()).users.find((user) => user.email === email);
    if (existing) return fail(req, res, 409, "An account with that email already exists.");
    const password = await hashSecret(parsed.data.password);
    const userId = `user_${randomBytes(12).toString("base64url")}`;
    const created = nowFn();
    await store.update((draft) => {
      draft.users.push({
        id: userId,
        email,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        createdAt: created.toISOString(),
        trialEndsAt: new Date(created.getTime() + TRIAL_MS).toISOString()
      });
    });
    setSession(res, userId, authSecret(env), originOf(req, env).startsWith("https:"), created.getTime());
    if (req.is("json")) return res.status(201).json({ id: userId });
    res.redirect(safeReturn(parsed.data.returnTo));
  });

  app.post("/account/login", async (req, res) => {
    if (!allow(`login:${req.ip}`, 20, 60 * 60 * 1000)) return res.status(429).json({ error: "Too many attempts. Try again later." });
    const parsed = z.object({
      email: z.string().trim().email().max(254),
      password: z.string().min(1).max(200),
      returnTo: z.string().optional()
    }).safeParse(req.body);
    if (!parsed.success) return fail(req, res, 400, "Email or password is incorrect.");
    const email = parsed.data.email.toLowerCase();
    const reviewerEmail = reviewerLoginEmail(env);
    if (reviewerEmail && email === reviewerEmail) {
      const hashed = parseReviewerPasswordHash(env.REVIEWER_LOGIN_PASSWORD_HASH);
      const match = hashed ? await verifySecret(parsed.data.password, hashed.hash, hashed.salt) : false;
      if (!hashed || !match) return fail(req, res, 401, "Email or password is incorrect.");
      let userId = (await store.read()).users.find((item) => item.email === email)?.id;
      if (!userId) {
        userId = `user_${randomBytes(12).toString("base64url")}`;
        const created = nowFn();
        const id = userId;
        await store.update((draft) => {
          const current = draft.users.find((item) => item.email === email);
          if (current) {
            current.passwordHash = hashed.hash;
            current.passwordSalt = hashed.salt;
            return;
          }
          draft.users.push({
            id,
            email,
            passwordHash: hashed.hash,
            passwordSalt: hashed.salt,
            createdAt: created.toISOString(),
            trialEndsAt: new Date(created.getTime() - 1000).toISOString()
          });
        });
        userId = (await store.read()).users.find((item) => item.email === email)?.id ?? id;
      } else {
        const id = userId;
        await store.update((draft) => {
          const current = draft.users.find((item) => item.id === id);
          if (!current) return;
          current.passwordHash = hashed.hash;
          current.passwordSalt = hashed.salt;
        });
      }
      setSession(res, userId, authSecret(env), originOf(req, env).startsWith("https:"), nowFn().getTime());
      if (req.is("json")) return res.json({ id: userId });
      return res.redirect(safeReturn(parsed.data.returnTo));
    }
    const user = (await store.read()).users.find((item) => item.email === email);
    const dummy = user ?? { passwordHash: "x".repeat(43), passwordSalt: "salt" };
    const match = user ? await verifySecret(parsed.data.password, user.passwordHash, user.passwordSalt) : await verifySecret(parsed.data.password, dummy.passwordHash, dummy.passwordSalt).then(() => false);
    if (!user || !match) return fail(req, res, 401, "Email or password is incorrect.");
    setSession(res, user.id, authSecret(env), originOf(req, env).startsWith("https:"), nowFn().getTime());
    if (req.is("json")) return res.json({ id: user.id });
    res.redirect(safeReturn(parsed.data.returnTo));
  });

  app.post("/account/logout", (_req, res) => {
    clearSession(res);
    res.redirect("/");
  });

  app.post("/billing/checkout", async (req, res) => {
    try {
      const user = (await currentUser(req)) ?? (await userFromBearer(req));
      if (!user) return res.status(401).json({ error: "Sign in before checkout." });
      if (!billingConfigured(env)) return res.status(503).json({ error: "Billing is not configured." });
      const annual = req.body?.plan === "annual" || req.body?.plan === "yearly";
      const price = annual ? env.STRIPE_PRICE_YEARLY ?? "" : env.STRIPE_PRICE_MONTHLY ?? "";
      const origin = originOf(req, env);
      const params = new URLSearchParams();
      params.set("mode", "subscription");
      params.set("automatic_tax[enabled]", "true");
      params.set("line_items[0][price]", price);
      params.set("line_items[0][quantity]", "1");
      params.set("client_reference_id", user.id);
      params.set("metadata[user_id]", user.id);
      params.set("subscription_data[metadata][user_id]", user.id);
      const remaining = Date.parse(user.trialEndsAt) - nowFn().getTime();
      if (remaining > 48 * 60 * 60 * 1000 && user.subscriptionStatus !== "active") {
        params.set("subscription_data[trial_end]", String(Math.floor(Date.parse(user.trialEndsAt) / 1000)));
      }
      params.set("payment_method_collection", "always");
      params.set("success_url", `${origin}/?checkout=success`);
      params.set("cancel_url", `${origin}/?checkout=cancelled`);
      if (user.stripeCustomerId) {
        params.set("customer", user.stripeCustomerId);
        params.set("customer_update[address]", "auto");
      } else params.set("customer_email", user.email);
      const session = await stripeForm(env, fetchImpl, "checkout/sessions", params);
      res.json({ id: session.id, url: session.url });
    } catch {
      res.status(400).json({ error: "Unable to create checkout. Verify sign-in and retry." });
    }
  });

  app.post("/billing/portal", async (req, res) => {
    try {
      const user = (await currentUser(req)) ?? (await userFromBearer(req));
      if (!user?.stripeCustomerId) return res.status(400).json({ error: "No billing profile exists for this account yet." });
      const params = new URLSearchParams({ customer: user.stripeCustomerId, return_url: originOf(req, env) });
      const session = await stripeForm(env, fetchImpl, "billing_portal/sessions", params);
      res.json({ url: session.url });
    } catch {
      res.status(400).json({ error: "Unable to open billing management." });
    }
  });

  function guardMcp(req: Request, res: Response): boolean {
    const origin = req.header("origin");
    if (!originAllowed(origin, originOf(req, env))) {
      res.status(403).json({ error: "Origin is not allowed." });
      return false;
    }
    if (origin) res.set({ ...CORS, "Access-Control-Allow-Origin": origin, Vary: "Origin" });
    return true;
  }

  app.options("/mcp", (req, res) => {
    if (!guardMcp(req, res)) return;
    res.status(204).end();
  });

  app.get("/mcp", (req, res) => {
    if (!guardMcp(req, res)) return;
    res.set("WWW-Authenticate", `Bearer resource_metadata="${originOf(req, env)}/.well-known/oauth-protected-resource/mcp"`);
    res.status(401).json({ error: "Use Streamable HTTP POST with your Patent connection." });
  });

  app.post("/mcp", async (req, res) => {
    if (!guardMcp(req, res)) return;
    if (!allow(`mcp:${req.ip}`, 300, 60 * 1000)) return res.status(429).set("Retry-After", "60").json({ error: "Too many requests. Retry in one minute." });
    const method = typeof req.body?.method === "string" ? req.body.method : "";
    const publicMethods = new Set(["initialize", "notifications/initialized", "tools/list", "ping"]);
    if (!publicMethods.has(method)) {
      const token = bearer(req);
      const state = await store.read();
      const record = state.tokens.find((item) => item.accessToken === token && Date.parse(item.accessExpiresAt) > nowFn().getTime());
      const user = record ? state.users.find((item) => item.id === record.userId) : undefined;
      const resource = `${originOf(req, env)}/mcp`;
      if (!record || !user || (record.resource && record.resource !== resource)) {
        res.set("WWW-Authenticate", `Bearer resource_metadata="${originOf(req, env)}/.well-known/oauth-protected-resource/mcp"`);
        return res.status(401).json({ error: "Sign in to Patent by Ouroboros to use patent tools." });
      }
      if (!compedEmails(env).has(user.email.toLowerCase()) && !accountHasAccess(user, nowFn())) {
        return res.status(403).json({
          error: "An active trial or Pro subscription is required.",
          access_information: `${originOf(req, env)}/#plans`
        });
      }
    }
    try {
      const server = new McpServer({
        name: SERVICE_NAME,
        title: "Patent by Ouroboros",
        version: VERSION,
        description: DISCLAIMER,
        icons: [{ src: `${originOf(req, env)}/logo.jpg`, mimeType: "image/jpeg", sizes: ["1024x1024"], theme: "dark" }]
      }, { instructions: `${DISCLAIMER} Call the tools for public patent records. Do not invent patent numbers.` });
      registerPatentTools(server, new PatentService({
        fetchImpl,
        usptoApiKey: env.USPTO_API_KEY,
        epoConsumerKey: env.EPO_CONSUMER_KEY,
        epoConsumerSecret: env.EPO_CONSUMER_SECRET,
        epoBase: env.EPO_OPS_BASE
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "Unable to process the plugin request." });
    }
  });

  app.use((error: unknown, req: Request, res: Response, _next: express.NextFunction) => {
    const type = typeof error === "object" && error !== null && "type" in error ? (error as { type?: string }).type : undefined;
    const tooLarge = type === "entity.too.large";
    const badBody = typeof type === "string" && type.startsWith("entity.");
    // Log the error class and message only: no headers, query, body, or stack, so tokens and codes stay out of logs.
    const name = error instanceof Error ? (error.constructor?.name && error.constructor.name !== "Error" ? error.constructor.name : error.name) : typeof error;
    const message = error instanceof Error ? error.message.slice(0, 300) : "";
    console.error(JSON.stringify({ event: "route_error", method: req.method, path: req.path, name, message }));
    if (res.headersSent) return;
    if (tooLarge || badBody) {
      res.status(tooLarge ? 413 : 400).json({ error: "Invalid or oversized request." });
      return;
    }
    res.status(500).json({ error: "Something went wrong. Try again in a moment." });
  });

  function issueToken(clientId: string, userId: string, scope: string, resource: string) {
    const now = nowFn().getTime();
    const record = {
      accessToken: randomBytes(32).toString("base64url"),
      refreshToken: randomBytes(32).toString("base64url"),
      clientId,
      userId,
      scope,
      resource,
      accessExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
      refreshExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
    return {
      record,
      response: {
        access_token: record.accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: record.refreshToken,
        scope
      }
    };
  }

  return app;
}

function oauthQuery(req: Request): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const source = req.method === "GET" ? req.query : req.body ?? {};
  const read = (key: string) => {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };
  const value = {
    response_type: read("response_type") || "code",
    client_id: read("client_id"),
    redirect_uri: read("redirect_uri"),
    code_challenge: read("code_challenge"),
    code_challenge_method: read("code_challenge_method") || "S256",
    state: read("state"),
    scope: read("scope") || "patent:read",
    resource: read("resource")
  };
  if (value.response_type !== "code") return { ok: false, error: "Only authorization code is supported." };
  if (!value.client_id || !value.redirect_uri || !value.code_challenge || !value.state) return { ok: false, error: "client_id, redirect_uri, state, and code_challenge are required." };
  if (value.code_challenge_method !== "S256") return { ok: false, error: "PKCE S256 is required." };
  if (!validRedirect(value.redirect_uri)) return { ok: false, error: "Return address must be https, or http on localhost." };
  if (value.resource && !value.resource.endsWith("/mcp")) return { ok: false, error: "Resource must be the Patent MCP endpoint." };
  return { ok: true, value };
}

export const app = createApp();

const port = Number(process.env.PORT ?? 8787);
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Patent by Ouroboros listening on ${port}`);
  });
}
