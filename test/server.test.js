// Runs the real server in a temporary folder and talks to it over HTTP.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const root = path.join(import.meta.dirname, "..");

async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error("timed out");
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function start(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jklist-test-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      DB_FILE: `${dir}/jklist.db`,
      UPLOADS_DIR: `${dir}/uploads`,
      BACKUP_DIR: `${dir}/backups`,
      RESEND_API_KEY: "",
      ORIGIN_SECRET: "",
      READ_ONLY: "",
      ADMIN_EMAILS: "admin@example.com",
      ...settings,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const base = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${base}/health`).then((r) => r.ok, () => false));
  return {
    base,
    dir,
    output: () => output,
    db: () => new DatabaseSync(`${dir}/jklist.db`),
    stop() {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let board;
before(async () => (board = await start()));
after(() => board.stop());

async function call(name, args = {}, key, server = board) {
  const res = await fetch(`${server.base}/api/${name}`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}

async function mcp(message, key) {
  const res = await fetch(`${board.base}/mcp`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: JSON.stringify(message),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

// Without RESEND_API_KEY the server prints each code instead of emailing it.
const codesSent = (server, email) =>
  [...server.output().matchAll(/would email (\S+)\]\njklist code: (\d{6})/g)].filter((m) => m[1] === email).map((m) => m[2]);

async function requestCode(email, server = board) {
  const inbox = email.toLowerCase();
  const before = codesSent(server, inbox).length;
  await call("sign_in", { email }, undefined, server);
  return until(() => codesSent(server, inbox)[before]);
}

async function signIn(email, server = board) {
  const code = await requestCode(email, server);
  return (await call("sign_in", { email, code }, undefined, server)).body.key;
}

const post = async (key, fields) => (await call("publish_post", fields, key)).body;

test("pages are plain text for agents and html for browsers", async () => {
  const text = await fetch(`${board.base}/`);
  assert.match(text.headers.get("content-type"), /^text\/plain/);
  assert.match(await text.text(), /^# jklist/);

  const html = await fetch(`${board.base}/`, { headers: { accept: "text/html" } });
  assert.match(html.headers.get("content-type"), /^text\/html/);
  assert.equal(html.headers.get("vary"), "accept");
  assert.match(await html.text(), /<title>jklist<\/title>/);

  for (const page of ["/manifesto", "/rules", "/llms.txt", "/manifesto.md", "/robots.txt", "/sitemap.xml"])
    assert.equal((await fetch(board.base + page)).status, 200, page);
  assert.equal((await fetch(`${board.base}/`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${board.base}/nope`)).status, 404);
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

test("a post needs a title and known categories, and loses invisible characters", async () => {
  const key = await signIn("writer@example.com");
  assert.equal((await call("publish_post", { body: "no title" }, key)).status, 400);
  assert.equal((await call("publish_post", { title: "x".repeat(121) }, key)).status, 400);
  assert.equal((await call("publish_post", { title: "x", categories: ["spaceships"] }, key)).status, 400);

  const made = await post(key, { title: "Oak​ desk‮,\n  barely used", location: " Silver Lake,  Los Angeles " });
  assert.equal(made.title, "Oak desk, barely used");
  assert.equal(made.location, "Silver Lake, Los Angeles");
  assert.deepEqual(made.categories, ["other"]);
});

test("search finds by words, place and category, and never shows contacts", async () => {
  const key = await signIn("seller@example.com");
  await post(key, { title: "Green sofa", body: "Three seats. ".repeat(30), location: "Echo Park, Los Angeles, CA, USA", contact: "seller@example.com", categories: ["stuff"] });
  await post(key, { title: "Ableton lessons", body: "Online, I fix websites in return", categories: ["lessons", "services"] });
  await post(key, { title: "Room for a week", location: "Lisbon, Portugal", categories: ["housing"] });

  const sofa = (await call("search_posts", { q: "green sofa" })).body.posts;
  assert.deepEqual(sofa.map((p) => p.title), ["Green sofa"]);
  assert.ok(!("contact" in sofa[0]));
  assert.ok(sofa[0].snippet.endsWith("…") && sofa[0].snippet.length === 201);

  const inLA = (await call("search_posts", { location: "los angeles" })).body.posts.map((p) => p.title);
  assert.ok(inLA.includes("Green sofa") && inLA.includes("Ableton lessons"), "posts without a location match any place");
  assert.ok(!inLA.includes("Room for a week"));

  const lessons = (await call("search_posts", { category: "lessons" })).body.posts;
  assert.deepEqual(lessons.map((p) => p.title), ["Ableton lessons"]);
  assert.equal((await call("search_posts", { category: "spaceships" })).status, 400);
});

test("pages of results cover every post once, even posts made in the same millisecond", async () => {
  const key = await signIn("pager@example.com");
  const db = board.db();
  const now = Date.now();
  for (const id of ["aaaa0001", "aaaa0002", "aaaa0003", "aaaa0004", "aaaa0005"])
    db.prepare("insert into posts (id, owner, title, categories, images, posted_at, expires_at) values (?, ?, ?, '[\"events\"]', '[]', ?, ?)").run(
      id,
      "pager@example.com",
      `same moment ${id}`,
      now + 60_000,
      now + 3_600_000,
    );
  db.close();

  const seen = [];
  let before;
  do {
    const page = (await call("search_posts", { q: "same moment", limit: 2, before }, key)).body;
    seen.push(...page.posts.map((p) => p.id));
    before = page.next;
  } while (before);
  assert.deepEqual(seen, ["aaaa0005", "aaaa0004", "aaaa0003", "aaaa0002", "aaaa0001"]);
});

test("the contact needs a key", async () => {
  const key = await signIn("poster@example.com");
  const { id } = await post(key, { title: "Drummer wanted", contact: "call 555-0100" });
  const reader = await signIn("reader@example.com");

  const anonymous = await fetch(`${board.base}/posts/${id}`).then((r) => r.json());
  assert.ok(!("contact" in anonymous.post));
  const signedIn = await fetch(`${board.base}/posts/${id}`, { headers: { authorization: `Bearer ${reader}` } }).then((r) => r.json());
  assert.equal(signedIn.post.contact, "call 555-0100");
});

test("three reports hide a post until an admin restores it, and bans remove everything", async () => {
  const owner = await signIn("owner@example.com");
  const admin = await signIn("admin@example.com");
  const { id } = await post(owner, { title: "Suspicious offer" });
  for (const email of ["r1@example.com", "r2@example.com", "r3@example.com"]) await call("report_post", { id }, await signIn(email));

  assert.equal((await fetch(`${board.base}/posts/${id}`)).status, 404);
  assert.equal((await call("my_posts", {}, owner)).body.find((p) => p.id === id).hidden, true);

  const listed = async (key) => (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, key)).body.result.tools.map((t) => t.name);
  assert.ok(!(await listed(owner)).includes("admin"));
  assert.ok((await listed(admin)).includes("admin"));
  assert.equal((await call("admin", { action: "overview" }, owner)).status, 401);
  assert.equal((await call("admin", { action: "toString" }, admin)).status, 400);

  const reported = (await call("admin", { action: "reports" }, admin)).body;
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

test("uploads lose their metadata, and deleting the post deletes them", async () => {
  const key = await signIn("photos@example.com");
  assert.equal((await upload(Buffer.from("not an image"), key)).status, 400);
  assert.equal((await upload(jpegWithMetadata(), "jk_nope")).status, 401);

  const jpg = (await upload(jpegWithMetadata(), key)).body.url;
  const stored = Buffer.from(await fetch(jpg).then((r) => r.arrayBuffer()));
  assert.ok(!stored.includes("SECRET"), "metadata and the appended image are gone");
  assert.ok(stored.includes(Buffer.from("Exif\0\0MM", "latin1")), "orientation is kept");
  assert.equal(stored.indexOf(Buffer.from([0xff, 0xd9])), stored.length - 2, "ends at the first image");
  assert.ok(stored.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])), "image data is untouched");

  const png = (await upload(pngWithMetadata(), key)).body.url;
  assert.ok(!Buffer.from(await fetch(png).then((r) => r.arrayBuffer())).includes("SECRET"));

  const { id } = await post(key, { title: "Lamp", images: [jpg, png] });
  await call("delete_post", { id }, key);
  assert.equal((await fetch(jpg)).status, 404);
  assert.equal((await fetch(png)).status, 404);
});

test("signing out everywhere and deleting the account", async () => {
  const first = await signIn("leaving@example.com");
  await post(first, { title: "Goodbye sale" });
  assert.deepEqual((await call("sign_out_everywhere", {}, first)).body, { signed_out: true });
  assert.equal((await call("my_posts", {}, first)).status, 401);

  const second = await signIn("leaving@example.com");
  await call("delete_account", {}, second);
  assert.equal((await call("search_posts", { q: "goodbye sale" })).body.posts.length, 0);
});

test("mcp handshake, notifications and batches", async () => {
  const hello = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(hello.body.result.serverInfo.name, "jklist");
  assert.match(hello.body.result.instructions, /^# jklist/);
  assert.equal((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  const called = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_posts", arguments: { q: "sofa" } } });
  assert.ok(Array.isArray(JSON.parse(called.body.result.content[0].text).posts));

  const tooMany = Array.from({ length: 21 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }));
  assert.equal((await mcp(tooMany)).status, 400);
});

test("feedback reaches admins, signed in or not", async () => {
  const tools = (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools.map((t) => t.name);
  assert.ok(tools.includes("send_feedback"));

  assert.equal((await call("send_feedback", { kind: "bug", message: "search ignores accents" })).status, 200);
  assert.equal((await call("send_feedback", { kind: "rant", message: "x" })).status, 400);
  assert.equal((await call("send_feedback", { message: "  " })).status, 400);
  const key = await signIn("feedback@example.com");
  await call("send_feedback", { kind: "idea", message: "add a price field" }, key);

  const admin = await signIn("admin@example.com");
  const received = (await call("admin", { action: "feedback" }, admin)).body;
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
