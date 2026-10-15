import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("secrets", { recursive: true, mode: 0o700 });
for (const name of ["data", "backup"]) {
  try {
    await writeFile(
      "secrets/" + name + ".keyring.json",
      JSON.stringify({
        active: "initial",
        keys: { initial: randomBytes(32).toString("hex") },
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log("Created secrets/" + name + ".keyring.json. Store a secure recovery copy.");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log("Existing " + name + " ring retained.");
  }
}
