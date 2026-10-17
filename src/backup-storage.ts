import { randomUUID } from "node:crypto";

import { z } from "zod";

import { BackupDestinations, type StorageOptions } from "./backup-destinations.js";
import { atomic, DomainError, type RecordValue, type Records } from "./platform-store.js";
import { WORKSPACE, type Platform } from "./platform.js";

export const storageProvider = z.enum(["blob", "s3", "r2", "uploadthing"]);
type Provider = z.infer<typeof storageProvider>;
const text = z.string().trim().max(8192);
export const storageSettingsSchema = z
  .object({
    bucket: text.optional(),
    region: text.optional(),
    endpoint: z
      .union([
        z.literal(""),
        z.url().refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search
          );
        }, "Use an HTTPS endpoint without credentials or query parameters."),
      ])
      .optional(),
    accessKeyId: text.optional(),
    secretAccessKey: text.optional(),
    sessionToken: text.optional(),
    clearSessionToken: z.boolean().optional(),
    token: text.optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
type Settings = Omit<z.infer<typeof storageSettingsSchema>, "revision" | "clearSessionToken">;
interface Saved extends RecordValue {
  provider: Provider;
  sealed: string;
  createdAt: string;
}
interface Current extends RecordValue {
  version: string;
  verifiedAt?: string;
}

/** Provider secrets are encrypted with the external data key, never returned to the console. */
export class BackupStorage {
  private migrated = false;
  constructor(
    private platform: Platform,
    private initial: StorageOptions,
  ) {}
  private context(id: string) {
    return "backup-storage:" + id;
  }
  private unpack(value: Saved): Settings {
    return JSON.parse(this.platform.vault.decrypt(value.sealed, this.context(value.id)));
  }
  private config(provider: Provider, value: Settings): StorageOptions {
    if (provider === "blob" || provider === "uploadthing")
      return { [provider]: { token: value.token || "" } };
    return {
      [provider]: {
        bucket: value.bucket,
        region: value.region || (provider === "r2" ? "auto" : "us-east-1"),
        endpoint: value.endpoint || undefined,
        credentials: {
          accessKeyId: value.accessKeyId || "",
          secretAccessKey: value.secretAccessKey || "",
          ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}),
        },
      },
    };
  }
  private async store(r: Records, provider: Provider, value: Settings, revision: number) {
    const current = await r.get<Current>(WORKSPACE, "backup-storage-current", provider);
    if ((current?.revision ?? 0) !== revision)
      throw new DomainError(
        "revision_conflict",
        "Storage settings changed. Reload before saving.",
        409,
      );
    const id = randomUUID();
    await r.put<Saved>(WORKSPACE, "backup-storage", {
      id,
      provider,
      sealed: this.platform.vault.encrypt(JSON.stringify(value), this.context(id)),
      createdAt: this.platform.time(),
    });
    await r.put<Current>(WORKSPACE, "backup-storage-current", { id: provider, version: id });
    return id;
  }
  async migrate() {
    if (this.migrated || !this.platform.vault.ring) return;
    await atomic(this.platform.options.database, async (r) => {
      for (const provider of storageProvider.options) {
        if (await r.get(WORKSPACE, "backup-storage-current", provider)) continue;
        const config = this.initial[provider];
        if (
          !config ||
          ("token" in config
            ? !config.token
            : !config.bucket ||
              !config.credentials?.accessKeyId ||
              !config.credentials.secretAccessKey)
        )
          continue;
        const value: Settings =
          "token" in config
            ? { token: config.token }
            : {
                bucket: config.bucket,
                region: config.region,
                endpoint: config.endpoint,
                ...config.credentials,
              };
        const version = await this.store(r, provider, value, 0);
        // Pin archives made before this migration to their original destination credentials.
        for (const job of await r.list<
          RecordValue & { destination?: string; storageVersion?: string }
        >(WORKSPACE, "backup"))
          if (job.destination === provider && !job.storageVersion)
            await r.put(WORKSPACE, "backup", { ...job, storageVersion: version });
      }
    });
    this.migrated = true;
  }
  async version(provider: string, records = this.platform.records) {
    return (await records.get<Current>(WORKSPACE, "backup-storage-current", provider))?.version;
  }
  async resolve(
    provider: string,
    version?: string,
    records = this.platform.records,
  ): Promise<StorageOptions> {
    const id = version ?? (await this.version(provider, records));
    if (!id) return this.initial;
    const record = await records.get<Saved>(WORKSPACE, "backup-storage", id);
    if (!record || record.provider !== provider)
      throw new DomainError(
        "backup_storage_missing",
        "Original storage credentials are unavailable. Restore the database and data keyring.",
        503,
      );
    return { ...this.initial, ...this.config(record.provider, this.unpack(record)) };
  }
  async metadata(provider: Provider) {
    const current = await this.platform.records.get<Current>(
      WORKSPACE,
      "backup-storage-current",
      provider,
    );
    const saved =
      current &&
      (await this.platform.records.get<Saved>(WORKSPACE, "backup-storage", current.version));
    const value = saved ? this.unpack(saved) : {};
    return {
      revision: current?.revision ?? 0,
      source: saved ? "database" : "environment",
      bucket: value.bucket,
      region: value.region,
      endpoint: value.endpoint,
      hasCredentials: Boolean(value.token || value.secretAccessKey),
      hasSessionToken: Boolean(value.sessionToken),
      verifiedAt: current?.verifiedAt,
      editable: Boolean(this.platform.vault.ring),
    };
  }
  async save(provider: Provider, input: z.infer<typeof storageSettingsSchema>) {
    await atomic(this.platform.options.database, async (r) => {
      const current = await r.get<Current>(WORKSPACE, "backup-storage-current", provider);
      const saved = current && (await r.get<Saved>(WORKSPACE, "backup-storage", current.version));
      const old = saved ? this.unpack(saved) : {};
      const { revision, clearSessionToken, ...fields } = input;
      const value = { ...old, ...fields };
      for (const key of ["token", "accessKeyId", "secretAccessKey", "sessionToken"] as const)
        if (!fields[key]) value[key] = old[key];
      if (clearSessionToken) delete value.sessionToken;
      if (provider === "blob" || provider === "uploadthing") {
        if (!value.token)
          throw new DomainError("storage_credentials_required", "Enter a provider token.");
      } else if (
        !value.bucket ||
        !value.accessKeyId ||
        !value.secretAccessKey ||
        (provider === "r2" && !value.endpoint)
      )
        throw new DomainError(
          "storage_credentials_required",
          "Enter the bucket, access key ID and secret key; R2 also requires its HTTPS endpoint.",
        );
      await this.store(r, provider, value, revision);
    });
  }
  async driver(provider: string, version?: string, records = this.platform.records) {
    const options = await this.resolve(provider, version, records);
    // Each operation owns its client so a concurrent credential edit cannot close a running job's client.
    const run = async (method: "upload" | "download" | "remove", args: unknown[]) => {
      const destinations = new BackupDestinations(options);
      try {
        const driver = await destinations.driver(provider);
        const operation = driver[method];
        if (!operation)
          throw new DomainError(
            "backup_operation_unavailable",
            "This destination does not support the requested operation.",
            409,
          );
        return await (operation as (...args: unknown[]) => Promise<unknown>)(...args);
      } finally {
        destinations.close();
      }
    };
    return {
      upload: (id: string, bytes: Buffer) =>
        run("upload", [id, bytes]) as ReturnType<
          import("./backup-destinations.js").BackupDriver["upload"]
        >,
      download: (file: import("./backup-destinations.js").RemoteFile) =>
        run("download", [file]) as Promise<Buffer>,
      remove: async (file: import("./backup-destinations.js").RemoteFile) => {
        await run("remove", [file]);
      },
    };
  }
  async verify(provider: Provider) {
    const version = await this.version(provider);
    if (!version)
      throw new DomainError("storage_not_saved", "Save storage settings before testing.");
    const driver = await this.driver(provider, version);
    const bytes = Buffer.from("KeyForge storage verification " + randomUUID());
    const file = await driver.upload(randomUUID(), bytes);
    if (!file)
      throw new DomainError(
        "backup_verification_failed",
        "Storage did not return a downloadable file.",
        502,
      );
    try {
      if (!(await driver.download(file)).equals(bytes))
        throw new DomainError(
          "backup_verification_failed",
          "Storage returned different data.",
          502,
        );
    } finally {
      await driver.remove(file);
    }
    await atomic(this.platform.options.database, async (r) => {
      const current = await r.get<Current>(WORKSPACE, "backup-storage-current", provider);
      if (current?.version !== version)
        throw new DomainError(
          "revision_conflict",
          "Storage settings changed during verification. Test again.",
          409,
        );
      await r.put(WORKSPACE, "backup-storage-current", {
        ...current,
        verifiedAt: this.platform.time(),
      });
    });
  }
}
