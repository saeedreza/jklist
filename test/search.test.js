// Measures search against a fixed set of realistic posts and queries in
// search-eval.json. Each query lists posts that must be in the top 10 and posts
// that must not be. The posts' tags were written the way a posting agent writes
// them, by an agent that never saw the queries.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { api, start } from "./helpers.js";

const DAY = 86_400_000;
const { posts, queries } = JSON.parse(fs.readFileSync(new URL("./search-eval.json", import.meta.url), "utf8"));

let board;
before(async () => {
  board = await start();
  const db = board.db();
  const insert = db.prepare(
    "insert into posts (id, owner, kind, title, body, location, remote, images, tags, posted_at, expires_at) values (?, 'eval@example.com', ?, ?, ?, ?, ?, '[]', ?, ?, ?)",
  );
  const now = Date.now();
  for (const p of posts)
    insert.run(p.id, p.kind, p.title, p.body || null, p.location || null, p.remote ? 1 : 0, JSON.stringify(p.tags ?? []), now - p.age_days * DAY - 1000, now + DAY);
  db.close();
});
after(() => board.stop());

test("search quality", async (t) => {
  let found = 0;
  let wanted = 0;
  let intruders = 0;
  const notes = [];
  for (const query of queries) {
    const args = { limit: 10 };
    for (const field of ["q", "location", "kind"]) if (query[field]) args[field] = query[field];
    const { body } = await api(board, "search_posts", args);
    if (body.error) notes.push(`${query.id} failed: ${body.error}`);
    const top = (body.posts ?? []).map((p) => p.id);
    for (const id of query.relevant) {
      wanted++;
      if (top.includes(id)) found++;
      else notes.push(`${query.id} missed ${id} (${query.note})`);
    }
    for (const id of query.irrelevant ?? [])
      if (top.includes(id)) {
        intruders++;
        notes.push(`${query.id} showed ${id} (${query.note})`);
      }
  }
  t.diagnostic(`right posts in the top 10: ${found} of ${wanted}; wrong posts in the top 10: ${intruders}`);
  for (const note of notes) t.diagnostic(note);
  // On 2026-10-19 this found 51 of 51 with 9 wrong posts. The bar is set just under that.
  assert.ok(found / wanted >= 0.96, `found ${found} of ${wanted}`);
  assert.ok(intruders <= 10, `${intruders} wrong posts in the top 10`);
});
