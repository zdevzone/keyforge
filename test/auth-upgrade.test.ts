import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createAuth, closeAuth, ensureAuthSchema } from "../src/auth.js";
import { createPostgresPool } from "../src/database.js";

test("Postgres operators upgrade from the required legacy issuer column without losing sign-in data", async (t) => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return t.skip("set TEST_DATABASE_URL to exercise the Better Auth issuer upgrade");
  const schema = "kf_auth_upgrade_" + randomUUID().replaceAll("-", "");
  const owner = createPostgresPool(base);
  await owner.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(base);
  url.searchParams.set("options", "-c search_path=" + schema);
  const pool = createPostgresPool(url.href);
  const auth = createAuth({
    dbPath: ":memory:",
    url: url.href,
    secret: "upgrade-test-secret-0123456789abcdef",
    baseURL: "http://localhost",
    allowSignUp: true,
  });
  t.after(async () => {
    await closeAuth(auth);
    await pool.end();
    await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.end();
  });
  await ensureAuthSchema(auth);
  const first = await auth.api.signUpEmail({
    body: {
      email: "old@example.test",
      password: "Legacy-password-2026!",
      name: "Existing operator",
    },
  });
  const before = (await pool.query('SELECT "password", "userId" FROM "account"')).rows[0];
  await pool.query(
    'ALTER TABLE "account" ADD COLUMN "issuer" TEXT NOT NULL DEFAULT \'legacy-issuer\'',
  );
  await pool.query('ALTER TABLE "account" ALTER COLUMN "issuer" DROP DEFAULT');
  await pool.query(
    'CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")',
  );
  await ensureAuthSchema(auth);
  await ensureAuthSchema(auth);
  assert.deepEqual(
    (
      await pool.query('SELECT "password", "userId" FROM "account" WHERE "userId" = $1', [
        first.user.id,
      ])
    ).rows[0],
    before,
  );
  assert.equal(
    (await pool.query('SELECT "issuer" FROM "account" WHERE "userId" = $1', [first.user.id]))
      .rows[0].issuer,
    "legacy-issuer",
  );
  const signedIn = await auth.api.signInEmail({
    body: { email: "old@example.test", password: "Legacy-password-2026!" },
  });
  assert.equal(signedIn.user.id, first.user.id);
  const second = await auth.api.signUpEmail({
    body: { email: "new@example.test", password: "New-password-2026!", name: "New operator" },
  });
  assert.equal(
    (await pool.query('SELECT "issuer" FROM "account" WHERE "userId" = $1', [second.user.id]))
      .rows[0].issuer,
    null,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) AS count FROM pg_indexes WHERE schemaname = $1 AND indexname = 'account_issuer_accountId_uidx'",
        [schema],
      )
    ).rows[0].count,
    "0",
  );
});
