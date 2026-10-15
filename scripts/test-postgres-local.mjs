import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const bin = process.env.KEYFORGE_TEST_PG_BIN || "C:/Program Files/PostgreSQL/18/bin";
const temp = await mkdtemp(join(tmpdir(), "keyforge-pg-tests-"));
const data = join(temp, "data");
if (
  !resolve(temp).startsWith(resolve(tmpdir()) + "\\") &&
  !resolve(temp).startsWith(resolve(tmpdir()) + "/")
)
  throw new Error("Unexpected temporary path.");
let started = false;
try {
  await execute(
    join(bin, "initdb"),
    ["-D", data, "--auth=trust", "--username=keyforge", "--encoding=UTF8"],
    { windowsHide: true, timeout: 60000 },
  );
  await execute(
    join(bin, "pg_ctl"),
    ["-D", data, "-l", join(temp, "postgres.log"), "-o", "-p 55432 -h 127.0.0.1", "-w", "start"],
    { windowsHide: true, timeout: 60000 },
  );
  started = true;
  await execute(
    join(bin, "createdb"),
    ["-h", "127.0.0.1", "-p", "55432", "-U", "keyforge", "keyforge_test"],
    { windowsHide: true },
  );
  const result = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", "test/**/*.test.ts"], {
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        TEST_DATABASE_URL: "postgres://keyforge@127.0.0.1:55432/keyforge_test?sslmode=disable",
        PATH: bin + ";" + process.env.PATH,
      },
    });
    child.on("error", reject);
    child.on("exit", resolveExit);
  });
  process.exitCode = result;
} finally {
  if (started)
    await execute(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], {
      windowsHide: true,
      timeout: 60000,
    });

  await rm(temp, { recursive: true, force: true });
}
