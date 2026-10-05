import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { fileStore, memoryStore } from "../src/storage.js";

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

describe("OAuth and billing", () => {
  it("rejects a PKCE verifier that does not match", async () => {
    const app = createApp({ env: { AUTH_SECRET: "test-auth-secret" }, store: memoryStore() });
    const server = await listen(app);
    try {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const registered = await fetch(`${server.url}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost/callback"] })
      });
      const client = await registered.json() as { client_id: string; client_secret?: string };
      expect(client.client_secret).toBeUndefined();
      const signup = await fetch(`${server.url}/account/register`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: "agent@example.com", password: "correct-horse" })
      });
      const cookie = signup.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
      const params = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc"
      });
      const approved = await fetch(`${server.url}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ ...Object.fromEntries(params), decision: "approve" }),
        redirect: "manual"
      });
      const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
      const rejected = await fetch(`${server.url}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: "http://localhost/callback", client_id: client.client_id, code_verifier: `${verifier}nope` })
      });
      expect(rejected.status).toBe(400);
      const metadata = await fetch(`${server.url}/.well-known/oauth-authorization-server`);
      const body = await metadata.json() as { registration_endpoint: string; code_challenge_methods_supported: string[] };
      expect(body.registration_endpoint).toContain("/register");
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    } finally {
      await server.close();
    }
  });

  it("reports billing configuration and sends checkout to Stripe without a price amount", async () => {
    let stripeBody = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      stripeBody = String(init?.body ?? "");
      return Response.json({ id: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test" });
    };
    const store = memoryStore();
    const app = createApp({
      store,
      fetchImpl,
      now: () => new Date("2026-10-05T00:00:00Z"),
      env: {
        AUTH_SECRET: "test-auth-secret",
        STRIPE_SECRET_KEY: "sk_test_example",
        STRIPE_PRICE_MONTHLY: "price_monthly_example",
        STRIPE_PRICE_YEARLY: "price_yearly_example",
        STRIPE_WEBHOOK_SECRET: "whsec_test"
      }
    });
    const server = await listen(app);
    try {
      const health = await fetch(`${server.url}/health`);
      expect(await health.json()).toMatchObject({ ok: true, billingConfigured: true, patentsViewSearch: "paused" });
      const signup = await fetch(`${server.url}/account/register`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: "counsel@example.com", password: "correct-horse" })
      });
      const cookie = signup.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
      const checkout = await fetch(`${server.url}/billing/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ plan: "annual" })
      });
      const body = await checkout.json() as { url: string };
      expect(checkout.status).toBe(200);
      expect(body.url).toContain("checkout.stripe.com");
      expect(stripeBody).toContain("price_yearly_example");
      expect(stripeBody).toContain("trial_end");
      expect(stripeBody).not.toMatch(/\$\s?\d/);
      const unconfigured = createApp({ store: memoryStore(), env: { AUTH_SECRET: "test-auth-secret" } });
      const other = await listen(unconfigured);
      try {
        const plain = await fetch(`${other.url}/health`);
        expect(await plain.json()).toMatchObject({ billingConfigured: false });
      } finally {
        await other.close();
      }
    } finally {
      await server.close();
    }
  });

  it("accepts a signed Stripe webhook and persists the subscription", async () => {
    const store = memoryStore();
    await store.update((draft) => {
      draft.users.push({
        id: "user_test",
        email: "counsel@example.com",
        passwordHash: "x",
        passwordSalt: "y",
        createdAt: "2026-10-01T00:00:00Z",
        trialEndsAt: "2026-10-15T00:00:00Z"
      });
    });
    const secret = "whsec_test";
    const app = createApp({ store, env: { AUTH_SECRET: "test-auth-secret", STRIPE_WEBHOOK_SECRET: secret } });
    const server = await listen(app);
    try {
      const payload = JSON.stringify({
        type: "customer.subscription.updated",
        data: { object: { id: "sub_123", customer: "cus_123", status: "active", current_period_end: 1790000000, metadata: { user_id: "user_test" } } }
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
      const response = await fetch(`${server.url}/billing/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` },
        body: payload
      });
      expect(response.status).toBe(200);
      const saved = await store.read();
      expect(saved.users[0].subscriptionStatus).toBe("active");
      expect(saved.users[0].stripeCustomerId).toBe("cus_123");
    } finally {
      await server.close();
    }
  });

  it("round-trips the account document through the file backend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "patent-store-"));
    const store = fileStore(path.join(dir, "store.json"));
    await store.update((draft) => {
      draft.users.push({
        id: "user_file",
        email: "file@example.com",
        passwordHash: "hash",
        passwordSalt: "salt",
        createdAt: "2026-10-05T00:00:00Z",
        trialEndsAt: "2026-10-19T00:00:00Z"
      });
    });
    const text = await readFile(path.join(dir, "store.json"), "utf8");
    expect(text).toContain("file@example.com");
    expect((await store.read()).users).toHaveLength(1);
  });
});
