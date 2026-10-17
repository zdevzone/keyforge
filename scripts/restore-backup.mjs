import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  copyFile,
  access,
  mkdtemp,
  rm,
  mkdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import SQLite from "better-sqlite3";

import { Vault } from "../dist/src/platform-store.js";
import { parsePostgresSnapshot, restorePostgresSnapshot } from "../dist/src/postgres-archive.js";
import { postgresCliConnection } from "../dist/src/postgres-cli.js";
import { loadKeyRing } from "../dist/src/secrets.js";
import { requireOffline } from "./maintenance-common.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf("--" + name);
  return i < 0 ? undefined : args[i + 1];
};
const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function restore() {
  if (!args.includes("--maintenance") || !flag("file") || !flag("job"))
    throw new Error(
      "Stop every server instance, then use vp run backup:restore --file <archive> --job <UUID> --maintenance --sqlite <file> [--replace], or --database <Postgres URL>. Production restore requires an explicit target.",
    );
  await requireOffline(args.includes("--maintenance"));
  const job = flag("job");
  if (!/^[0-9a-f-]{36}$/i.test(job)) throw new Error("Invalid backup job id.");
  const bytes = await readFile(flag("file"));
  const archive = JSON.parse(
    new Vault(loadKeyRing("LICENSE_BACKUP_KEYRING")).decrypt(bytes.toString(), "backup:" + job),
  );
  const names =
    archive.engine === "sqlite"
      ? ["database.sqlite"]
      : [archive.version === 2 ? "database.json" : "database.dump"];
  if (
    ![1, 2].includes(archive.version) ||
    (archive.version === 2 && archive.engine !== "postgres") ||
    !["sqlite", "postgres"].includes(archive.engine) ||
    !Array.isArray(archive.files) ||
    !archive.files.length ||
    archive.files.length > names.length ||
    new Set(archive.files.map((f) => f.name)).size !== archive.files.length
  )
    throw new Error("Unsupported backup manifest.");
  const temp = await mkdtemp(join(tmpdir(), "keyforge-restore-"));
  try {
    for (const file of archive.files) {
      if (!names.includes(file.name)) throw new Error("Unexpected archive file.");
      const data = Buffer.from(file.data, "base64");
      if (digest(data) !== file.checksum) throw new Error("Snapshot checksum mismatch.");
      if (archive.version === 2) parsePostgresSnapshot(data);
      await writeFile(join(temp, file.name), data, { mode: 0o600 });
      if (archive.engine === "sqlite") {
        const db = new SQLite(join(temp, file.name), { readonly: true });
        try {
          if (
            db.pragma("integrity_check", { simple: true }) !== "ok" ||
            db.pragma("foreign_key_check").length
          )
            throw new Error("SQLite integrity check failed.");
        } finally {
          db.close();
        }
      }
    }
    if (archive.engine === "postgres") {
      if (!flag("database") || !args.includes("--replace"))
        throw new Error(
          "Postgres requires an explicit --database target and --replace. Take a target backup first.",
        );
      if (archive.version === 2) {
        // The exact release's migrations and auth schema must already exist.
        // Restore is transactional, preserves IDs and sessions, and checks rows.
        await restorePostgresSnapshot(
          flag("database"),
          await readFile(join(temp, "database.json")),
          true,
        );
      } else {
        const connection = postgresCliConnection(flag("database"));
        await execute(
          "pg_restore",
          [
            "--no-password",
            "--exit-on-error",
            "--single-transaction",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-acl",
            "--dbname",
            connection.database,
            join(temp, "database.dump"),
          ],
          {
            windowsHide: true,
            timeout: 300000,
            env: connection.env,
          },
        );
      }
    } else {
      const target = flag("sqlite");
      if (!target) throw new Error("Specify the SQLite target with --sqlite <file>.");
      const source = join(temp, "database.sqlite");
      for (const suffix of ["-wal", "-shm", "-journal"])
        if (await exists(target + suffix))
          throw new Error(
            "SQLite sidecars/lock exist. Shut down every connection cleanly before restoring.",
          );
      if ((await exists(target)) && !args.includes("--replace"))
        throw new Error("Target exists; use --replace after reviewing it.");
      await mkdir(dirname(resolve(target)), { recursive: true });
      if (await exists(target)) await copyFile(target, target + ".before-restore-" + Date.now());
      const staged = target + ".restore-" + job;
      try {
        await copyFile(source, staged);
        await rename(staged, target);
      } finally {
        await rm(staged, { force: true });
      }
    }
    console.log(
      "Restore completed. Restore the matching signing and data key rings before restarting; verify application health and operator access.",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
restore().catch(() => {
  console.error(
    "Restore failed. Check the archive, key ring, maintenance state and explicit target. No server was restarted.",
  );
  process.exitCode = 1;
});
