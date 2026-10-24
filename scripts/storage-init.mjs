import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";

import { storageOptionsFromEnv } from "../dist/src/backup-destinations.js";

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf("--" + name);
  return i < 0 ? undefined : args[i + 1];
};
const provider = value("provider") || "all";
if (!["all", "s3", "r2"].includes(provider)) throw Error("Use --provider all, s3 or r2.");
const name = value("name") || "keyforge-storage-" + randomBytes(6).toString("hex");
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name))
  throw Error("Use a lowercase bucket name with 3–63 letters, digits or hyphens.");
const file = value("env-file") || ".env";
let source = await readFile(file, "utf8");
const env = { ...parseEnv(source), ...process.env },
  options = storageOptionsFromEnv(env);
const results = [];
for (const id of provider === "all" ? ["s3", "r2"] : [provider]) {
  const config = options[id];
  if (!config?.credentials?.accessKeyId || !config.credentials.secretAccessKey) {
    console.error(id + ": configure dedicated backup access keys before creating a bucket.");
    process.exitCode = 1;
    continue;
  }
  const bucket = config.bucket || name,
    region = config.region || (id === "r2" ? "auto" : "us-east-1");
  const client = new S3Client({
    region,
    endpoint: config.endpoint,
    credentials: config.credentials,
    forcePathStyle: Boolean(config.endpoint),
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 15000, requestTimeout: 60000 },
  });
  try {
    if (config.bucket)
      await client.send(new HeadBucketCommand({ Bucket: bucket }), {
        abortSignal: AbortSignal.timeout(60000),
      });
    else {
      await client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ...(id === "s3" && region !== "us-east-1"
            ? { CreateBucketConfiguration: { LocationConstraint: region } }
            : {}),
        }),
        { abortSignal: AbortSignal.timeout(60000) },
      );
      if (id === "s3")
        await client.send(
          new PutPublicAccessBlockCommand({
            Bucket: bucket,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          }),
          { abortSignal: AbortSignal.timeout(60000) },
        );
    }
    const key = "LICENSE_BACKUP_" + id.toUpperCase() + "_BUCKET";
    const lines = source.split(/\r?\n/);
    const index = lines.findIndex((line) => new RegExp("^(?:#\\s*)?" + key + "\\s*=").test(line));
    const setting = key + "=" + JSON.stringify(bucket);
    if (index >= 0) lines[index] = setting;
    else lines.push(setting);
    source = lines.join("\n");
    await writeFile(file, source);
    results.push({ provider: id, bucket, created: !config.bucket });
    console.log(id + ": " + (config.bucket ? "verified " : "created ") + bucket);
  } catch (error) {
    console.error(
      id +
        ": " +
        (error?.name || "StorageError") +
        " (HTTP " +
        (error?.$metadata?.httpStatusCode || "unavailable") +
        "). Check provider permissions and endpoint.",
    );
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
}
console.log(JSON.stringify({ destinations: results, configuration: file }));
