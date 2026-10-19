// Starts a real jklist server in a temporary folder, for tests.

import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

export async function until(check, ms = 5000) {
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

export async function start(settings = {}) {
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
      BACKUP_STAMP: "",
      RELAY_DOMAIN: "",
      RESEND_WEBHOOK_SECRET: "",
      ADMIN_EMAILS: "admin@example.com",
      ...settings,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const base = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${base}/health`).then(() => true, () => false));
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

export async function api(server, name, args = {}, key) {
  const res = await fetch(`${server.base}/api/${name}`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}
