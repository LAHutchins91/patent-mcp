# Patent by Ouroboros

Patent by Ouroboros is a remote MCP server for inventors, startup founders, patent agents and attorneys, and engineers who need to check whether an idea already appears in the public patent record.

It searches United States patent records on the USPTO Open Data Portal. Google Patents is used only as a link. Every patent number in a tool result is copied from a USPTO response. The server does not fill in numbers when USPTO does not answer.

**This is not legal advice.** It is not a substitute for a registered patent attorney or agent. A result is not an opinion on patentability, infringement, validity, or freedom to operate.

## Hosted server

- MCP server URL: `https://patent-mcp.vercel.app/mcp` (Streamable HTTP, OAuth sign-in)
- Docs: https://ouroborosapps.com/docs/patent
- Status: early access. Paste the URL into Claude, Cursor, Grok, or ChatGPT developer mode.
- Coverage on the hosted server: United States patents from the USPTO Open Data Portal.
- Registry name: `io.github.LAHutchins91/patent`

## Connect

The MCP address is your deployment origin plus `/mcp`. Locally that is `http://127.0.0.1:8787/mcp`.

Sign in when the assistant opens OAuth. Leave the client id and secret empty. The server supports OAuth 2.1 dynamic client registration and PKCE (S256). Do not paste a password or an office API key into the assistant.

Cursor, in `~/.cursor/mcp.json` or a project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "patent": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http patent http://127.0.0.1:8787/mcp
```

ChatGPT, Claude, Gemini, Grok, and any other Streamable HTTP client: add the same URL, choose OAuth, and leave client id and secret blank. Full steps are on `/connect`.

A new account includes 14 days of search access. After the trial, Pro continues through Stripe Checkout. The amount is shown by Stripe, not in this repository.

`server.json` is the MCP Registry manifest (`io.github.LAHutchins91/patent`). Its icon is `https://patent-mcp.vercel.app/logo.jpg`. Before you publish the registry entry, set `remotes[0].url` and `websiteUrl` to the public origin. The file currently uses `https://patent-mcp.vercel.app/mcp` as the intended Vercel path.

## Tools

- `search_patents` — keywords, claim language, CPC class, assignee, inventor, and dates
- `get_patent` — abstract, claims, status, family, and citations for one record
- `find_patent_citations` — documents that cite a patent, and documents that patent cites
- `search_prior_art` — an idea description in, the closest USPTO records and their Google Patents links out

Citation coverage is the USPTO grant document and USPTO office-action citations. The PatentsView citation graph is paused: USPTO paused the PatentsView PatentSearch API when PatentsView moved to the Open Data Portal on 20 March 2026.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

The server listens on port 8787. `GET /health` returns JSON. `billingConfigured` is true only when `STRIPE_SECRET_KEY`, `STRIPE_PRICE_MONTHLY`, and `STRIPE_PRICE_YEARLY` are all set.

```bash
npm test
npm run typecheck
```

Tests call the public USPTO host. Office payloads that require a key are mocked. With `USPTO_API_KEY` in the environment, the live test uses that key instead of expecting the unauthenticated response.

## Environment

Lawrence needs to supply:

| Variable | Purpose |
| --- | --- |
| `APP_BASE_URL` | Public origin used as the OAuth issuer and Stripe return URL |
| `AUTH_SECRET` | Signs browser sessions. Required in production |
| `USPTO_API_KEY` | USPTO Open Data Portal key, sent as `X-API-KEY`. This is the key the hosted server uses. |
| `EPO_CONSUMER_KEY` | Leave unset on the hosted server. The unused client reads it only when a secret is set too. |
| `EPO_CONSUMER_SECRET` | Leave unset on the hosted server. Search stays on United States patents from USPTO. |
| `STRIPE_SECRET_KEY` | Existing Stripe secret |
| `STRIPE_PRICE_MONTHLY` | Existing monthly price id |
| `STRIPE_PRICE_YEARLY` | Existing yearly price id |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature secret |
| `STORAGE_BACKEND` | `memory` (default), `file`, `http`, or `blob` |
| `STORAGE_PATH` | JSON file used when the backend is `file` |
| `STORAGE_URL` | GET/PUT URL for one JSON document when the backend is `http` |
| `STORAGE_TOKEN` | Optional bearer token for that URL |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read-write token. Vercel injects this for a linked store. Required when `STORAGE_BACKEND=blob` |
| `STORAGE_BLOB_PATH` | Blob pathname for the account document. Default `patent/accounts.json` |

Do not create Stripe products or prices in this app. Do not commit secrets.

### USPTO key

1. Create a USPTO.gov account.
2. Verify and link ID.me. That link is one time.
3. Open [Open Data Portal getting started](https://data.uspto.gov/apis/getting-started) and request an API key.
4. Set `USPTO_API_KEY`.

Old PatentsView API keys do not work on the Open Data Portal.

## Accounts and storage

Patent tools are stateless searches of United States patents on the USPTO Open Data Portal. Trial and subscription state, OAuth clients, and tokens live in one JSON document behind `AccountStore`.

- `memory` keeps that document in the process. It is the default and is what local tests use. It does not survive a restart or a second serverless instance.
- `file` writes `STORAGE_PATH` (default `./data/patent-store.json`). Use it for Docker or a long-running Node process.
- `http` GETs and PUTs the same document at `STORAGE_URL`. Point it at storage you already run. This server does not create a database.
- `blob` stores the same document in Vercel Blob at `STORAGE_BLOB_PATH` (default `patent/accounts.json`). Set `STORAGE_BACKEND=blob` on Vercel. The Blob client uses `BLOB_READ_WRITE_TOKEN`, which Vercel injects when a Blob store is connected. Reads bypass the CDN cache. Writes send `ifMatch` and retry when another instance updated the document first.

OAuth clients, authorization codes, access tokens, and refresh tokens are fields in that document. The consent screen posts the authorization request with the approval; nothing about the grant is kept in process memory. Expired codes and refresh tokens are removed on each write.

## Deploy

Vercel: the Express app is the default export of `api/index.ts`. `vercel.json` sends every path to that function and bundles `logo.jpg` into it, so `/logo.jpg` is served by the app and repository files such as `/package.json` are not static assets. Set the environment variables above, including `STORAGE_BACKEND=blob`. Point the Stripe webhook at `https://<your-host>/billing/webhook`.

Docker:

```bash
docker build -t patent-mcp .
docker run --env-file .env -p 8787:8787 patent-mcp
```

## What was verified

Locally, over Streamable HTTP: `tools/list` and each of the four tools, OAuth registration with PKCE, trial expiry, Stripe checkout request shape, and webhook signature verification. The USPTO host answered without a key (unauthorized). No live Stripe charge was made, and the server was not deployed to Vercel from this workspace.

---

More from Ouroboros: https://ouroborosapps.com
