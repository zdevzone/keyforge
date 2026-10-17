import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { put, get, del } from "@vercel/blob";
import { UTApi } from "uploadthing/server";
import type { UTApiOptions } from "uploadthing/types";
import { z } from "zod";

import { DomainError, type RecordValue } from "./platform-store.js";

export interface ObjectStorageOptions {
  bucket?: string;
  region?: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}
export interface StorageOptions {
  blob?: { token: string };
  /** Ephemeral hosts must not offer local-only or upload-only archives. */
  remoteOnly?: boolean;
  s3?: ObjectStorageOptions;
  r2?: ObjectStorageOptions;
  uploadthing?: { token: string };
  /** Server-only adapters for integration tests or embedded deployments. */
  drivers?: Record<string, BackupDriver>;
}
export type RemoteFile =
  | { type: "blob"; key: string }
  | { type: "object"; bucket: string; key: string; endpoint?: string; region: string }
  | { type: "uploadthing"; key: string };
export interface BackupDriver {
  upload(id: string, bytes: Buffer): Promise<RemoteFile | undefined>;
  download?(file: RemoteFile): Promise<Buffer>;
  remove?(file: RemoteFile): Promise<void>;
  close?(): void;
}
export interface DestinationStatus {
  id: string;
  name: string;
  type: "local" | "s3" | "r2" | "uploadthing" | "custom" | "blob";
  configured: boolean;
  reason?: string;
  archived?: boolean;
  config?: CustomDestination;
  revision?: number;
}
const httpURL = z
  .string()
  .max(4096)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  }, "Use an HTTP(S) upload URL without embedded user credentials or a fragment.");
export const customDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    url: httpURL,
    method: z.enum(["POST", "PUT"]).default("POST"),
    format: z.enum(["multipart", "raw"]).default("multipart"),
    fileField: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
      .default("file"),
    headerName: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/)
      .optional(),
    headerValueEnv: z
      .string()
      .regex(
        /^LICENSE_BACKUP_CUSTOM_[A-Z][A-Z0-9_]{0,100}$/,
        "Use a LICENSE_BACKUP_CUSTOM_ environment variable.",
      )
      .optional(),
    archived: z.boolean().default(false),
    revision: z.number().int().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.headerName) === Boolean(v.headerValueEnv),
    "Set both header name and secret environment variable, or neither.",
  )
  .refine(
    (v) =>
      !v.headerName ||
      ![
        "host",
        "content-length",
        "content-type",
        "cookie",
        "connection",
        "transfer-encoding",
      ].includes(v.headerName.toLowerCase()),
    "Use an authorization or API-key header.",
  );
export type CustomDestination = z.infer<typeof customDestinationSchema> &
  RecordValue & { encryptedHeaderValue?: string; hasAuthorization?: boolean };
export function nextBackupTime(now: Date, hour: number, minute = 0) {
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
function fileName(id: string) {
  return id + ".kfbackup";
}
function storageError(error: unknown) {
  if (error instanceof DomainError) return error;
  const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = value?.$metadata?.httpStatusCode;
  if (
    status === 401 ||
    status === 403 ||
    /AccessDenied|InvalidAccessKey|SignatureDoesNotMatch|CredentialsProviderError|FORBIDDEN|UNAUTHORIZED/i.test(
      value?.name ?? value?.code ?? "",
    )
  )
    return new DomainError(
      "backup_provider_access_denied",
      "Storage rejected the credentials or permissions. Check the provider's bucket and upload/read/delete access.",
      502,
    );
  if (status === 404 || /NoSuchBucket|NoSuchKey|NotFound/i.test(value?.name ?? ""))
    return new DomainError(
      "backup_provider_not_found",
      "The bucket or archived object was not found. Check the destination configuration.",
      502,
    );
  if (/Timeout|Abort|ETIMEDOUT/i.test(value?.name ?? value?.code ?? ""))
    return new DomainError(
      "backup_provider_timeout",
      "Storage did not respond in time. Check connectivity and retry.",
      504,
    );
  return new DomainError(
    "backup_provider_failed",
    "Storage operation failed. Check credentials, connectivity, quota and provider availability.",
    502,
  );
}
export async function readBackupResponse(response: Response): Promise<Buffer> {
  if (!response.ok)
    throw new DomainError(
      "backup_remote_http_error",
      "Storage returned HTTP " +
        response.status +
        ". Check the endpoint, credentials and upload format.",
      502,
    );
  const limit = 384 * 1024 * 1024;
  if (Number(response.headers.get("content-length") ?? 0) > limit)
    throw new DomainError(
      "backup_too_large",
      "Remote archive exceeds the supported download size.",
      413,
    );
  const reader = response.body?.getReader();
  if (!reader) throw new DomainError("backup_unavailable", "Storage returned no archive.", 502);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit)
        throw new DomainError(
          "backup_too_large",
          "Remote archive exceeds the supported download size.",
          413,
        );
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export class BackupDestinations {
  private objects = new Map<string, S3Client>();
  private ut?: UTApi;
  private utInvalid = false;
  constructor(
    public options: StorageOptions,
    public env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const id of ["s3", "r2"] as const) {
      const config = options[id];
      if (config?.bucket && (id === "s3" || (config.endpoint && config.credentials)))
        this.objects.set(
          id,
          new S3Client({
            region: config.region ?? (id === "r2" ? "auto" : "us-east-1"),
            endpoint: config.endpoint,
            credentials: config.credentials,
            forcePathStyle: Boolean(config.endpoint),
            maxAttempts: 3,
            requestHandler: { connectionTimeout: 15000, requestTimeout: 120000 },
          }),
        );
    }
    if (options.uploadthing?.token) {
      try {
        // The SDK decodes lazily; validate its documented token envelope for readiness.
        z.object({
          apiKey: z.string().startsWith("sk_"),
          appId: z.string(),
          regions: z.array(z.string()).nonempty(),
          ingestHost: z.string().optional(),
        }).parse(JSON.parse(Buffer.from(options.uploadthing.token, "base64").toString("utf8")));
        this.ut = new UTApi({
          token: options.uploadthing.token,
          logLevel: "None",
          fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([
                ...(init?.signal ? [init.signal] : []),
                AbortSignal.timeout(120000),
              ]),
            })) as NonNullable<UTApiOptions["fetch"]>,
        });
      } catch {
        this.utInvalid = true;
      }
    }
  }
  async statuses(custom: CustomDestination[]): Promise<DestinationStatus[]> {
    const result: DestinationStatus[] = [
      {
        id: "local",
        name: "Local storage",
        type: "local",
        configured: !this.options.remoteOnly,
        ...(this.options.remoteOnly
          ? { reason: "This host requires durable external backup storage." }
          : {}),
      },
    ];
    result.push({
      id: "blob",
      name: "Vercel Blob (private)",
      type: "blob",
      configured: Boolean(this.options.blob?.token || this.options.drivers?.blob),
      ...(!this.options.blob?.token && !this.options.drivers?.blob
        ? { reason: "Connect a private Blob store, then enter its token using Configure storage." }
        : {}),
    });
    for (const [id, name] of [
      ["s3", "AWS S3"],
      ["r2", "Cloudflare R2"],
    ] as const) {
      let configured = Boolean(this.options.drivers?.[id]);
      let reason: string | undefined;
      const config = this.options[id],
        client = this.objects.get(id);
      if (!configured && !config?.bucket)
        reason = "Enter the backup bucket and provider credentials using Configure storage.";
      else if (!configured && !client)
        reason = "Set the R2 endpoint (or account ID), access key ID and secret access key.";
      else if (!configured && client) {
        try {
          const credentials = await client.config.credentials();
          configured = Boolean(credentials.accessKeyId && credentials.secretAccessKey);
          if (!configured) reason = "Set both the provider access key ID and secret access key.";
        } catch {
          reason =
            "No usable credentials were found. Configure provider keys or an AWS SDK credential source.";
        }
      }
      result.push({ id, name, type: id, configured, ...(!configured ? { reason } : {}) });
    }
    const utReady = Boolean(this.ut || this.options.drivers?.uploadthing);
    result.push({
      id: "uploadthing",
      name: "UploadThing",
      type: "uploadthing",
      configured: utReady,
      ...(!utReady
        ? {
            reason: this.utInvalid
              ? "Invalid UploadThing token. Enter the provider's current app token in Configure storage."
              : "Enter your UploadThing app token using Configure storage.",
          }
        : {}),
    });
    for (const item of custom)
      result.push({
        id: item.id,
        name: item.name,
        type: "custom",
        archived: item.archived,
        revision: item.revision,
        config: item,
        configured:
          !this.options.remoteOnly &&
          !item.archived &&
          (Boolean(item.encryptedHeaderValue) ||
            !item.headerValueEnv ||
            Boolean(this.env[item.headerValueEnv])),
        ...(this.options.remoteOnly
          ? { reason: "Upload-only endpoints cannot provide durable downloads on this host." }
          : {}),
        ...(item.headerValueEnv && !this.env[item.headerValueEnv]
          ? { reason: "The configured authorization environment variable is missing." }
          : {}),
      });
    return result;
  }
  async driver(id: string, custom?: CustomDestination): Promise<BackupDriver> {
    const override = this.options.drivers?.[id];
    if (override) return override;
    if (id === "blob" && this.options.blob) {
      const token = this.options.blob.token;
      const pathname = (file: RemoteFile) => {
        if (file.type !== "blob" || !/^keyforge\/[0-9a-f-]{36}\.kfbackup$/.test(file.key))
          throw new DomainError("backup_unavailable", "Invalid private archive reference.", 409);
        return file.key;
      };
      return {
        upload: async (id, bytes) => {
          try {
            const result = await put("keyforge/" + fileName(id), bytes, {
              access: "private",
              token,
              addRandomSuffix: false,
              contentType: "application/octet-stream",
            });
            return { type: "blob", key: result.pathname };
          } catch (error) {
            throw storageError(error);
          }
        },
        download: async (file) => {
          try {
            const result = await get(pathname(file), { access: "private", token, useCache: false });
            if (!result || result.statusCode !== 200) throw Error("Missing archive.");
            return await readBackupResponse(new Response(result.stream));
          } catch (error) {
            throw storageError(error);
          }
        },
        remove: async (file) => {
          try {
            await del(pathname(file), { token });
          } catch (error) {
            throw storageError(error);
          }
        },
      };
    }
    const client = this.objects.get(id);
    if (client) {
      const config = this.options[id as "s3" | "r2"]!;
      return {
        upload: async (jobId, bytes) => {
          const key = "keyforge/" + fileName(jobId);
          try {
            await client.send(
              new PutObjectCommand({
                Bucket: config.bucket!,
                Key: key,
                Body: bytes,
                ContentType: "application/octet-stream",
              }),
              { abortSignal: AbortSignal.timeout(120000) },
            );
          } catch (error) {
            throw storageError(error);
          }
          return {
            type: "object",
            bucket: config.bucket!,
            key,
            endpoint: config.endpoint,
            region: config.region ?? (id === "r2" ? "auto" : "us-east-1"),
          };
        },
        download: async (file) => {
          if (file.type !== "object")
            throw new DomainError("backup_unavailable", "Invalid object reference.", 409);
          if (
            file.endpoint !== config.endpoint ||
            file.region !== (config.region ?? (id === "r2" ? "auto" : "us-east-1"))
          )
            throw new DomainError(
              "backup_destination_changed",
              "The original storage endpoint or region has changed. Restore that configuration to read this object.",
              409,
            );
          try {
            const result = await client.send(
              new GetObjectCommand({ Bucket: file.bucket, Key: file.key }),
              { abortSignal: AbortSignal.timeout(120000) },
            );
            if (result.ContentLength && result.ContentLength > 384 * 1024 * 1024)
              throw new DomainError(
                "backup_too_large",
                "Remote archive exceeds the supported download size.",
                413,
              );
            if (!result.Body)
              throw new DomainError("backup_unavailable", "Storage returned no archive.", 502);
            return await readBackupResponse(
              new Response(result.Body.transformToWebStream() as ReadableStream<Uint8Array>),
            );
          } catch (error) {
            throw storageError(error);
          }
        },
        remove: async (file) => {
          if (file.type !== "object") return;
          if (
            file.endpoint !== config.endpoint ||
            file.region !== (config.region ?? (id === "r2" ? "auto" : "us-east-1"))
          )
            throw new DomainError(
              "backup_destination_changed",
              "Restore the original endpoint/region before remote retention cleanup.",
              409,
            );
          try {
            await client.send(new DeleteObjectCommand({ Bucket: file.bucket, Key: file.key }), {
              abortSignal: AbortSignal.timeout(120000),
            });
          } catch (error) {
            throw storageError(error);
          }
        },
      };
    }
    if (id === "uploadthing" && this.ut) {
      const ut = this.ut;
      return {
        upload: async (jobId, bytes) => {
          try {
            const uploadOptions: NonNullable<Parameters<UTApi["uploadFiles"]>[1]> = {
              contentDisposition: "attachment",
            };
            const result = await ut.uploadFiles(
              new File([new Uint8Array(bytes)], fileName(jobId), {
                type: "application/octet-stream",
              }),
              uploadOptions,
            );
            if (result.error) throw storageError({ code: result.error.code });
            return { type: "uploadthing", key: result.data.key };
          } catch (error) {
            throw storageError(error);
          }
        },
        download: async (file) => {
          if (file.type !== "uploadthing")
            throw new DomainError("backup_unavailable", "Invalid UploadThing reference.", 409);
          try {
            const signed = await ut.generateSignedURL(file.key, { expiresIn: 300 });
            return await readBackupResponse(
              await fetch(signed.ufsUrl, {
                signal: AbortSignal.timeout(120000),
                redirect: "error",
              }),
            );
          } catch (error) {
            throw storageError(error);
          }
        },
        remove: async (file) => {
          if (file.type !== "uploadthing") return;
          try {
            const result = await ut.deleteFiles(file.key);
            if (!result.success) throw new Error("Delete rejected");
          } catch (error) {
            throw storageError(error);
          }
        },
      };
    }
    if (custom) {
      return {
        upload: async (jobId, bytes) => {
          const headers = new Headers();
          if (custom.headerName && custom.headerValueEnv) {
            const value = this.env[custom.headerValueEnv];
            if (!value)
              throw new DomainError(
                "backup_destination_unconfigured",
                "Configure the upload authorization environment variable.",
                503,
              );
            headers.set(custom.headerName, value);
          }
          let body: NonNullable<Parameters<typeof fetch>[1]>["body"];
          if (custom.format === "multipart") {
            const form = new FormData();
            form.set(
              custom.fileField,
              new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
              fileName(jobId),
            );
            body = form;
          } else {
            body = new Uint8Array(bytes);
            headers.set("content-type", "application/octet-stream");
            headers.set("content-disposition", 'attachment; filename="' + fileName(jobId) + '"');
          }
          try {
            const response = await fetch(custom.url, {
              method: custom.method,
              headers,
              body,
              redirect: "error",
              signal: AbortSignal.timeout(120000),
            });
            await response.body?.cancel();
            if (!response.ok)
              throw new DomainError(
                "backup_remote_http_error",
                "Upload endpoint returned HTTP " +
                  response.status +
                  ". Check its URL, authorization and upload format.",
                502,
              );
            return undefined;
          } catch (error) {
            throw storageError(error);
          }
        },
      };
    }
    throw new DomainError(
      "backup_destination_unconfigured",
      "This backup destination is not configured.",
      503,
    );
  }
  close() {
    for (const client of this.objects.values()) client.destroy();
    for (const driver of Object.values(this.options.drivers ?? {})) driver.close?.();
  }
}
export function storageOptionsFromEnv(env: NodeJS.ProcessEnv): StorageOptions {
  const credentials = (prefix: string) =>
    env[prefix + "_ACCESS_KEY_ID"] ||
    env[prefix + "_SECRET_ACCESS_KEY"] ||
    env[prefix + "_SESSION_TOKEN"]
      ? {
          accessKeyId: env[prefix + "_ACCESS_KEY_ID"] ?? "",
          secretAccessKey: env[prefix + "_SECRET_ACCESS_KEY"] ?? "",
          ...(env[prefix + "_SESSION_TOKEN"]
            ? { sessionToken: env[prefix + "_SESSION_TOKEN"] }
            : {}),
        }
      : undefined;
  const r2Account = env.LICENSE_BACKUP_R2_ACCOUNT_ID ?? env.R2_ACCOUNT_ID;
  return {
    blob: env.BLOB_READ_WRITE_TOKEN ? { token: env.BLOB_READ_WRITE_TOKEN } : undefined,
    s3: {
      bucket: env.LICENSE_BACKUP_S3_BUCKET,
      region: env.LICENSE_BACKUP_S3_REGION ?? env.AWS_REGION ?? "us-east-1",
      endpoint: env.LICENSE_BACKUP_S3_ENDPOINT,
      credentials: credentials("LICENSE_BACKUP_S3"),
    },
    r2: {
      bucket: env.LICENSE_BACKUP_R2_BUCKET ?? env.R2_BUCKET_NAME,
      region: "auto",
      endpoint:
        env.LICENSE_BACKUP_R2_ENDPOINT ??
        (r2Account ? "https://" + r2Account + ".r2.cloudflarestorage.com" : undefined),
      credentials: credentials("LICENSE_BACKUP_R2") ?? credentials("R2"),
    },
    uploadthing:
      (env.LICENSE_BACKUP_UPLOADTHING_TOKEN ?? env.UPLOADTHING_TOKEN)
        ? { token: (env.LICENSE_BACKUP_UPLOADTHING_TOKEN ?? env.UPLOADTHING_TOKEN)! }
        : undefined,
  };
}
