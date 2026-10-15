import assert from "node:assert/strict";
import test from "node:test";

import { parseEnv } from "../src/env.js";

/**
 * The environment holds the secrets and the deployment wiring, and until now
 * nothing checked it. These tests are mostly about the two ways that hurts:
 * a malformed value silently becoming a default, and a value that looks set
 * but is not.
 */

/** Long enough to satisfy the secret floors, so unrelated cases stay readable. */
const SECRET = "0123456789abcdef0123";

test("an empty environment is valid — SQLite with no console is the documented default", () => {
  // The single most important case here. Making any of these required would
  // turn every zero-config deployment into a failed boot on upgrade.
  const env = parseEnv({});
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.LICENSE_AUTH_SECRET, undefined);
  assert.equal(env.LICENSE_ADMIN_TOKEN, undefined);
});

/**
 * The failure that prompted this module. `Number("ten")` is NaN, the guard in
 * resolvePostgresOptions rejected it, and the deployment quietly ran on the
 * default pool size while the operator believed otherwise. Wrong-but-plausible
 * is worse than broken: nobody investigates a service that appears to work.
 */
test("a malformed number is a boot failure, not a silent fallback", () => {
  assert.throws(
    () => parseEnv({ LICENSE_DB_POOL_MAX: "ten" }),
    /LICENSE_DB_POOL_MAX/,
    "the message must name the variable, or it is no better than the old default",
  );
  assert.equal(parseEnv({ LICENSE_DB_POOL_MAX: "8" }).LICENSE_DB_POOL_MAX, 8);
  // Coerced to a number, so callers stop re-parsing it.
  assert.equal(typeof parseEnv({ LICENSE_DB_POOL_MAX: "8" }).LICENSE_DB_POOL_MAX, "number");
  for (const bad of ["0", "-3", "2.5", "1000"]) {
    assert.throws(() => parseEnv({ LICENSE_DB_POOL_MAX: bad }), /LICENSE_DB_POOL_MAX/, bad);
  }
});

/**
 * `DATABASE_URL` is the engine switch (src/database.ts:37): anything that does
 * not match postgres:// falls through to SQLite. So a mysql:// URL, or a typo'd
 * scheme, does not fail — it silently runs the service on a local file while
 * the operator believes their managed database is in use. That is a data-loss
 * shaped mistake, and it is why this one is checked here rather than left to
 * the driver.
 */
test("a non-Postgres DATABASE_URL is refused rather than falling through to SQLite", () => {
  assert.throws(() => parseEnv({ DATABASE_URL: "mysql://host/db" }), /DATABASE_URL/);
  assert.throws(() => parseEnv({ DATABASE_URL: "postgres:/host/db" }), /DATABASE_URL/);
  for (const good of [
    "postgres://user:pw@host:5432/db",
    "postgresql://user:pw@host/db?sslmode=require",
  ]) {
    assert.equal(parseEnv({ DATABASE_URL: good }).DATABASE_URL, good);
  }
});

test("secrets have a length floor, because a short one only looks like security", () => {
  assert.throws(() => parseEnv({ LICENSE_ADMIN_TOKEN: "abc" }), /LICENSE_ADMIN_TOKEN/);
  assert.throws(() => parseEnv({ LICENSE_AUTH_SECRET: "abc" }), /LICENSE_AUTH_SECRET/);
  assert.equal(parseEnv({ LICENSE_ADMIN_TOKEN: SECRET }).LICENSE_ADMIN_TOKEN, SECRET);
});

/**
 * A bare hostname here produces Better Auth redirects that fail somewhere far
 * from the cause; nobody traces that back to this variable.
 */
test("LICENSE_SERVER_URL must be a URL, not a hostname", () => {
  assert.throws(
    () => parseEnv({ LICENSE_SERVER_URL: "license.example.com" }),
    /LICENSE_SERVER_URL/,
  );
  assert.equal(
    parseEnv({ LICENSE_SERVER_URL: "https://license.example.com" }).LICENSE_SERVER_URL,
    "https://license.example.com",
  );
});

test("Render supplies the public console URL unless a custom origin overrides it", () => {
  const render = "https://keyforge-example.onrender.com";
  assert.equal(parseEnv({ RENDER_EXTERNAL_URL: render }).LICENSE_SERVER_URL, render);
  assert.equal(
    parseEnv({ LICENSE_SERVER_URL: "", RENDER_EXTERNAL_URL: render }).LICENSE_SERVER_URL,
    render,
  );
  assert.equal(
    parseEnv({ LICENSE_SERVER_URL: "https://licenses.example.com", RENDER_EXTERNAL_URL: render })
      .LICENSE_SERVER_URL,
    "https://licenses.example.com",
  );
  assert.equal(parseEnv({}).LICENSE_SERVER_URL, undefined);
  assert.throws(() => parseEnv({ RENDER_EXTERNAL_URL: "invalid" }), /LICENSE_SERVER_URL/);
  assert.throws(
    () => parseEnv({ LICENSE_SERVER_URL: "invalid", RENDER_EXTERNAL_URL: render }),
    /LICENSE_SERVER_URL/,
  );
});

test("a seed address that is not an address is caught before it fails to seed", () => {
  assert.throws(() => parseEnv({ LICENSE_SEED_ADMIN_EMAIL: "nope" }), /LICENSE_SEED_ADMIN_EMAIL/);
  assert.equal(
    parseEnv({ LICENSE_SEED_ADMIN_EMAIL: "ops@example.com" }).LICENSE_SEED_ADMIN_EMAIL,
    "ops@example.com",
  );
});

/**
 * Clearing a field in a hosting dashboard usually leaves an empty string, not
 * an absent variable. Without emptyStringAsUndefined that arrives as a present
 * value: `LICENSE_DB_PATH=""` would open a database at the empty path, and
 * `LICENSE_AUTH_SECRET=""` would configure a console with an empty cookie
 * secret. Both are worse than the variable simply being unset.
 */
test("a variable cleared to an empty string reads as unset", () => {
  const env = parseEnv({ LICENSE_ADMIN_TOKEN: "", LICENSE_DB_PATH: "", DATABASE_URL: "" });
  assert.equal(env.LICENSE_ADMIN_TOKEN, undefined);
  assert.equal(env.LICENSE_DB_PATH, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("every problem is reported at once, not one boot at a time", () => {
  // Fixing config three deploys in a row because each one only reveals the
  // next error is the experience this avoids.
  const error = (() => {
    try {
      parseEnv({
        LICENSE_DB_POOL_MAX: "ten",
        LICENSE_SERVER_URL: "nope",
        LICENSE_ADMIN_TOKEN: "x",
      });
      return null;
    } catch (caught) {
      return caught as Error;
    }
  })();
  assert.ok(error, "expected a validation failure");
  for (const name of ["LICENSE_DB_POOL_MAX", "LICENSE_SERVER_URL", "LICENSE_ADMIN_TOKEN"]) {
    assert.match(error.message, new RegExp(name), `${name} should appear in the same report`);
  }
});

test("a realistic managed-Postgres deployment validates", () => {
  const env = parseEnv({
    DATABASE_URL: "postgres://u:pw@ep-cool.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    LICENSE_DB_POOL_MAX: "5",
    LICENSE_ADMIN_TOKEN: SECRET,
    LICENSE_AUTH_SECRET: SECRET,
    LICENSE_SERVER_URL: "https://license.example.com",
    LICENSE_SEED_ADMIN_EMAIL: "ops@example.com",
    LICENSE_SEED_ADMIN_PASSWORD: "a long enough password",
    PORT: "8080",
  });
  assert.equal(env.LICENSE_DB_POOL_MAX, 5);
  assert.equal(env.PORT, 8080);
});
