// Runs the real server in a temporary folder and talks to it over HTTP.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { api, start, until } from "./helpers.js";

let board;
before(async () => (board = await start({ RELAY_DOMAIN: "reply.test" })));
after(() => board.stop());

const call = (name, args, key, server = board) => api(server, name, args, key);

async function mcp(message, key) {
  const res = await fetch(`${board.base}/mcp`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: JSON.stringify(message),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

// Without RESEND_API_KEY the server prints each email instead of sending it.
const codesSent = (server, email) =>
  [...server.output().matchAll(/would email (\S+?)(?:,[^\]]*)?\]\njklist code: (\d{6})/g)].filter((m) => m[1] === email).map((m) => m[2]);

async function requestCode(email, server = board) {
  const inbox = email.toLowerCase();
  const before = codesSent(server, inbox).length;
  await call("sign_in", { email }, undefined, server);
  return until(() => codesSent(server, inbox)[before]);
}

// Accounts are a month old unless a test asks for a fresh one, since limits grow with age.
async function signIn(email, { fresh = false } = {}) {
  const code = await requestCode(email);
  const { key } = (await call("sign_in", { email, code })).body;
  if (!fresh) age(email, 30);
  return key;
}

function age(email, days) {
  const db = board.db();
  db.prepare("update people set joined = ? where email = ?").run(Date.now() - days * 86_400_000, email.toLowerCase());
  db.close();
}

const post = async (key, fields) => (await call("publish_post", { kind: "offer", location: "Los Angeles, CA, USA", ...fields }, key)).body;
const titles = (result) => result.body.posts.map((p) => p.title);
const htmlHrefs = (page) => [...page.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1].replaceAll("&amp;", "&"));
const htmlLinks = (page) => htmlHrefs(page).map((href) => new URL(href, board.base));
const pageHeader = (page) => page.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];

function assertPlainDocument(page) {
  const header = pageHeader(page);
  assert.ok(header, "each page exposes the shared site header");
  assert.match(header, /<nav\b(?=[^>]*\bclass="[^"]*\bsite-nav\b[^"]*")(?=[^>]*\baria-label="Site")[^>]*>/, "site navigation has an accessible name");
  const brand = header.match(/<a\b(?=[^>]*\bclass="[^"]*\bbrand\b[^"]*")(?=[^>]*\bhref="\/")(?=[^>]*\baria-label="jklist home")[^>]*>([\s\S]*?)<\/a>/)?.[1];
  assert.ok(brand, "the brand links home with a meaningful accessible name");
  assert.match(brand, /jklist/);
  assert.match(brand, /<span\b(?=[^>]*\bclass="[^"]*\bwink\b[^"]*")(?=[^>]*\baria-hidden="true")[^>]*>;\)<\/span>/, "the wink is decorative");
  assert.equal([...page.matchAll(/<main\b/gi)].length, 1, "each page has one main document");
  for (const script of page.matchAll(/<script\b([^>]*)>/gi)) {
    assert.match(script[1], /\btype=["']application\/ld\+json["']/i, "only structured data is allowed in a script element");
    assert.doesNotMatch(script[1], /\bsrc\s*=/i, "pages need no executable JavaScript download");
  }
  assert.doesNotMatch(page, /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*>/i, "pages need no stylesheet download");
  assert.doesNotMatch(page, /<link\b[^>]*\bas=["']font["']/i, "pages do not download fonts");
  assert.doesNotMatch(page, /<(?:form|input|textarea|button|select)\b|\brole=["'](?:tab|tablist)["']/i, "pages hand off to agents without application controls");
  const inlineCss = [...page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join("\n");
  assert.ok(inlineCss.length > 0, "the document includes its own small stylesheet");
  assert.doesNotMatch(inlineCss, /@import|@font-face|url\s*\(/i, "the stylesheet does not load other assets");
  assert.ok(Buffer.byteLength(inlineCss) < 6000, "inline CSS stays below 6,000 bytes");
}

test("pages are plain text for agents and html for browsers", async () => {
  const text = await fetch(`${board.base}/`);
  assert.match(text.headers.get("content-type"), /^text\/plain/);
  const homeText = await text.text();
  assert.match(homeText, /^# jklist\n\nCraigslist for AI agents\./);
  assert.match(homeText, /# jklist for agents/, "agents get the whole guide from the homepage");

  const html = await fetch(`${board.base}/`, { headers: { accept: "text/html" } });
  assert.match(html.headers.get("content-type"), /^text\/html/);
  assert.equal(html.headers.get("vary"), "accept");
  const page = await html.text();
  assert.match(page, /<title>jklist — Craigslist for AI agents<\/title>/);
  const heading = page.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.equal(heading, "Craigslist for AI agents.");
  const linkedPaths = htmlLinks(page).map((link) => link.pathname);
  assert.ok(linkedPaths.includes("/agents"), "agents can discover their instructions from the human page");
  assert.ok(linkedPaths.includes("/connect"), "connection help is directly discoverable");
  assert.ok(linkedPaths.includes("/about"), "the explanation behind jklist is discoverable");
  assert.match(page, new RegExp(`<link rel="canonical" href="${board.base}/">`));
  assert.match(page, /<meta property="og:image" content="[^"]+\/og\.png\?v=[a-f0-9]+">/);
  assert.match(page, /"@type":"WebSite"/);
  assert.match(page, /<!--email_off-->/);
  const rules = await fetch(`${board.base}/rules`, { headers: { accept: "text/html" } }).then((r) => r.text());
  assert.match(rules, /<ol><li>You must be 18 or older\.<\/li>/, "lists are real lists");

  const textVersion = await fetch(`${board.base}/rules.md`);
  assert.equal(textVersion.headers.get("link"), `<${board.base}/rules>; rel="canonical"`);
  const aboutText = await fetch(`${board.base}/about.md`);
  assert.match(aboutText.headers.get("content-type"), /^text\/plain/);
  assert.equal(aboutText.headers.get("link"), `<${board.base}/about>; rel="canonical"`);
  const llms = await fetch(`${board.base}/llms.txt`).then((r) => r.text());
  assert.match(llms, /^# jklist\n\n> Craigslist for AI agents\./);
  assert.match(await fetch(`${board.base}/robots.txt`).then((r) => r.text()), /Disallow: \/api\//);
  const icon = await fetch(`${board.base}/favicon.ico`);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml");
  const iconSource = await icon.text();
  assert.match(iconSource, /<svg\b/);
  assert.match(iconSource, /<text\b[^>]*>;\)<\/text>/, "the favicon uses the same wink as the site brand");
  assert.equal(await fetch(`${board.base}/favicon.svg`).then((r) => r.text()), iconSource, "both favicon URLs return the same SVG");
  assert.equal((await fetch(`${board.base}/og.png`)).headers.get("content-type"), "image/png");

  for (const address of ["/agents", "/agents.md", "/connect", "/connect.md", "/about", "/about.md", "/rules", "/rules.md", "/llms.txt", "/index.md", "/robots.txt", "/sitemap.xml"])
    assert.equal((await fetch(board.base + address)).status, 200, address);
  const sitemap = await fetch(`${board.base}/sitemap.xml`).then((r) => r.text());
  assert.ok(sitemap.includes(`<loc>${board.base}/about</loc>`), "the canonical about page is discoverable in the sitemap");
  assert.ok(!sitemap.includes(`<loc>${board.base}/about.md</loc>`), "the text alias is not a duplicate sitemap entry");
  assert.equal((await fetch(`${board.base}/`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${board.base}/nope`)).status, 404);
});

test("the homepage is a lightweight document with public instructions and examples", async () => {
  const page = await fetch(`${board.base}/`, { headers: { accept: "text/html" } }).then((r) => r.text());
  assert.match(page, /<h2\b[^>]*>FAQ<\/h2>/, "the questions are part of the document");
  assert.match(page, /<blockquote>Sell my couch on jklist\.com\.<\/blockquote>/);
  assert.match(page, /<blockquote>Find me a 1994 Toyota Camry on jklist\.com\.<\/blockquote>/);
  assertPlainDocument(page);
  assert.ok(Buffer.byteLength(page) < 16 * 1024, "the complete homepage stays below 16 KiB");
});

test("public documents share the same standalone, script-free presentation", async () => {
  const home = await fetch(`${board.base}/`, { headers: { accept: "text/html" } }).then((r) => r.text());
  const withoutCurrentPage = (header) => header.replace(/\saria-current="page"/g, "");
  for (const address of ["/agents", "/connect", "/about", "/faq", "/rules", "/posts", "/mcp", "/nope", "/posts/no-such-post"]) {
    const response = await fetch(`${board.base}${address}`, { headers: { accept: "text/html" } });
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(response.headers.get("cache-control"), /\bno-transform\b/, "proxies must preserve the script-free document");
    const page = await response.text();
    assertPlainDocument(page);
    assert.equal(withoutCurrentPage(pageHeader(page)), withoutCurrentPage(pageHeader(home)), "the same navigation is available on every public page");
  }
});

test("the MCP URL shows setup in browsers and protocol guidance to plain clients", async () => {
  const browser = await fetch(`${board.base}/mcp`, { headers: { accept: "text/html" } });
  assert.equal(browser.status, 200);
  assert.equal(browser.headers.get("vary"), "accept");
  assert.match(browser.headers.get("content-type"), /^text\/html/);
  const page = await browser.text();
  assertPlainDocument(page);
  assert.ok(page.includes(`<link rel="canonical" href="${board.base}/connect">`), "the MCP browser view is the setup document");
  const setup = await fetch(`${board.base}/connect`, { headers: { accept: "text/html" } }).then((r) => r.text());
  assert.equal(page, setup, "the browser MCP URL reuses the setup document and its shared presentation");

  for (const accept of ["text/plain", "application/json", "text/event-stream"]) {
    const response = await fetch(`${board.base}/mcp`, { headers: { accept } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(response.headers.get("vary"), "accept");
    assert.match(response.headers.get("content-type"), /^text\/plain/);
    const guidance = await response.text();
    assert.match(guidance, /https?:\/\/[^\s]+\/connect\b/, "plain clients receive setup guidance");
    assert.match(guidance, /\bPOST\b/, "plain clients can discover the supported request method");
    assert.ok(guidance.includes(`${board.base}/mcp`), "the actual MCP endpoint is discoverable");
    assert.ok(guidance.includes(`${board.base}/agents`), "the agent instructions are discoverable");
    assert.doesNotMatch(guidance, /<!doctype|<html/i);
  }
});

test("documentation links stay on the current site without changing URLs shown to agents", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jklist-document-links-"));
  let child;
  try {
    fs.copyFileSync(path.join(root, "server.js"), path.join(dir, "server.mjs"));
    for (const folder of ["data", "site"]) fs.cpSync(path.join(root, folder), path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, "site", "link-fixture.md"), [
      "# Link fixture", "",
      "https://jklist.com/agents?from=fixture&mode=read#start", "",
      "https://www.jklist.com/connect?from=fixture#http", "",
      "https://preview.example.test/faq?from=fixture#questions", "",
      "https://external.example.test/reference?from=fixture&mode=read#part", "",
      "https://jklist.com.evil.example.test/agents", "",
      "https://external.example.test/?next=https://jklist.com/agents", "",
      "[Connection steps](https://jklist.com/connect?from=labeled&mode=read#sign-in)", "",
      "[Jump to sign in](#sign-in)", "",
      "[Rules](/rules#photos)", "",
      "[<img src=x onerror=alert>](https://external.example.test/safe-label)", "",
      "[Unsafe](javascript:alert(1))", "",
      "    curl https://jklist.com/mcp", "",
      "`https://jklist.com/api/sign_in`", "",
      "## Sign in", "", "First destination.", "",
      "### Sign in", "", "A repeated heading.", "",
      "## Sign in", "", "Another repeated heading.", "",
    ].join("\n"));
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs"], {
      cwd: dir,
      env: {
        ...process.env, PORT: String(port), HOST: "127.0.0.1", PUBLIC_URL: "https://preview.example.test",
        DB_FILE: path.join(dir, "jklist.db"), UPLOADS_DIR: path.join(dir, "uploads"), BACKUP_DIR: path.join(dir, "backups"),
        RESEND_API_KEY: "", RESEND_WEBHOOK_SECRET: "", ORIGIN_SECRET: "", SENTRY_DSN: "", INDEXNOW_KEY: "", BACKUP_STAMP: "",
      },
    });
    child.stdout.resume();
    child.stderr.resume();
    let startupError;
    child.on("error", (error) => (startupError = error));
    await until(() => startupError ? Promise.reject(startupError) : fetch(`${base}/health`).then(() => true, () => false));
    const page = await fetch(`${base}/link-fixture`, { headers: { accept: "text/html" } }).then((r) => r.text());
    const hrefs = htmlHrefs(page);
    for (const href of ["/agents?from=fixture&mode=read#start", "/connect?from=fixture#http", "/faq?from=fixture#questions"])
      assert.ok(hrefs.includes(href), "same-site navigation preserves query parameters and fragments on the current host");
    for (const href of ["https://external.example.test/reference?from=fixture&mode=read#part", "https://jklist.com.evil.example.test/agents", "https://external.example.test/?next=https://jklist.com/agents"])
      assert.ok(hrefs.includes(href), "external and merely similar URLs are never rewritten");
    assert.ok(page.includes(">https://jklist.com/agents?from=fixture&amp;mode=read#start</a>"), "the public URL remains visible for copying to an agent");
    assert.ok(page.includes("<code>curl https://jklist.com/mcp</code>"), "command examples keep their absolute endpoint");
    assert.ok(page.includes("<code>https://jklist.com/api/sign_in</code>"), "inline endpoint examples stay absolute");
    assert.ok(hrefs.includes("/connect?from=labeled&mode=read#sign-in"), "labeled Markdown links use the same local navigation rules");
    assert.ok(hrefs.includes("/rules#photos"), "root-relative links remain intact");
    assert.ok(hrefs.includes("#sign-in"), "jump links preserve their fragment");
    const headingIds = [...page.matchAll(/<h[23]\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(headingIds.includes("sign-in"), "jump links have a real heading destination");
    assert.equal(headingIds.length, 3);
    assert.equal(new Set(headingIds).size, headingIds.length, "repeated headings have unique destinations");
    assert.ok(page.includes('&lt;img src=x onerror=alert&gt;</a>'), "link labels stay escaped text");
    assert.doesNotMatch(page, /<img\b|href=["']javascript:/i, "Markdown cannot create executable labels or script links");
    const plain = await fetch(`${base}/link-fixture.md`).then((r) => r.text());
    assert.ok(plain.includes("https://www.jklist.com/connect?from=fixture#http"), "plain documentation is not rewritten");
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("addresses that aren't pages still answer sensibly", async () => {
  const mcpPage = await fetch(`${board.base}/mcp`);
  assert.equal(mcpPage.status, 405);
  assert.equal(mcpPage.headers.get("allow"), "POST");
  const guidance = await mcpPage.text();
  for (const route of ["mcp", "agents", "connect"])
    assert.ok(guidance.includes(`${board.base}/${route}`), "protocol clients receive method and discovery endpoints");
  assert.equal((await fetch(`${board.base}/`, { headers: { accept: "text/event-stream" } })).status, 405, "an MCP stream probe gets 405");
  for (const address of ["/images", "/api", "/api/search_posts", "/inbound"]) assert.equal((await fetch(board.base + address)).status, 405, address);

  const missing = await fetch(`${board.base}/nope`, { headers: { accept: "text/html" } });
  assert.equal(missing.status, 404);
  const missingPage = await missing.text();
  assert.match(missingPage, /<title>Not found · jklist<\/title>/);
  assert.match(missingPage, /<meta name="robots" content="noindex">/);
  assert.match((await fetch(`${board.base}/nope`).then((r) => r.json())).error, /^not-found/);

  assert.match(await fetch(`${board.base}/.well-known/security.txt`).then((r) => r.text()), /^Contact: mailto:hello@jklist\.com/);
  assert.equal(await fetch(`${board.base}/health`).then((r) => r.text()), "ok");
});

test("the sitemap lists canonical live pages without stale modification dates", async (t) => {
  const key = await signIn("sitemap-edit@example.com");
  const { id } = await post(key, { title: "Sitemap edit fixture", remote: true });
  t.after(() => call("delete_post", { id }, key));
  const db = board.db();
  const created = Date.now() - 7 * 86_400_000;
  db.prepare("update posts set posted_at = ? where id = ?").run(created, id);
  db.close();
  const edited = Date.now();
  await call("update_post", { id, body: "Changed after publication" }, key);
  const sitemap = await fetch(`${board.base}/sitemap.xml`).then(r => r.text());
  const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(match => match[1]);
  const urls = entries.map(entry => entry.match(/<loc>([^<]+)<\/loc>/)[1]);
  assert.equal(new Set(urls).size, urls.length, "each canonical URL appears once");
  for (const path of ["/", "/agents", "/connect", "/about", "/faq", "/rules", "/posts"])
    assert.ok(urls.includes(`${board.base}${path}`));
  for (const url of urls) {
    assert.equal(new URL(url).origin, board.base);
    assert.doesNotMatch(new URL(url).pathname, /\.md$|^\/index$/);
  }
  for (const path of ["/posts", `/posts/${id}`]) {
    const entry = entries.find(entry => entry.includes(`<loc>${board.base}${path}</loc>`));
    assert.ok(entry);
    const lastmod = entry.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    if (lastmod) assert.ok(Date.parse(lastmod) >= edited, "creation time cannot stand in for the latest edit");
  }
});

test("signing in trades a code from the inbox for a key", async () => {
  const code = await requestCode("Sign@Example.com");
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");

  const miss = await call("sign_in", { email: "sign@example.com", code: wrong });
  assert.equal(miss.status, 400);
  assert.match(miss.body.error, /^invalid: wrong code, 4 tries left/);

  const hit = await call("sign_in", { email: "sign@example.com", code });
  assert.match(hit.body.key, /^jk_[0-9a-f]{48}$/);
  assert.equal((await call("my_posts", {}, hit.body.key)).status, 200);
  assert.equal((await call("my_posts", {}, "jk_nope")).status, 401);
});

test("input is checked against the schema agents see", async () => {
  const key = await signIn("writer@example.com");
  const refused = async (fields, pattern) => {
    const res = await call("publish_post", fields, key);
    assert.equal(res.status, 400, JSON.stringify(fields));
    assert.match(res.body.error, pattern);
  };
  await refused({ kind: "offer", location: "LA" }, /`title` is required/);
  await refused({ title: "Desk", location: "LA" }, /`kind` is required/);
  await refused({ kind: "sell", title: "Desk", location: "LA" }, /`kind` must be one of need, offer, trade/);
  await refused({ kind: "offer", title: { a: 1 }, location: "LA" }, /`title` must be text/);
  await refused({ kind: "offer", title: "x".repeat(121), location: "LA" }, /`title` is over 120 characters/);
  await refused({ kind: "offer", title: "Desk", location: "LA", categories: ["stuff"] }, /unknown field `categories`/);
  await refused({ kind: "offer", title: "Desk", location: "LA", days: 1.5 }, /`days` must be a whole number/);
  await refused({ kind: "offer", title: "Desk" }, /say where it happens/);
  assert.equal((await call("search_posts", { limit: null })).status, 200, "null means not given");
  assert.equal((await call("send_feedback", { message: "x", kind: null })).status, 200);
  const defaulted = await post(key, { title: "Null days", days: null });
  assert.ok(Date.parse(defaulted.expires_at) > Date.now() + 29 * 86_400_000);
  assert.equal((await call("search_posts", { limit: 1.5 })).status, 400);
  assert.equal((await call("search_posts", { limit: 0 })).status, 400);

  const made = await post(key, { title: "Oak​ desk‮,\n  barely used", location: " Silver Lake,  Los Angeles " });
  assert.equal(made.title, "Oak desk, barely used");
  assert.equal(made.location, "Silver Lake, Los Angeles");
  assert.equal(made.kind, "offer");
  assert.match(made.url, /\/posts\/[0-9a-f]{8}$/);
});

test("search finds synonyms, word forms and metro areas, and shows the other side", async () => {
  const key = await signIn("seller@example.com");
  await post(key, { kind: "offer", title: "Green sofa, barely used", body: "Three seats. ".repeat(30), location: "Santa Monica, CA, USA", contact: "seller@example.com" });
  const buyer = await signIn("buyer@example.com");
  const couch = await post(buyer, { kind: "need", title: "Looking for a couch for my new flat", location: "Echo Park, Los Angeles, CA, USA" });
  await post(key, { kind: "trade", title: "Teach me Ableton, I'll fix your website", remote: true, location: "" });
  await post(key, { kind: "offer", title: "Room for a week", location: "Lisbon, Portugal" });

  const couches = await call("search_posts", { q: "couch", kind: "offer", location: "Los Angeles" });
  assert.deepEqual(titles(couches), ["Green sofa, barely used"], "a sofa in Santa Monica answers someone needing a couch in LA");
  const sofa = couches.body.posts[0];
  assert.ok(!("contact" in sofa));
  assert.ok(sofa.snippet.endsWith("…") && sofa.snippet.length === 201);

  const needs = titles(await call("search_posts", { kind: "need" }));
  assert.ok(needs.includes("Looking for a couch for my new flat") && needs.includes("Teach me Ableton, I'll fix your website"), "trades show for both sides");
  assert.ok(!needs.includes("Green sofa, barely used"));

  const inLA = titles(await call("search_posts", { location: "LA" }));
  assert.ok(inLA.includes("Green sofa, barely used") && inLA.includes("Teach me Ableton, I'll fix your website"), "LA means Los Angeles; remote posts match anywhere");
  assert.ok(!inLA.includes("Room for a week"));
  assert.ok(inLA.indexOf("Green sofa, barely used") < inLA.indexOf("Teach me Ableton, I'll fix your website"), "posts in the place come before newer remote ones");
  assert.ok(!titles(await call("search_posts", { location: "La Jolla" })).includes("Green sofa, barely used"), "La Jolla isn't LA");

  assert.equal(titles(await call("search_posts", { q: "green sofa" }))[0], "Green sofa, barely used", "the closest match comes first");

  const matches = titles(await call("find_matches", { id: couch.id }));
  assert.ok(matches.includes("Green sofa, barely used"), "a need finds the offer that fits");
  assert.ok(!matches.includes("Room for a week") && !matches.includes("Looking for a couch for my new flat"));
  const la = (await call("places", { q: "santa" })).body.areas.find((a) => a.name === "los angeles");
  assert.ok(la?.places.includes("santa monica") && la.live_posts >= 2, "the board knows Santa Monica is in LA");
  const summary = (await call("board_summary", {})).body;
  assert.ok(summary.by_kind.need >= 1 && summary.by_kind.offer >= 1 && summary.top_places.some((p) => p.place === "los angeles"));

  await post(key, { kind: "offer", title: "Hand-woven kilim from Istanbul", tags: ["Rug", "carpet", "textile", "rug"], remote: true });
  assert.deepEqual(titles(await call("search_posts", { q: "textile" })), ["Hand-woven kilim from Istanbul"], "the poster's agent added search terms");
  assert.deepEqual((await call("search_posts", { q: "textile" })).body.posts[0].tags, undefined, "results stay short");
  assert.equal((await call("publish_post", { kind: "offer", title: "x", remote: true, tags: Array(31).fill("a") }, key)).status, 400);
  assert.deepEqual(titles(await call("search_posts", { q: "spaceship" })), []);
  assert.match((await call("search_posts", { q: "spaceship" })).body.note, /Nothing matched/);
  assert.deepEqual(titles(await call("search_posts", { since: new Date(Date.now() + 60_000).toISOString() })), []);
  assert.equal((await call("search_posts", { since: "yesterday" })).status, 400);
});

test("pages of results cover every post once, even posts made in the same millisecond", async () => {
  const db = board.db();
  const moment = Date.now() - 500;
  for (const id of ["aaaa0001", "aaaa0002", "aaaa0003", "aaaa0004", "aaaa0005"])
    db.prepare("insert into posts (id, owner, kind, title, remote, images, posted_at, expires_at) values (?, 'pager@example.com', 'offer', ?, 1, '[]', ?, ?)").run(
      id,
      `same moment ${id}`,
      moment,
      Date.now() + 3_600_000,
    );
  db.close();

  for (const query of [{ since: new Date(moment - 1).toISOString() }, { q: "same moment" }]) {
    const seen = [];
    let cursor;
    do {
      const page = (await call("search_posts", { ...query, limit: 2, cursor })).body;
      seen.push(...page.posts.map((p) => p.id));
      cursor = page.next ?? undefined;
    } while (cursor);
    assert.deepEqual(seen.filter((id) => id.startsWith("aaaa")).sort(), ["aaaa0001", "aaaa0002", "aaaa0003", "aaaa0004", "aaaa0005"], JSON.stringify(query));
    assert.equal(new Set(seen).size, seen.length, "nothing repeats");
  }

  // A post published between pages doesn't push one onto the next page twice.
  const first = (await call("search_posts", { q: "same moment", limit: 2 })).body;
  const key = await signIn("interrupter@example.com");
  await post(key, { title: "same moment newcomer", remote: true });
  const second = (await call("search_posts", { q: "same moment", limit: 2, cursor: first.next })).body;
  assert.ok(!second.posts.some((p) => first.posts.some((q) => q.id === p.id)), "no repeats after a new post");
  assert.equal((await call("search_posts", { cursor: "nonsense" })).status, 400);
});

test("expired posts disappear at once, not at the next cleanup", async () => {
  const key = await signIn("expiring@example.com");
  const { id } = await post(key, { title: "Expiring lamp" });
  const db = board.db();
  db.prepare("update posts set expires_at = ? where id = ?").run(Date.now() - 1, id);
  db.close();
  assert.equal((await fetch(`${board.base}/posts/${id}`)).status, 404);
  assert.deepEqual(titles(await call("search_posts", { q: "expiring lamp" })), []);
  assert.equal((await call("my_posts", {}, key)).body.posts.find((p) => p.id === id).expired, true);
});

test("unavailable share links explain their state without exposing old post content", async () => {
  const key = await signIn("unavailable-pages@example.com");
  const fixtures = [];
  for (const state of ["expired", "hidden", "deleted"]) {
    const fields = {
      title: `Private ${state} fixture listing`,
      body: `Old ${state} fixture description must not leak`,
      contact: `${state}-private-contact@example.com`,
      images: [`https://example.com/${state}-private-image.jpg`],
    };
    const published = await post(key, fields);
    fixtures.push({ ...fields, id: published.id });
    if (state === "deleted") {
      await call("delete_post", { id: published.id }, key);
    } else {
      const db = board.db();
      if (state === "expired") db.prepare("update posts set expires_at = ? where id = ?").run(Date.now() - 1, published.id);
      else db.prepare("update posts set hidden = 1 where id = ?").run(published.id);
      db.close();
    }
  }
  const sitemap = await fetch(`${board.base}/sitemap.xml`).then((r) => r.text());
  for (const fixture of [...fixtures, { id: "missing-fixture-post" }]) {
    const url = `${board.base}/posts/${fixture.id}`;
    const html = await fetch(url, { headers: { accept: "text/html" } });
    assert.equal(html.status, 404);
    const page = await html.text();
    assertPlainDocument(page);
    assert.match(page, /This post is no longer available\./);
    assert.match(page, /<meta name="robots" content="noindex">/);
    assert.match(page, /<a\b[^>]*href="\/posts"[^>]*>/, "a person can discover current posts");
    assert.doesNotMatch(page, /Open for replies|reply_to_post/, "unavailable posts have no reply handoff");
    assert.ok(!page.includes(`/posts/${fixture.id}`), "alternative-search prompts do not target the unavailable post");
    for (const privateValue of [fixture.title, fixture.body, fixture.contact, ...(fixture.images ?? [])].filter(Boolean))
      assert.ok(!page.includes(privateValue), "the old listing is absent from the page and sharing metadata");
    const json = await fetch(url, { headers: { accept: "application/json" } });
    assert.equal(json.status, 404);
    const missing = await json.json();
    assert.match(missing.error, /^not-found:/);
    assert.ok(!("post" in missing));
    assert.ok(!sitemap.includes(`/posts/${fixture.id}</loc>`));
  }
  assert.deepEqual(titles(await call("search_posts", { q: "fixture listing" })), []);
});

test("the contact needs a key, and a post has a page you can share", async () => {
  const key = await signIn("poster@example.com");
  const published = await post(key, {
    kind: "need",
    title: "Drummer wanted",
    body: "Bring sticks.\n\n# Not a heading <b>loud</b>\nDemo: https://example.com/demo.\n\nOther post: https://jklist.com/posts/another-post?ref=shared#details",
    contact: "call 555-0100",
    images: ["https://example.com/drums.jpg"],
  });
  const { id } = published;
  const reader = await signIn("reader@example.com");

  const anonymous = await fetch(`${board.base}/posts/${id}`).then((r) => r.json());
  assert.ok(!("contact" in anonymous.post));
  assert.equal(anonymous.agent_guide, `${board.base}/agents`);
  assert.equal(anonymous.connection_guide, `${board.base}/connect`);
  assert.equal(anonymous.reply_requires_sign_in, true);
  assert.match(anonymous.note, /sign in.*reply/i);
  const signedIn = await fetch(`${board.base}/posts/${id}`, { headers: { authorization: `Bearer ${reader}` } }).then((r) => r.json());
  assert.equal(signedIn.post.contact, "call 555-0100");

  const page = await fetch(`${board.base}/posts/${id}`, { headers: { accept: "text/html" } }).then((r) => r.text());
  assertPlainDocument(page);
  assert.match(page, /<title>Drummer wanted · jklist<\/title>/);
  assert.match(page, /"@type":"Demand"/);
  assert.match(page, new RegExp(`<link rel="canonical" href="${board.base}/posts/${id}">`));
  assert.ok((await fetch(`${board.base}/sitemap.xml`).then((r) => r.text())).includes(`<loc>${board.base}/posts/${id}</loc>`), "live posts are in the sitemap");
  const prompt = [...page.matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/g)].map((match) => match[1]).find((text) => text.includes(published.url));
  assert.ok(prompt?.includes(published.url), "the selectable prompt uses the complete canonical post URL");
  assert.match(prompt, /approv|before (?:you )?send|before sending/i, "opening the post does not authorize sending a reply");
  assert.ok(!prompt.includes(key), "the prompt never shares the owner's key");
  assert.match(page, /<a\b[^>]*href="\/agents"[^>]*>/);
  assert.match(page, /<a\b[^>]*href="\/connect"[^>]*>/);
  assert.match(page, /<dl\b[^>]*>/, "post facts remain a semantic description list");
  const dates = [...page.matchAll(/<time\b[^>]*datetime="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  assert.ok(dates.includes(published.posted_at), "the visible posting date agrees with the API");
  assert.ok(dates.includes(published.expires_at), "the visible closing date agrees with the API");
  assert.ok(
    page.includes('<p># Not a heading &lt;b&gt;loud&lt;/b&gt;<br>Demo: <a href="https://example.com/demo" rel="ugc nofollow">https://example.com/demo</a>.</p>'),
    "what people write stays text, and its links are marked as theirs",
  );
  assert.ok(page.includes('<a href="https://example.com/drums.jpg" rel="ugc nofollow">'), "a photo on another site stays a link");
  assert.ok(htmlHrefs(page).includes("https://jklist.com/posts/another-post?ref=shared#details"), "URLs in user posts are preserved rather than rewritten as documentation navigation");
  assert.ok(!page.includes("<img"), "and is never loaded by the page");
  assert.ok(!page.includes("555-0100"), "the page never shows the contact");
});

test("limits grow with an account's age, and admins aren't limited", async () => {
  const newbie = await signIn("newbie@example.com", { fresh: true });
  await post(newbie, { title: "First thing" });
  await post(newbie, { title: "Second thing" });
  const third = await call("publish_post", { kind: "offer", title: "Third thing", remote: true }, newbie);
  assert.equal(third.status, 429);
  assert.match(third.body.error, /2 live posts is your limit for now; it grows to 5 at .+ Try again at .+ \(in \d+/);
  assert.ok(third.body.retry_after > 0 && Date.parse(third.body.retry_at) > Date.now(), "limits say when they free up");
  const raw = await fetch(`${board.base}/api/publish_post`, {
    method: "POST",
    headers: { authorization: `Bearer ${newbie}` },
    body: JSON.stringify({ kind: "offer", title: "Third thing", remote: true }),
  });
  assert.ok(Number(raw.headers.get("retry-after")) > 0);
  age("newbie@example.com", 2);
  assert.equal((await call("publish_post", { kind: "offer", title: "Third thing", remote: true }, newbie)).status, 200, "a day later the limit is higher");

  const admin = await signIn("admin@example.com");
  age("admin@example.com", 0);
  for (const n of [1, 2, 3]) assert.equal((await call("publish_post", { kind: "offer", title: `Seed post ${n}`, remote: true }, admin)).status, 200);
});

test("publishing the same post twice returns the first one", async () => {
  const key = await signIn("retry@example.com");
  const fields = { title: "Bike for sale", body: "Blue", contact: "private-retry-contact@example.com" };
  const first = await post(key, fields);
  assert.equal(first.receipt.status, "published");
  assert.equal(first.receipt.url, first.url);
  assert.equal(first.receipt.expires_at, first.expires_at);
  assert.match(first.receipt.replies, /email.*agent.s conversations/i);
  assert.ok(first.receipt.share_text.includes(first.url), "the receipt gives the human a complete link to share");
  assert.ok(Array.isArray(first.receipt.next_steps) && first.receipt.next_steps.length > 0);
  assert.ok(!JSON.stringify(first.receipt).includes(key), "the sharing receipt never contains a key");
  assert.ok(!JSON.stringify(first.receipt).includes(fields.contact), "private contact is omitted from the sharing receipt");
  const again = await post(key, fields);
  assert.equal(again.id, first.id);
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.receipt, first.receipt, "a retry returns the same usable publication receipt");
  assert.equal((await call("my_posts", {}, key)).body.posts.length, 1);

  const moved = await call("publish_post", { kind: "offer", title: "Bike for sale", body: "Blue", location: "Pasadena, CA" }, key);
  assert.equal(moved.status, 400, "the same post with other details is a correction");
  assert.match(moved.body.error, new RegExp(`as ${first.id}; to change it, call update_post`));
});

test("retrying a hidden post is blocked without a receipt or a replacement post", async () => {
  const key = await signIn("hidden-retry@example.com");
  const fields = { kind: "offer", title: "Hidden retry fixture", remote: true };
  const { body: published } = await call("publish_post", fields, key);
  const db = board.db();
  db.prepare("update posts set hidden = 1 where id = ?").run(published.id);
  db.close();

  const retry = await call("publish_post", fields, key);
  assert.equal(retry.status, 403);
  assert.match(retry.body.error, /^blocked:/);
  assert.ok(!("receipt" in retry.body), "an unavailable duplicate is not reported as published");
  const viaMcp = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_post", arguments: fields } }, key);
  assert.equal(viaMcp.body.result.isError, true);
  assert.match(viaMcp.body.result.structuredContent.error, /^blocked:/);
  assert.ok(!("receipt" in viaMcp.body.result.structuredContent));

  const own = (await call("my_posts", {}, key)).body.posts;
  assert.equal(own.length, 1, "a retry does not create another post");
  assert.equal(own[0].id, published.id);
  assert.equal(own[0].hidden, true, "retrying does not reverse moderation");
  assert.equal((await fetch(published.url, { headers: { accept: "text/html" } })).status, 404);
  assert.deepEqual(titles(await call("search_posts", { q: fields.title })), []);
});

test("MCP publishing returns the same complete receipt as the HTTP API", async () => {
  const key = await signIn("receipt-mcp@example.com");
  const fields = { kind: "offer", title: "MCP receipt fixture", body: "$125 or trade for a lamp", remote: true };
  const published = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_post", arguments: fields } }, key);
  assert.equal(published.status, 200);
  assert.equal(published.body.result.isError, undefined);
  const result = published.body.result.structuredContent;
  assert.deepEqual(JSON.parse(published.body.result.content[0].text), result);
  assert.equal(result.receipt.status, "published");
  assert.equal(result.receipt.url, `${board.base}/posts/${result.id}`);
  assert.equal(result.receipt.expires_at, result.expires_at);
  assert.equal(result.body, fields.body, "unstructured terms remain the author's own words");
  assert.ok(!("price" in result), "the interface does not invent a typed price");
  const retry = await call("publish_post", fields, key);
  assert.equal(retry.body.duplicate, true);
  assert.deepEqual(retry.body.receipt, result.receipt);
});

test("replies reach the poster by email, from a private address", async () => {
  const owner = await signIn("lamp-owner@example.com");
  const { id } = await post(owner, { title: "Brass lamp" });
  const asker = await signIn("asker@example.com");

  assert.equal((await call("reply_to_post", { id, message: "Is it still available?" }, owner)).status, 400, "not to your own post");
  const sent = await call("reply_to_post", { id, message: "Is it still available?" }, asker);
  assert.equal(sent.body.sent, true);
  assert.match(board.output(), /would email lamp-owner@example\.com, reply-to a-[0-9a-f]{24}@reply\.test\]\nReply to your jklist post: Brass lamp/);
  assert.ok(!board.output().includes("reply-to asker@example.com"), "the poster never gets the asker's address");
  assert.equal((await call("my_posts", {}, owner)).body.posts[0].replies, 1);

  await call("reply_to_post", { id, message: "Hello?" }, asker);
  await call("reply_to_post", { id, message: "Hello??" }, asker);
  assert.equal((await call("reply_to_post", { id, message: "Hello???" }, asker)).status, 429);

  // Replies sent all at once still stop at the limit.
  const { id: other } = await post(owner, { title: "Brass candlestick" });
  const burst = await Promise.all(Array.from({ length: 8 }, (_, n) => call("reply_to_post", { id: other, message: `Offer ${n}` }, asker)));
  assert.equal(burst.filter((r) => r.status === 200).length, 3);
});

test("without a relay domain, replies are off rather than showing anyone's address", async () => {
  const plain = await start();
  const keyFor = async (email) => (await call("sign_in", { email, code: await requestCode(email, plain) }, undefined, plain)).body.key;
  const owner = await keyFor("plain-owner@example.com");
  const { id } = (await call("publish_post", { kind: "offer", title: "Chair", remote: true }, owner, plain)).body;
  const sent = await call("reply_to_post", { id, message: "Still there?" }, await keyFor("plain-asker@example.com"), plain);
  plain.stop();
  assert.equal(sent.status, 503);
  assert.match(sent.body.error, /^error: replies by email aren't set up/);
});

test("a search in a neighborhood shows that neighborhood before the rest of the area", async () => {
  const key = await signIn("rooms@example.com");
  const mission = await post(key, { title: "Room for rent", body: "Sunny, near the park", location: "Mission District, San Francisco, CA" });
  const paloAlto = await post(key, { title: "Room for rent in a shared house", body: "Quiet street", location: "Palo Alto, CA" });
  for (const args of [{ q: "room", location: "the Mission" }, { location: "the Mission" }]) {
    const ids = (await call("search_posts", args)).body.posts.map((p) => p.id);
    assert.ok(ids.includes(paloAlto.id), "the rest of the area still shows");
    assert.ok(ids.indexOf(mission.id) < ids.indexOf(paloAlto.id), `${JSON.stringify(args)}: the Mission first, though Palo Alto is newer`);
  }
});

test("updating, renewing and closing posts", async () => {
  const key = await signIn("editor@example.com");
  const { id } = await post(key, { title: "Old title", days: 2 });
  const updated = (await call("update_post", { id, title: "New title", days: 10 }, key)).body;
  assert.equal(updated.title, "New title");
  assert.ok(Date.parse(updated.expires_at) > Date.now() + 9 * 86_400_000);
  assert.equal((await call("update_post", { id, location: "", remote: false }, key)).status, 400, "it still has to say where");
  assert.equal((await call("update_post", { id, title: "Hijacked" }, await signIn("other@example.com"))).status, 404);

  await call("delete_post", { id, outcome: "found_here" }, key);
  const admin = await signIn("admin@example.com");
  const outcomes = (await call("admin", { action: "overview" }, admin)).body.outcomes;
  assert.ok(outcomes.some((o) => o.outcome === "found_here" && o.kind === "offer"));
});

test("reports hide a post only when established accounts send them", async () => {
  const owner = await signIn("owner@example.com");
  const admin = await signIn("admin@example.com");
  const { id } = await post(owner, { title: "Suspicious offer" });
  const reporters = ["r1@example.com", "r2@example.com", "r3@example.com"];
  const keys = [];
  for (const email of reporters) keys.push(await signIn(email, { fresh: true }));

  for (const key of keys) await call("report_post", { id }, key);
  assert.equal((await fetch(`${board.base}/posts/${id}`)).status, 200, "three brand-new accounts can't hide a post");

  for (const email of reporters) age(email, 2);
  const db = board.db();
  db.prepare("delete from reports where post_id = ?").run(id);
  db.close();
  for (const key of keys) await call("report_post", { id }, key);
  assert.equal((await fetch(`${board.base}/posts/${id}`)).status, 404);
  assert.equal((await call("my_posts", {}, owner)).body.posts.find((p) => p.id === id).hidden, true);

  const listed = async (key) => (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, key)).body.result.tools.map((t) => t.name);
  assert.ok(!(await listed(owner)).includes("admin"));
  assert.ok((await listed(admin)).includes("admin"));
  assert.equal((await call("admin", { action: "overview" }, owner)).status, 401);
  assert.equal((await call("admin", { action: "toString" }, admin)).status, 400);

  const reported = (await call("admin", { action: "reports" }, admin)).body.reports;
  assert.equal(reported.find((r) => r.post?.id === id).reports.length, 3);
  await call("admin", { action: "restore_post", id }, admin);
  assert.equal((await fetch(`${board.base}/posts/${id}`)).status, 200);

  await call("admin", { action: "ban", email: "owner@example.com" }, admin);
  assert.equal((await fetch(`${board.base}/posts/${id}`)).status, 404);
  assert.equal((await call("sign_in", { email: "owner@example.com" })).status, 403);
});

function jpegWithMetadata() {
  const segment = (marker, payload) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
  };
  const tiff = Buffer.alloc(40); // little-endian, one entry: orientation 6, then some "gps" bytes
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(6, 18);
  tiff.write("GPSSECRET", 26, "latin1");
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])),
    segment(0xfe, Buffer.from("COMMENTSECRET")),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, Buffer.from("Exif\0\0TRAILSECRET", "latin1")),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function pngWithMetadata() {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from("Comment\0PNGSECRET")),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const upload = (bytes, key) =>
  fetch(`${board.base}/images`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: bytes }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

test("uploads lose their metadata, belong to their owner, and go when no post uses them", async () => {
  const key = await signIn("photos@example.com");
  assert.equal((await upload(Buffer.from("not an image"), key)).status, 400);
  assert.equal((await upload(Buffer.from("GIF89a....COMMENTSECRET"), key)).status, 400, "gif isn't accepted");
  assert.equal((await upload(jpegWithMetadata(), "jk_nope")).status, 401);

  const jpg = (await upload(jpegWithMetadata(), key)).body.url;
  const stored = Buffer.from(await fetch(jpg).then((r) => r.arrayBuffer()));
  assert.ok(!stored.includes("SECRET"), "metadata and the appended image are gone");
  assert.ok(stored.includes(Buffer.from("Exif\0\0MM", "latin1")), "orientation is kept");
  assert.equal(stored.indexOf(Buffer.from([0xff, 0xd9])), stored.length - 2, "ends at the first image");
  assert.ok(stored.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])), "image data is untouched");

  const png = (await upload(pngWithMetadata(), key)).body.url;
  assert.ok(!Buffer.from(await fetch(png).then((r) => r.arrayBuffer())).includes("SECRET"));

  const stranger = await signIn("stranger@example.com");
  for (const disguised of [jpg, jpg.replace("127.0.0.1", "localhost"), jpg.replace("http://", "https://")]) {
    const stolen = await call("publish_post", { kind: "offer", title: "Not mine", remote: true, images: [disguised] }, stranger);
    assert.match(stolen.body.error, /isn't one of your uploads/, disguised);
  }

  const first = await post(key, { title: 'Lamp " onerror="alert(1) <rare>', images: [jpg, png] });
  const second = await post(key, { title: "Lamp, again", images: [jpg] });
  const page = await fetch(`${board.base}/posts/${first.id}`, { headers: { accept: "text/html" } }).then((r) => r.text());
  assertPlainDocument(page);
  assert.ok(page.includes(`<meta property="og:image" content="${jpg}">`), "the shared page previews the first photo");
  const figures = [...page.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/g)].map((match) => match[1]);
  assert.equal(figures.length, 2, "each uploaded photo is independently accessible");
  for (const [index, image] of [jpg, png].entries()) {
    const figure = figures[index];
    const imagePath = new URL(image).pathname;
    assert.ok(htmlLinks(figure).some((link) => link.pathname === imagePath), "the original photo has a direct link");
    const imageTag = figure.match(/<img\b[^>]*>/)?.[0];
    assert.ok(imageTag, "uploaded photos appear in ordinary image elements");
    assert.ok(imageTag.includes(`src="${imagePath}"`) || imageTag.includes(`src="${image}"`), "the image uses the real uploaded photo URL");
    assert.match(imageTag, /\bloading="lazy"/);
    assert.match(imageTag, /\bdecoding="async"/);
    assert.match(imageTag, /\balt="[^"]*Lamp &quot; onerror=&quot;alert\(1\) &lt;rare&gt;[^"]*"/, "photo alternative text escapes the author's title");
    assert.doesNotMatch(imageTag, /\son(?:error|load)=["']/i, "the title cannot create executable image attributes");
    const caption = figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/)?.[1].replace(/<[^>]*>/g, "").trim();
    assert.ok(caption, "a photo has a readable caption");
  }

  await call("update_post", { id: first.id, images: [jpg] }, key);
  assert.equal((await fetch(png)).status, 404, "a photo taken off a post is deleted");
  await call("delete_post", { id: first.id }, key);
  assert.equal((await fetch(jpg)).status, 200, "still used by the other post");
  await call("delete_post", { id: second.id }, key);
  assert.equal((await fetch(jpg)).status, 404);

  // A row whose file is gone, as after restoring an older backup, doesn't take the server down.
  const lost = (await upload(pngWithMetadata(), key)).body.url;
  fs.rmSync(`${board.dir}/uploads/${lost.split("/").pop()}`);
  await fetch(lost).then((r) => r.arrayBuffer()).catch(() => {});
  assert.equal(await fetch(`${board.base}/health`).then((r) => r.text()), "ok");
});

test("deleted text doesn't linger in the search index", async () => {
  const key = await signIn("forgetful@example.com");
  const { id } = await post(key, { title: "Zyxwvutsrq lamp", body: "call 555-0199" });
  await call("delete_post", { id }, key);
  const db = board.db();
  const left = db.prepare("select count(*) n from posts_fts_data where instr(block, cast('zyxwvutsrq' as blob)) > 0").get().n;
  db.close();
  assert.equal(left, 0);
});

test("signing out one key, signing out everywhere, and deleting the account", async () => {
  const laptop = await signIn("leaving@example.com");
  const phone = await signIn("leaving@example.com");
  await call("sign_out", {}, laptop);
  assert.equal((await call("my_posts", {}, laptop)).status, 401);
  assert.equal((await call("my_posts", {}, phone)).status, 200);

  await post(phone, { title: "Goodbye sale" });
  assert.equal((await call("delete_account", {}, phone)).status, 400, "deleting needs a code from the inbox");
  const code = await requestCode("leaving@example.com");
  assert.deepEqual((await call("delete_account", { code }, phone)).body, { deleted: true });
  assert.equal((await call("my_posts", {}, phone)).status, 401);
  assert.ok(!titles(await call("search_posts", { q: "goodbye sale" })).includes("Goodbye sale"));

  const again = await signIn("leaving2@example.com");
  assert.deepEqual((await call("sign_out_everywhere", {}, again)).body, { signed_out: true });
  assert.equal((await call("my_posts", {}, again)).status, 401);
});

test("mcp handshake, versions, structured results and tool hints", async () => {
  const hello = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(hello.body.result.protocolVersion, "2025-06-18");
  assert.equal(hello.body.result.serverInfo.name, "jklist");
  assert.match(hello.body.result.instructions, /^# jklist/);
  const future = await mcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(future.body.result.protocolVersion, "2025-11-25", "an unknown version gets our newest, not an echo");
  assert.equal((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  const tools = (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" })).body.result.tools;
  const hint = (name) => tools.find((t) => t.name === name).annotations;
  assert.equal(hint("search_posts").readOnlyHint, true);
  assert.equal(hint("delete_account").destructiveHint, true);

  const called = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_posts", arguments: { q: "sofa" } } });
  assert.ok(Array.isArray(called.body.result.structuredContent.posts));
  assert.deepEqual(JSON.parse(called.body.result.content[0].text), called.body.result.structuredContent);
  const bad = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_posts", arguments: { limit: "lots" } } });
  assert.equal(bad.body.result.isError, true);

  const tooMany = Array.from({ length: 21 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }));
  assert.equal((await mcp(tooMany)).status, 400);
});

test("feedback reaches admins, signed in or not", async () => {
  assert.equal((await call("send_feedback", { kind: "bug", message: "search ignores accents" })).status, 200);
  assert.equal((await call("send_feedback", { kind: "rant", message: "x" })).status, 400);
  assert.equal((await call("send_feedback", { message: "  " })).status, 400);
  const key = await signIn("feedback@example.com");
  await call("send_feedback", { kind: "idea", message: "add a price field" }, key);

  const admin = await signIn("admin@example.com");
  const received = (await call("admin", { action: "feedback" }, admin)).body.feedback;
  assert.ok(received.some((f) => f.message === "add a price field" && f.email === "feedback@example.com"));
  assert.ok(received.some((f) => f.message === "search ignores accents" && f.email === null));
  assert.equal((await call("admin", { action: "feedback" }, key)).status, 401);
});

test("broken request bodies get a clear answer, not a crash", async () => {
  for (const body of ["null", "[]", "42", '"text"', "{not json"])
    assert.equal((await fetch(`${board.base}/api/search_posts`, { method: "POST", body })).status, 400, body);
  assert.equal((await fetch(`${board.base}/mcp`, { method: "POST", body: "[null]" })).status, 400);
  assert.ok(!board.output().includes("TypeError"), "nothing crashed");
});

test("abuse limits", async () => {
  const started = Date.now();
  assert.equal((await call("sign_in", { email: `a@${".".repeat(90_000)}` })).status, 400);
  assert.ok(Date.now() - started < 1000, "a huge email is refused quickly");

  const db = board.db();
  const insert = db.prepare("insert into activity values (?, ?, null, ?)");
  for (let i = 0; i < 10; i++) insert.run("spammed@example.com", "code", Date.now() - i);
  for (let i = 0; i < 10; i++) insert.run("guessed@example.com", "wrong", Date.now() - i);
  db.close();

  assert.equal((await call("sign_in", { email: "spammed@example.com" })).status, 429);
  const code = await requestCode("guessed@example.com");
  assert.equal((await call("sign_in", { email: "guessed@example.com", code })).status, 429, "even the right code waits a day");

  const big = await fetch(`${board.base}/api/search_posts`, { method: "POST", body: "x".repeat(200_000) });
  assert.equal(big.status, 413);
});

test("the origin lock and read-only mode", async () => {
  const locked = await start({ ORIGIN_SECRET: "s3cret", READ_ONLY: "1" });
  try {
    assert.equal((await fetch(`${locked.base}/`)).status, 403);
    assert.equal((await fetch(`${locked.base}/`, { headers: { "x-origin-secret": "wrong" } })).status, 403);
    assert.equal((await fetch(`${locked.base}/health`)).status, 200);

    const through = { "x-origin-secret": "s3cret" };
    assert.equal((await fetch(`${locked.base}/`, { headers: through })).status, 200);
    const posting = await fetch(`${locked.base}/api/sign_in`, { method: "POST", headers: through, body: '{"email":"a@example.com"}' });
    assert.equal(posting.status, 503);
    assert.match((await posting.json()).error, /read-only/);
    assert.equal((await fetch(`${locked.base}/posts`, { headers: through })).status, 200);
  } finally {
    locked.stop();
  }
});

test("www goes to the bare domain, and IndexNow can check its key", async () => {
  const server = await start({ INDEXNOW_KEY: "0123456789abcdef0123456789abcdef" });
  try {
    const { host } = new URL(server.base);
    const redirect = await new Promise((resolve, reject) =>
      http.get(`${server.base}/rules?x=1`, { headers: { host: `www.${host}` } }, resolve).on("error", reject),
    );
    assert.equal(redirect.statusCode, 301);
    assert.equal(redirect.headers.location, `${server.base}/rules?x=1`);
    assert.equal(await fetch(`${server.base}/0123456789abcdef0123456789abcdef.txt`).then((r) => r.text()), "0123456789abcdef0123456789abcdef");
  } finally {
    server.stop();
  }
});

test("health fails when the off-site backup is late", async () => {
  const stamp = path.join(os.tmpdir(), `jklist-stamp-${process.pid}`);
  const watched = await start({ BACKUP_STAMP: stamp });
  try {
    const late = await fetch(`${watched.base}/health`);
    assert.equal(late.status, 503);
    assert.equal(await late.text(), "off-site backup is late");
    fs.writeFileSync(stamp, "");
    assert.equal((await fetch(`${watched.base}/health`)).status, 200);
  } finally {
    watched.stop();
    fs.rmSync(stamp, { force: true });
  }
});

test("on a public address, sign-in waits for email to be set up", async () => {
  const live = await start({ PUBLIC_URL: "https://jklist.test" });
  try {
    const res = await call("sign_in", { email: "early@example.com" }, undefined, live);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /aren't set up yet/);
    assert.ok(!live.output().includes("jklist code"), "no code is made or printed");
  } finally {
    live.stop();
  }
});

test("the request log leaves out searches", async () => {
  const logged = await start({ LOG_REQUESTS: "1" });
  await fetch(`${logged.base}/posts?q=very+private+words`, { headers: { "user-agent": "Gemini-Test/1.0" } });
  await until(() => logged.output().includes("GET /posts 200"));
  const output = logged.output();
  logged.stop();
  assert.match(output, /GET \/posts 200 accept=\S+ ua=Gemini-Test\/1\.0/);
  assert.ok(!output.includes("private"), "no query strings, so no searches");
});

test("fetchers that don't say what they want get HTML, and command-line tools get text", async () => {
  const type = async (headers) => (await fetch(`${board.base}/`, { headers })).headers.get("content-type");
  assert.match(await type({ "user-agent": "Google", accept: "*/*" }), /^text\/html/, "Gemini's fetcher fails on plain text");
  assert.match(await type({ "user-agent": "curl/8.7.1", accept: "*/*" }), /^text\/plain/);
  assert.match(await type({ accept: "text/markdown, text/html;q=0.9" }), /^text\/plain/, "markdown first means markdown");
  assert.match(await type({ accept: "text/html,application/xhtml+xml,*/*;q=0.8" }), /^text\/html/);
});

test("posts are a page of links, for agents that can only open links they've seen", async () => {
  const key = await signIn("lister@example.com");
  const { id } = await post(key, { title: "Aluminum ladder", body: "Six feet", location: "Silver Lake, Los Angeles, CA" });
  const page = await fetch(`${board.base}/posts`, { headers: { accept: "text/html" } }).then((r) => r.text());
  assertPlainDocument(page);
  assert.ok(page.includes(`href="/posts/${id}"`), "each listing has a crawlable link");
  assert.match(page, /Aluminum ladder/);
  assert.match(page, /Silver Lake, Los Angeles, CA/);
  assert.match(page, /<a\b[^>]*href="\/posts\?cursor=[^"]+"[^>]*>/);
  assert.match(page, new RegExp(`<link rel="canonical" href="${board.base}/posts">`));
  assert.ok((await fetch(`${board.base}/sitemap.xml`).then((r) => r.text())).includes(`<loc>${board.base}/posts</loc>`), "the list is in the sitemap");

  const search = await fetch(`${board.base}/posts?q=ladder&kind=offer&location=Los+Angeles`, { headers: { accept: "text/html" } }).then((r) => r.text());
  assertPlainDocument(search);
  const searchContent = search.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
  assert.match(searchContent, /ladder/i, "the document identifies its active query");
  assert.match(searchContent, /Los Angeles/i, "the document identifies its active location");
  assert.match(searchContent, /offer/i, "the document identifies its active side of the board");
  assert.ok(htmlLinks(searchContent).some((link) => link.pathname === "/posts" && link.search === ""), "a plain link clears the search");
  assert.match(search, /<meta name="robots" content="noindex">/);
  assert.ok((await fetch(`${board.base}/posts?q=ladder`).then((r) => r.json())).posts.some((p) => p.id === id), "scripts still get JSON");
  assert.match(await fetch(`${board.base}/agents.md`).then((r) => r.text()), /start at\s+https:\/\/jklist\.com\/posts\./);
});
