import { describe, expect, it } from "vitest";
import { mapUsptoSearch, numbersInRecords } from "../src/patents.js";

describe("live public patent APIs", () => {
  it("reaches the USPTO Open Data Portal", async () => {
    const key = process.env.USPTO_API_KEY;
    const response = await fetch("https://api.uspto.gov/api/v1/patent/applications/search?q=applicationMetaData.patentNumber:12000000&limit=1", {
      headers: { accept: "application/json", ...(key ? { "x-api-key": key } : {}) }
    });
    if (!key) {
      expect(response.status).toBe(401);
      return;
    }
    expect(response.ok).toBe(true);
    const body = await response.json();
    const raw = JSON.stringify(body);
    for (const number of numbersInRecords(mapUsptoSearch(body))) {
      expect(raw).toContain(number);
    }
  });

  it("reaches EPO Open Patent Services", async () => {
    const key = process.env.EPO_CONSUMER_KEY;
    const secret = process.env.EPO_CONSUMER_SECRET;
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (key && secret) headers.authorization = `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
    const response = await fetch("https://ops.epo.org/3.2/auth/accesstoken", {
      method: "POST",
      headers,
      body: "grant_type=client_credentials"
    });
    if (!key || !secret) {
      expect([400, 401, 403]).toContain(response.status);
      return;
    }
    expect(response.ok).toBe(true);
    const body = await response.json() as { access_token?: string };
    expect(body.access_token).toBeTruthy();
  });
});
