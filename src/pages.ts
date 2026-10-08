import { DISCLAIMER } from "./disclaimer.js";
import type { UserRecord } from "./storage.js";
import { accountHasAccess } from "./storage.js";

const SUPPORT_EMAIL = "ouroborosplugins@gmail.com";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#050605">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/logo.jpg" type="image/jpeg">
  <link rel="apple-touch-icon" href="/logo.jpg">
  <style>
    :root { color-scheme: dark; --bg:#050605; --panel:#101612; --line:#234232; --text:#f3fff6; --muted:#b7cfc0; --green:#3dff8a; --deep:#0d3d22; }
    * { box-sizing: border-box; }
    body { margin:0; background:radial-gradient(circle at 50% -10%, #123222 0, transparent 36%), var(--bg); color:var(--text); font:18px/1.55 Georgia, "Iowan Old Style", Palatino, serif; }
    a { color:var(--green); }
    header, main, footer { width:min(1040px, calc(100% - 32px)); margin:0 auto; }
    header { display:flex; justify-content:space-between; align-items:center; padding:22px 0; }
    .brand { display:flex; gap:12px; align-items:center; color:inherit; text-decoration:none; font-weight:700; letter-spacing:.04em; }
    .brand img { width:42px; height:42px; border-radius:50%; object-fit:cover; }
    nav { display:flex; gap:16px; align-items:center; }
    nav a { color:var(--muted); text-decoration:none; }
    h1, h2, h3 { font-weight:600; letter-spacing:-.03em; line-height:1.1; }
    h1 { font-size:clamp(42px, 7vw, 76px); margin:8px 0 12px; }
    h2 { font-size:clamp(28px, 4vw, 40px); margin:0 0 8px; }
    .hero { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(240px,.7fr); gap:36px; align-items:center; padding:12px 0 28px; }
    .logo-card { background:#000; border:1px solid var(--line); border-radius:28px; padding:18px; }
    .logo-card img { width:100%; height:auto; display:block; }
    .eyebrow { color:var(--green); text-transform:uppercase; letter-spacing:.16em; font:600 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
    .lede, .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .card, .notice, .warn { background:linear-gradient(180deg,#14211a,#0d1410); border:1px solid var(--line); border-radius:18px; padding:18px 18px 16px; }
    .card h3 { margin:0 0 6px; font-size:22px; }
    .card p, li { color:var(--muted); }
    section { margin:42px 0; }
    .actions, form.stack { display:flex; flex-wrap:wrap; gap:10px; }
    button, .button { appearance:none; border:1px solid #2f8a55; background:#143222; color:var(--text); border-radius:999px; padding:12px 16px; font:600 15px/1 ui-sans-serif, system-ui, sans-serif; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; }
    button.primary, .button.primary { background:var(--green); color:#06210f; border-color:transparent; }
    input, select { width:100%; padding:12px; border-radius:12px; border:1px solid var(--line); background:#070b09; color:inherit; font:inherit; }
    label { display:block; margin:12px 0; font:15px/1.4 ui-sans-serif, system-ui, sans-serif; color:var(--muted); }
    pre { overflow:auto; background:#070b09; border-radius:12px; padding:14px; color:#d7ffe6; font:13px/1.45 ui-monospace, monospace; }
    .warn { border-color:#6d5a22; }
    .notice { border-color:#2f8a55; }
    footer { padding:28px 0 48px; color:var(--muted); display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
    ul { padding-left:18px; }
    @media (max-width: 800px) {
      .hero, .grid { grid-template-columns:1fr; }
      nav { gap:10px; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function shell(origin: string, main: string): string {
  return layout("Patent by Ouroboros", `<header>
    <a class="brand" href="/"><img src="/logo.jpg" alt=""> Patent by Ouroboros</a>
    <nav>
      <a href="/connect">Connect</a>
      <a href="/#plans">Trial</a>
      <a href="/privacy">Privacy</a>
      <a href="/support">Support</a>
      <a href="/health">Health</a>
    </nav>
  </header>
  <main>${main}</main>
  <footer>
    <span>Patent by Ouroboros. Public patent records for inventors, founders, and counsel.</span>
    <span><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/support">Support</a></span>
    <span>MCP <a href="${escapeHtml(origin)}/mcp">${escapeHtml(origin)}/mcp</a></span>
  </footer>`);
}

function accountBlock(user: UserRecord | undefined, now: Date, comped = false): string {
  if (!user) {
    return `<div class="grid">
      <form class="card stack" method="post" action="/account/register">
        <h3>Create an account</h3>
        <p>14 days of search access start when the account is created.</p>
        <label>Email <input name="email" type="email" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
        <button class="primary" type="submit">Start the trial</button>
      </form>
      <form class="card stack" method="post" action="/account/login">
        <h3>Sign in</h3>
        <p>Use the same account when an assistant opens the connection screen.</p>
        <label>Email <input name="email" type="email" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button>
      </form>
    </div>`;
  }
  const access = comped || accountHasAccess(user, now);
  const trial = new Date(user.trialEndsAt);
  const status = comped
    ? "Access is open."
    : access
      ? (user.subscriptionStatus === "active"
        ? "Pro is active."
        : `Trial access is open until ${trial.toUTCString()}.`)
      : "The trial has ended. Continue on Pro through Stripe Checkout.";
  return `<div class="card">
    <h3>${escapeHtml(user.email)}</h3>
    <p>${escapeHtml(status)}</p>
    <div class="actions">
      <button class="primary checkout" data-plan="monthly" type="button">Continue monthly</button>
      <button class="checkout" data-plan="annual" type="button">Continue yearly</button>
      ${user.stripeCustomerId ? `<button id="portal" type="button">Manage billing</button>` : ""}
      <form method="post" action="/account/logout"><button type="submit">Sign out</button></form>
    </div>
    <p id="billingMessage" class="muted"></p>
  </div>
  <script>
    async function post(url, body) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      const data = await response.json().catch(function(){ return {}; });
      if (!response.ok) throw new Error(data.error || "Request failed");
      return data;
    }
    document.querySelectorAll(".checkout").forEach(function(button){
      button.addEventListener("click", async function(){
        button.disabled = true;
        try {
          const data = await post("/billing/checkout", { plan: button.getAttribute("data-plan") });
          location.href = data.url;
        } catch (error) {
          document.getElementById("billingMessage").textContent = error.message;
          button.disabled = false;
        }
      });
    });
    var portal = document.getElementById("portal");
    if (portal) portal.addEventListener("click", async function(){
      portal.disabled = true;
      try { location.href = (await post("/billing/portal")).url; }
      catch (error) { document.getElementById("billingMessage").textContent = error.message; portal.disabled = false; }
    });
  </script>`;
}

export function homePage(options: { origin: string; user?: UserRecord; notice?: string; error?: string; now?: Date; comped?: boolean }): string {
  const now = options.now ?? new Date();
  const banner = options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : options.error ? `<p class="warn">${escapeHtml(options.error)}</p>` : "";
  return shell(options.origin, `
    <section class="hero">
      <div>
        <p class="eyebrow">Public patent records</p>
        <h1>Patent by Ouroboros</h1>
        <p class="lede">Search US patents from the USPTO Open Data Portal in ChatGPT, Claude, Gemini, Grok, Cursor, or any Streamable HTTP assistant. Built for inventors, startup founders, patent agents and attorneys, and engineers who need to know whether an idea is already in the public record.</p>
        ${banner}
      </div>
      <div class="logo-card"><img src="/logo.jpg" alt="Green ouroboros around a white lightbulb, with the word Patent"></div>
    </section>
    <section class="warn"><strong>Not legal advice.</strong> ${escapeHtml(DISCLAIMER)}</section>
    <section>
      <p class="eyebrow">What the assistant can ask</p>
      <div class="grid">
        <article class="card"><h3>search_patents</h3><p>Keywords, claim language, CPC class, assignee, inventor, and dates.</p></article>
        <article class="card"><h3>get_patent</h3><p>Abstract, claims, status, family, and citations for one real record.</p></article>
        <article class="card"><h3>find_patent_citations</h3><p>Documents that cite a patent, and documents that patent cites.</p></article>
        <article class="card"><h3>search_prior_art</h3><p>An idea description in, the closest office records and their links out.</p></article>
      </div>
    </section>
    <section id="plans">
      <p class="eyebrow">Access</p>
      <h2>14 days, then Pro.</h2>
      <p class="muted">A new account can search during the trial. After that, Pro continues through Stripe Checkout. The amount is shown by Stripe, not here.</p>
      ${accountBlock(options.user, now, options.comped)}
    </section>
    <section>
      <p class="eyebrow">Offices</p>
      <p class="muted">Results are United States patent records from the USPTO Open Data Portal. Google Patents is used only as a link. The legacy PatentsView search API has been paused since its March 2026 move to the Open Data Portal. Patent numbers are copied from USPTO responses and are never filled in when USPTO does not answer.</p>
    </section>`);
}

export function privacyPage(origin: string): string {
  const email = SUPPORT_EMAIL;
  return shell(origin, `
    <section>
      <h1>Privacy</h1>
      <p>Patent searches public United States patent records. Keyword, claim, class, assignee, inventor, date, and patent-number requests are sent to the USPTO Open Data Portal so that office can answer them. Google Patents is used only as a link on a record USPTO returned. Patent does not keep a database of your queries, and it does not invent a patent number when USPTO does not return one.</p>
      <p>Sign-in uses the email and password you choose. Patent stores that email and a salted hash of the password, not the password itself. A signed browser cookie holds your account id. Connecting an assistant uses OAuth: Patent stores the client registration, a short-lived authorization code, and the access and refresh tokens for that connection. Those records live in the account store on this server. Office API keys and the session-signing secret stay in the server environment.</p>
      <p>A new account can search during a 14-day trial. After that, search continues with a Pro subscription. The operator can also grant an account ongoing access, with no card and no trial end. Stripe receives the account id and either your email or an existing Stripe customer id, and Stripe handles payment details. Patent stores the Stripe customer id, subscription id, status, and current period end. It does not store card numbers.</p>
      <p>Authorization codes expire after 5 minutes. Access tokens stop working after 1 hour. Refresh tokens expire after 30 days, and the browser session cookie lasts 30 days. Expired authorization codes and refresh tokens are removed the next time the account store is saved. Account records are kept until you ask for them to be deleted. Email <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a> to request deletion, a copy, or a correction, and include the account email. Stripe may retain billing records it needs for accounting or disputes. Deletion removes the account from this server's store; provider backups are not an instant erasure guarantee.</p>
      <p>Patent does not sell queries or account records. A connected assistant receives the tool result for the request it made. Privacy questions can go to <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>.</p>
    </section>`);
}

export function termsPage(origin: string): string {
  return shell(origin, `
    <section>
      <h1>Terms</h1>
      <p>Patent by Ouroboros is published by Lawrence Hutchins. It returns United States patent records from the USPTO Open Data Portal. You are responsible for reading the record and for how you use it. A missing field means USPTO did not provide it. ${escapeHtml(DISCLAIMER)}</p>
      <p>A new account can search during a 14-day trial. After the trial, search tools require a Pro subscription, unless the operator has granted that account ongoing access. Stripe Checkout shows the amount before you pay. You can cancel from the billing portal on the home page after a subscription exists.</p>
      <p>The software is provided under the MIT license, without warranty.</p>
    </section>`);
}

export function supportPage(origin: string): string {
  const email = SUPPORT_EMAIL;
  return shell(origin, `
    <section>
      <h1>Support</h1>
      <p>Questions about Patent by Ouroboros, billing, privacy, or connecting an assistant can go to <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>.</p>
      <p>Email that address to request account deletion, a copy of the account record, or a correction. Include the account email. Do not include passwords, OAuth tokens, API keys, or payment card details.</p>
      <p class="muted">A new account gets a 14-day trial, then Pro. Checkout shows the billing terms.</p>
    </section>`);
}

export function connectPage(origin: string): string {
  const mcp = `${origin}/mcp`;
  const cursor = JSON.stringify({ mcpServers: { patent: { url: mcp } } }, null, 2);
  return shell(origin, `
    <section>
      <p class="eyebrow">Connect</p>
      <h1>Add Patent by Ouroboros</h1>
      <p class="lede">The assistant opens OAuth. Leave the client id and secret empty. This server supports dynamic client registration and PKCE. Do not paste a password or an office API key into the assistant.</p>
      <div class="card"><h3>Cursor</h3><p>Project or user <code>mcp.json</code>:</p><pre>${escapeHtml(cursor)}</pre></div>
      <div class="card"><h3>Claude Code</h3><pre>claude mcp add --transport http patent ${escapeHtml(mcp)}</pre></div>
      <div class="card"><h3>ChatGPT, Claude, Gemini, and Grok</h3><p>Add the Streamable HTTP URL, choose OAuth, and leave client id and secret blank.</p><pre>${escapeHtml(mcp)}</pre></div>
      <p class="muted">Sign in with your Patent account when the browser opens. Search tools need an active trial or Pro.</p>
    </section>`);
}

export function authorizePage(options: {
  origin: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  email?: string;
  error?: string;
  hidden: Record<string, string>;
}): string {
  const hidden = Object.entries(options.hidden)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("");
  const returnTo = `/authorize?${new URLSearchParams(options.hidden).toString()}`;
  const authForms = options.email ? "" : `<div class="grid">
    <form class="card" method="post" action="/account/register">
      <h3>Create an account</h3>
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <label>Email <input name="email" type="email" required></label>
      <label>Password <input name="password" type="password" minlength="10" required></label>
      <button class="primary" type="submit">Create and continue</button>
    </form>
    <form class="card" method="post" action="/account/login">
      <h3>Sign in</h3>
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <label>Email <input name="email" type="email" required></label>
      <label>Password <input name="password" type="password" required></label>
      <button type="submit">Sign in</button>
    </form>
  </div>`;
  const consent = options.email ? `<form class="card" method="post" action="/authorize">
      ${hidden}
      <h2>Connect ${escapeHtml(options.clientName)}?</h2>
      <p>Signed in as ${escapeHtml(options.email)}. This application will be able to search public patent records with your trial or Pro access. It cannot change your password.</p>
      <p>Return address: ${escapeHtml(options.redirectUri)}</p>
      <p>Requested scope: ${escapeHtml(options.scope)}</p>
      <div class="actions">
        <button class="primary" name="decision" value="approve" type="submit">Connect</button>
        <button name="decision" value="deny" type="submit">Cancel</button>
      </div>
    </form>` : "";
  return shell(options.origin, `
    <section>
      <p class="eyebrow">Connection</p>
      <h1>Authorize Patent</h1>
      ${options.error ? `<p class="warn">${escapeHtml(options.error)}</p>` : ""}
      ${authForms}
      ${consent}
      <p class="warn">${escapeHtml(DISCLAIMER)}</p>
    </section>`);
}
