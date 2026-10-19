// The two-way email relay, against a stand-in for Resend's API.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { api, start } from "./helpers.js";

const SECRET = crypto.randomBytes(24);
const sent = []; // emails jklist asked Resend to send
const idempotencyKeys = [];
let failSends = 0; // how many sends Resend should fail next
const inbox = new Map(); // received emails Resend would hand back, by id

let resend;
let board;
before(async () => {
  resend = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/emails") {
        if (failSends > 0) {
          failSends--;
          res.statusCode = 500;
          return res.end("{}");
        }
        idempotencyKeys.push(req.headers["idempotency-key"]);
        sent.push(JSON.parse(body));
        return res.end('{"id":"sent"}');
      }
      const id = /^\/emails\/receiving\/(.+)$/.exec(req.url)?.[1];
      if (req.method === "GET" && inbox.has(id)) return res.end(JSON.stringify(inbox.get(id)));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((resolve) => resend.listen(0, "127.0.0.1", resolve));
  board = await start({
    RELAY_DOMAIN: "reply.test",
    RESEND_API_KEY: "re_test",
    RESEND_API_URL: `http://127.0.0.1:${resend.address().port}`,
    RESEND_WEBHOOK_SECRET: `whsec_${SECRET.toString("base64")}`,
    MAIL_FROM: "jklist <signin@mail.test>",
  });
});
after(() => {
  board.stop();
  resend.close();
});

const lastTo = (email) => sent.findLast((m) => m.to === email);

async function signIn(email) {
  await api(board, "sign_in", { email });
  const code = /jklist code: (\d{6})/.exec(lastTo(email).subject)[1];
  return (await api(board, "sign_in", { email, code })).body.key;
}

// Signs a webhook the way Resend does.
function webhook(emailId) {
  const body = JSON.stringify({ type: "email.received", data: { email_id: emailId } });
  const id = `msg_${crypto.randomBytes(6).toString("hex")}`;
  const time = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", SECRET).update(`${id}.${time}.${body}`).digest("base64");
  return fetch(`${board.base}/inbound`, {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": time, "svix-signature": `v1,${signature}` },
    body,
  });
}

test("a conversation goes through private addresses both ways", async () => {
  const poster = await signIn("poster@example.com");
  const { body: post } = await api(board, "publish_post", { kind: "offer", title: "Brass lamp", location: "Los Angeles" }, poster);
  const asker = await signIn("asker@example.com");
  assert.equal((await api(board, "reply_to_post", { id: post.id, message: "Is it still available?" }, asker)).body.sent, true);

  const toPoster = lastTo("poster@example.com");
  assert.match(toPoster.reply_to, /^a-[0-9a-f]{24}@reply\.test$/);
  assert.match(toPoster.text, /^Is it still available\?/);
  assert.ok(!JSON.stringify(toPoster).includes("asker@example.com"), "the poster never sees the asker's address");

  // The poster answers by email, quoting what they got.
  inbox.set("e1", {
    from: "Poster <poster@example.com>",
    to: [toPoster.reply_to],
    text: "Yes! Come Saturday.\n\nOn Mon, jklist wrote:\n> Is it still available?\n> —— jklist ——",
    html: null,
    headers: {},
  });
  assert.equal((await webhook("e1")).status, 200);
  const toAsker = lastTo("asker@example.com");
  assert.equal(toAsker.text.split("\n\n")[0], "Yes! Come Saturday.", "only the new part is passed on");
  assert.match(toAsker.reply_to, /^p-[0-9a-f]{24}@reply\.test$/);
  assert.ok(!JSON.stringify(toAsker).includes("poster@example.com"), "the asker never sees the poster's address");

  // An Outlook-style answer pastes the history below without ">" marks.
  inbox.set("e4", {
    from: "asker@example.com",
    to: [toAsker.reply_to],
    text: "Saturday works.\n\n—— jklist ——\nThe poster answered you about...",
    headers: {},
  });
  await webhook("e4");
  assert.equal(lastTo("poster@example.com").text.split("\n\n")[0], "Saturday works.");

  // When Resend can't send, the webhook fails, so Resend delivers it again later.
  failSends = 1;
  inbox.set("e5", { from: "asker@example.com", to: [toAsker.reply_to], text: "Still on?", headers: {} });
  assert.equal((await webhook("e5")).status, 503);
  assert.equal((await webhook("e5")).status, 200);
  assert.equal(lastTo("poster@example.com").text.split("\n\n")[0], "Still on?");
  assert.equal(idempotencyKeys.at(-1), "relay-e5", "a send retried after a timeout can't go out twice");

  const count = sent.length;
  await webhook("e1");
  assert.equal(sent.length, count, "a webhook delivered twice is relayed once");

  inbox.set("e2", { from: "stranger@example.com", to: [toPoster.reply_to], text: "hi", headers: {} });
  await webhook("e2");
  assert.equal(sent.length, count, "strangers can't write into a conversation");

  inbox.set("e3", { from: "poster@example.com", to: [toPoster.reply_to], text: "I'm away", headers: { "Auto-Submitted": "auto-replied" } });
  await webhook("e3");
  assert.equal(sent.length, count, "automatic replies aren't relayed");

  const forged = await fetch(`${board.base}/inbound`, {
    method: "POST",
    headers: { "svix-id": "x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,AAAA" },
    body: JSON.stringify({ type: "email.received", data: { email_id: "e1" } }),
  });
  assert.equal(forged.status, 401);

  // Agents can read and answer without email.
  const mine = (await api(board, "my_conversations", {}, asker)).body.conversations;
  assert.deepEqual(
    mine[0].messages.map((m) => [m.from, m.text]),
    [
      ["you", "Is it still available?"],
      ["them", "Yes! Come Saturday."],
      ["you", "Saturday works."],
      ["you", "Still on?"],
    ],
  );
  await api(board, "send_message", { conversation: mine[0].id, message: "See you then" }, asker);
  assert.match(lastTo("poster@example.com").text, /^See you then/);
  assert.equal((await api(board, "send_message", { conversation: mine[0].id, message: "hi" }, await signIn("other@example.com"))).status, 404);

  // Deleting an account takes its conversations with it.
  await api(board, "sign_in", { email: "asker@example.com" });
  const code = /jklist code: (\d{6})/.exec(lastTo("asker@example.com").subject)[1];
  await api(board, "delete_account", { code }, asker);
  assert.deepEqual((await api(board, "my_conversations", {}, poster)).body.conversations, []);
});
