import { createHash, randomBytes, randomUUID, sign } from "node:crypto";

import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthInstance } from "./auth.js";
import type { AppConfig, Entitlements } from "./config.js";
import { entitlementsSchema } from "./config.js";
import { generateProductKey, hashProductKey, type LicenseDatabase, type LicenseRow } from "./db.js";
import { durationMs } from "./duration.js";
import {
  balance,
  money,
  paymentFields,
  planPrice,
  registerFinance,
  type Sale,
  type Entry,
} from "./finance.js";
import {
  bumpImportRevision,
  importAccount,
  importUnits,
  recordImportEvent,
  registerImportLicensing,
  type ImportAccount,
} from "./import-licensing.js";
import { describeSigningKey, verifyLicenseToken } from "./keypair.js";
import {
  registerLicenseDelivery,
  type LicenseRequest,
  type LicenseDelivery,
} from "./license-delivery.js";
import {
  newSupportReference,
  normalizeSignals,
  pickMatch,
  SIGNAL_KINDS,
  signalAvailability,
} from "./machines.js";
import { registerNotifications } from "./notifications.js";
import {
  atomic,
  DomainError,
  Records,
  Vault,
  type KeyRing,
  type RecordValue,
} from "./platform-store.js";
import { buildReport, reportQuerySchema, type ReportBinding, type ReportUsage } from "./reports.js";
import { generateSigningKeyPair } from "./sign.js";
import { normalizeSupportRequest, supportRequestBodySchema } from "./support.js";
import { productTokenSchema } from "./token-contract.js";

export const WORKSPACE = "workspace:default";
const scope = (id: string) => "product:" + id;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const idSchema = z.string().trim().min(1).max(200);
const slugSchema = z.string().regex(/^[a-z][a-z0-9-]{0,59}$/);
const timestamp = z.string().datetime({ offset: true });
const valueSchema = z.union([z.number().finite(), z.string(), z.boolean()]);
const trialSchema = z
  .object({
    enabled: z.boolean(),
    allowance: z.number().int().nonnegative().nullable(),
    durationDays: z.number().int().positive().nullable(),
  })
  .strict();
const definitionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/),
    type: z.enum(["number", "string", "boolean"]),
    description: z.string().max(500),
    defaultValue: valueSchema.optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    archived: z.boolean().default(false),
    revision: z.number().int().optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (
      definition.minimum !== undefined &&
      definition.maximum !== undefined &&
      definition.minimum > definition.maximum
    )
      context.addIssue({ code: "custom", message: "Minimum exceeds maximum." });
    if (
      definition.defaultValue !== undefined &&
      (typeof definition.defaultValue !== definition.type ||
        (typeof definition.defaultValue === "number" &&
          ((definition.minimum !== undefined && definition.defaultValue < definition.minimum) ||
            (definition.maximum !== undefined && definition.defaultValue > definition.maximum))))
    )
      context.addIssue({
        code: "custom",
        message: "Default value must match the definition type and bounds.",
      });
  });
const planSchema = z
  .object({
    id: slugSchema,
    description: z.string().max(500),
    entitlements: entitlementsSchema,
    durationDays: z.number().int().positive().nullable(),
    activationLimit: z.number().int().positive(),
    price: money.nullable().optional(),
    currency: z.literal("ETB").optional(),
    archived: z.boolean().default(false),
    revision: z.number().int().optional(),
  })
  .strict();
export type Definition = z.infer<typeof definitionSchema>;
export type Plan = z.infer<typeof planSchema>;
export interface Product extends RecordValue {
  importPolicy?: { entitlement: string };
  name: string;
  archived: boolean;
  graceDays: number;
  trial: z.infer<typeof trialSchema>;
  keys: {
    kid: string;
    publicKeyPem: string;
    encryptedPrivateKey?: string;
    retiredAt: string | null;
    pending?: boolean;
  }[];
}
export interface Grant extends LicenseRow {
  importAccountId?: string;
  revision?: number;
  productId: string;
  keyReference: string;
  encryptedKey?: string;
  subjectKind: "installation" | "service";
}
interface Installation extends RecordValue {
  importAccountId?: string | null;
  trialConvertedAt?: string | null;
  credentialHash: string;
  registeredAt: string;
  lastSeenAt: string;
  appVersion: string;
  platform: string;
  userName: string;
  userEmail: string;
  licenseId: string | null;
  machineSignals?: ReturnType<typeof normalizeSignals>;
  signalsUpdatedAt?: string;
}
interface Binding extends RecordValue {
  licenseId: string;
  installationId: string;
  activatedAt: string;
  deactivatedAt: string | null;
}
interface Machine extends RecordValue {
  supportReference: string;
  signals: ReturnType<typeof normalizeSignals>;
  installationIds: string[];
  registrationCount: number;
  clearedAtCount: number | null;
  clearedAt: string | null;
  firstRegisteredAt: string;
  lastRegisteredAt: string;
  signalsUpdatedAt?: string;
}
function deviceSummary(
  machines: Machine[],
  installationId: string,
  signals?: ReturnType<typeof normalizeSignals>,
) {
  const groups = machines.filter((m) => m.installationIds.includes(installationId));
  const signalKinds = [
    ...new Set((signals ?? groups.flatMap((m) => m.signals)).map((s) => s.kind)),
  ];
  return {
    machineGroups: groups.map((m) => ({ id: m.id, supportReference: m.supportReference })),
    signalKinds,
    signalAvailability: signalAvailability(signalKinds),
  };
}
export const SUPPORT_STATES = [
  "queued",
  "in_progress",
  "waiting_customer",
  "resolved",
  "closed",
] as const;
interface Message {
  id: string;
  author: string;
  body: string;
  internal: boolean;
  createdAt: string;
}
export interface Ticket extends RecordValue {
  licenseId: string;
  installationId: string;
  category: string;
  urgency: string;
  subject: string;
  message: string;
  reporterName: string | null;
  appVersion: string | null;
  platform: string | null;
  clientRequestId: string;
  clientCreatedAt: string;
  receivedAt: string;
  updatedAt: string;
  status: (typeof SUPPORT_STATES)[number];
  assignedTo: string | null;
  messages: Message[];
}
export interface Meter extends RecordValue {
  entitlement: string;
  period: "lifetime" | "daily" | "monthly";
  description: string;
  archived: boolean;
}
export interface PlatformOptions {
  database: LicenseDatabase;
  config: AppConfig;
  privateKey: string;
  kid: string;
  keyring?: KeyRing;
  auth?: AuthInstance;
  now: () => Date;
  gate: (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<{ actor: string; role: "admin" | "support" } | null>;
}
export class Platform {
  records: Records;
  vault: Vault;
  constructor(public options: PlatformOptions) {
    this.records = new Records(options.database.db);
    this.vault = new Vault(options.keyring);
  }
  time() {
    return this.options.now().toISOString();
  }
  async product(id: string, records = this.records) {
    const product = await records.get<Product>(WORKSPACE, "product", id);
    if (!product) throw new DomainError("unknown_product", "No such product.", 404);
    return product;
  }
  publicProduct(product: Product) {
    return {
      ...product,
      keys: product.keys.map(({ encryptedPrivateKey: _secret, ...key }) => key),
    };
  }
  async plans(pid: string, records = this.records, includePrices = true) {
    const plans = await records.list<Plan>(scope(pid), "plan");
    return Promise.all(
      plans.map(async (p) => ({
        ...p,
        ...(includePrices
          ? { price: await planPrice(records, scope(pid), p.id), currency: "ETB" as const }
          : {}),
      })),
    );
  }
  async savePlan(pid: string, plan: Plan, records: Records, expected?: number) {
    const { price, currency: _currency, ...terms } = plan;
    await records.put(scope(pid), "plan", terms, expected);
    if (price !== undefined)
      await records.put(scope(pid), "price", {
        id: plan.id,
        amount: price,
        currency: "ETB",
        updatedAt: this.time(),
      });
  }
  async bootstrap(existingRecords?: Records) {
    const seed = async (records: Records) => {
      if (await records.get(WORKSPACE, "product", "default")) return;
      const signing = describeSigningKey(this.options.privateKey);
      await records.put(WORKSPACE, "product", {
        id: "default",
        name: this.options.config.branding.name,
        archived: false,
        graceDays: this.options.config.tokens.offlineGraceDays,
        trial: { enabled: true, allowance: 20000, durationDays: null },
        keys: [
          { kid: this.options.kid, publicKeyPem: signing.publicKeyPem, retiredAt: null },
          ...this.options.config.signingKeys.retired,
        ],
      } as Product);
      const definitions = new Map<string, Set<string>>();
      for (const [id, preset] of Object.entries(this.options.config.licenses.planPresets)) {
        await records.put(scope("default"), "plan", {
          id,
          description: "",
          entitlements: preset.entitlements,
          durationDays: preset.durationDays ?? null,
          activationLimit:
            preset.activationLimit ?? this.options.config.licenses.defaultActivationLimit,
          archived: false,
        } as Plan);
        for (const [key, value] of Object.entries(preset.entitlements)) {
          const types = definitions.get(key) ?? new Set<string>();
          types.add(typeof value);
          definitions.set(key, types);
        }
      }
      for (const [id, types] of definitions) {
        if (types.size !== 1)
          throw new Error("Configured plans disagree on the entitlement type for " + id + ".");
        await records.put(scope("default"), "definition", {
          id,
          type: [...types][0],
          description: "",
          archived: false,
        } as Definition);
      }
    };
    if (existingRecords) await seed(existingRecords);
    else await atomic(this.options.database, seed);
  }
  status(grant: Grant) {
    return grant.status === "revoked"
      ? "revoked"
      : grant.expiresAt && this.time() >= grant.expiresAt
        ? "expired"
        : "active";
  }
  async audit(
    actor: string,
    action: string,
    productId: string,
    detail: Record<string, unknown> = {},
  ) {
    if (this.options.config.features.audit)
      await this.options.database.appendAudit({ actor, action, detail: { productId, ...detail } });
  }
  privateKey(product: Product) {
    const key = product.keys.find((k) => k.retiredAt === null && !k.pending);
    if (!key) throw new DomainError("signing_unavailable", "No active signing key.", 503);
    if (key.encryptedPrivateKey)
      return this.vault.decrypt(key.encryptedPrivateKey, "signing:" + product.id + ":" + key.kid);
    if (product.id === "default" && key.kid === this.options.kid) return this.options.privateKey;
    throw new DomainError("signing_unavailable", "The signing key provider is unavailable.", 503);
  }
  sign(product: Product, payload: object) {
    const bytes = Buffer.from(JSON.stringify(payload));
    return (
      bytes.toString("base64url") +
      "." +
      sign(null, bytes, this.privateKey(product)).toString("base64url")
    );
  }
  async token(product: Product, license: Grant, installationId: string, records = this.records) {
    const account = await importAccount(records, product.id, license);
    return this.sign(product, {
      v: 1,
      kind: "license",
      iss: "default",
      productId: product.id,
      kid: product.keys.find((k) => k.retiredAt === null && !k.pending)!.kid,
      licenseId: license.id,
      plan: license.plan,
      entitlements: license.entitlements,
      issuedTo: license.issuedTo,
      subject: { kind: license.subjectKind, id: installationId },
      installationId,
      issuedAt: this.time(),
      expiresAt: license.expiresAt,
      offlineGraceUntil: new Date(
        this.options.now().getTime() + product.graceDays * 86400000,
      ).toISOString(),
      status: this.status(license),
      accountId: account?.id ?? null,
      authorizationRevision: account?.authorizationRevision ?? license.revision ?? 1,
      paidImportsGranted: account?.granted ?? null,
      recoveryGeneration: account?.recoveryGeneration ?? 0,
      trialConverted: true,
    });
  }
  async authenticate(pid: string, iid: string, secret: string, records = this.records) {
    const installation = await records.get<Installation>(scope(pid), "installation", iid);
    if (!secret || !installation?.credentialHash || hash(secret) !== installation.credentialHash)
      throw new DomainError(
        "installation_unauthorized",
        "A valid installation credential is required.",
        401,
      );
    return installation;
  }
  async validateEntitlements(pid: string, values: Entitlements, records = this.records) {
    const defs = await records.list<Definition>(scope(pid), "definition");
    for (const [name, value] of Object.entries(values)) {
      const def = defs.find((d) => d.id === name);
      if (
        !def ||
        def.archived ||
        typeof value !== def.type ||
        (typeof value === "number" &&
          ((def.minimum !== undefined && value < def.minimum) ||
            (def.maximum !== undefined && value > def.maximum)))
      )
        throw new DomainError(
          "bad_entitlements",
          "Define an active, correctly typed entitlement for " + name + ".",
        );
    }
  }
  async reauthenticate(request: FastifyRequest, actor: string) {
    if (actor === "cli") return;
    const auth = this.options.auth;
    const session =
      auth && (await auth.api.getSession({ headers: fromNodeHeaders(request.headers) }));
    const password = (request.body as { password?: string })?.password;
    if (!session || !password)
      throw new DomainError(
        "reauthentication_required",
        "Enter your current password to reveal the key.",
        401,
      );
    const context = await auth!.$context;
    const accounts = await context.adapter.findMany({
      model: "account",
      where: [{ field: "userId", value: session.user.id }],
    });
    const account = accounts.find(
      (a) => (a as { providerId?: string }).providerId === "credential",
    ) as { password?: string } | undefined;
    if (
      !account?.password ||
      !(await context.password.verify({ hash: account.password, password }))
    )
      throw new DomainError("reauthentication_required", "Current password is incorrect.", 401);
  }
}

export async function registerPlatform(app: FastifyInstance, options: PlatformOptions) {
  const platform = new Platform(options);
  await platform.bootstrap();

  for (const product of await platform.records.list<Product>(WORKSPACE, "product")) {
    describeSigningKey(platform.privateKey(product));
    for (const key of product.keys)
      if (key.encryptedPrivateKey)
        platform.vault.decrypt(key.encryptedPrivateKey, "signing:" + product.id + ":" + key.kid);
  }
  for (const product of await platform.records.list<Product>(WORKSPACE, "product")) {
    const active = product.keys.find((key) => !key.retiredAt && !key.pending);
    if (
      !active ||
      !verifyLicenseToken(platform.sign(product, { kind: "startup-probe" }), active.publicKeyPem)
        .valid
    )
      throw new Error(
        "Signing provider does not match the persisted product public key. Restore the matching key or use staged rotation.",
      );
  }
  const wrap =
    (fn: (req: any, reply: FastifyReply) => Promise<unknown>, admin = false, write = false) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        let actor = "";
        if (admin) {
          const operator = await options.gate(req, reply);
          if (!operator) return;
          if (write && operator.role !== "admin")
            throw new DomainError("insufficient_role", "This action requires an admin.", 403);
          actor = operator.actor;
          (req as any).actor = actor;
          (req as any).operatorRole = operator.role;
          if (
            req.method !== "GET" &&
            actor !== "cli" &&
            req.headers.origin !== undefined &&
            req.headers.origin !== new URL("http://" + req.headers.host).origin &&
            req.headers.origin !== new URL("https://" + req.headers.host).origin
          )
            throw new DomainError(
              "invalid_origin",
              "Request origin does not match this console.",
              403,
            );
        }
        if ((req.params as any)?.productId) {
          const product = await platform.product((req.params as any).productId);
          if (!admin && product.archived)
            throw new DomainError("product_archived", "This product is archived.", 410);
        }
        return await fn(req, reply);
      } catch (error) {
        const domain =
          error instanceof DomainError
            ? error
            : error instanceof z.ZodError
              ? new DomainError(
                  "bad_request",
                  error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "),
                )
              : new DomainError("internal_error", "The service failed to answer.", 500);
        return reply.code(domain.status).send({
          error: domain.code,
          message: domain.message,
          retryable: domain.status === 429 || domain.status === 503,
          serverTime: platform.time(),
        });
      }
    };
  const admin = "/admin/products";
  const ap = admin + "/:productId";
  const device = "/v1/products/:productId";
  const limited = (limit: { max: number; timeWindow: string }, installation = true) => ({
    config: {
      rateLimit: options.config.limits.enabled
        ? {
            ...limit,
            ...(installation
              ? {
                  keyGenerator: (req: FastifyRequest) =>
                    String((req.params as any).productId) +
                    ":" +
                    String((req.body as any)?.installationId ?? req.ip),
                }
              : {}),
          }
        : (false as const),
    },
  });
  const bearer = (req: any) => String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const paged = (values: any[], req: any) => {
    const q = String(req.query.q ?? "")
      .trim()
      .toLowerCase();
    const matching = q ? values.filter((v) => JSON.stringify(v).toLowerCase().includes(q)) : values;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    return { values: matching.slice(offset, offset + limit), total: matching.length };
  };
  app.get(
    admin,
    wrap(
      async () => ({
        products: (await platform.records.list<Product>(WORKSPACE, "product")).map((p) =>
          platform.publicProduct(p),
        ),
      }),
      true,
    ),
  );
  app.post(
    admin,
    wrap(
      async (req) => {
        const input = z
          .object({ id: slugSchema, name: z.string().trim().min(1).max(100) })
          .strict()
          .parse(req.body);
        const pair = generateSigningKeyPair();
        const kid = "key-" + randomUUID();
        const product: Product = {
          ...input,
          archived: false,
          graceDays: 30,
          trial: { enabled: false, allowance: null, durationDays: null },
          keys: [
            {
              kid,
              publicKeyPem: pair.publicKey,
              encryptedPrivateKey: platform.vault.encrypt(
                pair.privateKey,
                "signing:" + input.id + ":" + kid,
              ),
              retiredAt: null,
            },
          ],
        };
        await atomic(options.database, async (records) => {
          if (await records.get(WORKSPACE, "product", input.id))
            throw new DomainError("product_exists", "Product ID already exists.", 409);
          await records.put(WORKSPACE, "product", product);
        });
        await platform.audit(req.actor, "product.create", input.id);
        return { product: platform.publicProduct(await platform.product(input.id)) };
      },
      true,
      true,
    ),
  );
  app.patch(
    ap,
    wrap(
      async (req) => {
        const input = z
          .object({
            name: z.string().trim().min(1).max(100),
            archived: z.boolean(),
            graceDays: z.number().int().positive().max(365),
            trial: trialSchema,
            revision: z.number().int(),
          })
          .strict()
          .parse(req.body);
        if (
          input.trial.enabled &&
          input.trial.allowance === null &&
          input.trial.durationDays === null
        )
          throw new DomainError("bad_trial", "An enabled trial needs an allowance or duration.");
        const product = await atomic(options.database, async (records) => {
          const prior = await platform.product(req.params.productId, records);
          const next = { ...prior, ...input };
          await records.put(WORKSPACE, "product", next, input.revision);
          return next;
        });
        await platform.audit(req.actor, "product.update", product.id);
        return { product: platform.publicProduct(await platform.product(product.id)) };
      },
      true,
      true,
    ),
  );
  app.post(
    ap + "/keys/stage",
    wrap(
      async (req) => {
        const input = z.object({ revision: z.number().int() }).parse(req.body);
        const product = await atomic(options.database, async (records) => {
          const product = await platform.product(req.params.productId, records);
          const pair = generateSigningKeyPair();
          const kid = "key-" + randomUUID();
          if (product.keys.some((k) => k.pending))
            throw new DomainError("key_already_staged", "Activate the staged key first.", 409);
          product.keys = [
            ...product.keys,
            {
              kid,
              publicKeyPem: pair.publicKey,
              encryptedPrivateKey: platform.vault.encrypt(
                pair.privateKey,
                "signing:" + product.id + ":" + kid,
              ),
              retiredAt: null,
              pending: true,
            },
          ];
          await records.put(WORKSPACE, "product", product, input.revision);
          return product;
        });
        await platform.audit(req.actor, "signing.stage", product.id);
        return { product: platform.publicProduct(await platform.product(product.id)) };
      },
      true,
      true,
    ),
  );
  app.get(
    device + "/keys",
    wrap(async (req) => ({
      keys: platform.publicProduct(await platform.product(req.params.productId)).keys,
      serverTime: platform.time(),
    })),
  );
  app.post(
    ap + "/keys/:kid/activate",
    wrap(
      async (req) => {
        const input = z
          .object({ confirm: z.literal(true), revision: z.number().int() })
          .strict()
          .parse(req.body);
        await atomic(options.database, async (records) => {
          const product = await platform.product(req.params.productId, records);
          const staged = product.keys.find((k) => k.kid === req.params.kid && k.pending);
          if (!staged)
            throw new DomainError("unknown_staged_key", "No such staged signing key.", 404);
          product.keys = product.keys.map((k) =>
            k.kid === staged.kid
              ? { ...k, pending: false }
              : { ...k, retiredAt: k.retiredAt ?? platform.time() },
          );
          await records.put(WORKSPACE, "product", product, input.revision);
        });
        await platform.audit(req.actor, "signing.activate", req.params.productId);
        return { product: platform.publicProduct(await platform.product(req.params.productId)) };
      },
      true,
      true,
    ),
  );
  app.get(
    "/admin/operators/directory",
    wrap(async () => {
      if (!options.auth) return { operators: [] };
      const context = await options.auth.$context;
      const users = (await context.adapter.findMany({ model: "user", limit: 1000 })) as {
        id: string;
        name: string;
        email: string;
        role?: string;
        banned?: boolean;
      }[];
      return {
        operators: users
          .filter((u) => !u.banned && ["admin", "support"].includes(u.role ?? ""))
          .map((u) => ({ id: u.id, name: u.name, email: u.email })),
      };
    }, true),
  );
  app.get(
    ap + "/catalog/export",
    wrap(
      async (req) => ({
        version: 1,
        definitions: (
          await platform.records.list<Definition>(scope(req.params.productId), "definition")
        ).map(({ revision: _revision, ...d }) => d),
        plans: (
          await platform.plans(req.params.productId, platform.records, req.operatorRole === "admin")
        ).map(({ revision: _revision, ...p }) => p),
      }),
      true,
    ),
  );
  app.post(
    ap + "/catalog/import",
    wrap(
      async (req) => {
        const input = z
          .object({
            catalog: z
              .object({
                version: z.literal(1),
                definitions: z.array(definitionSchema).max(1000),
                plans: z.array(planSchema).max(1000),
              })
              .strict(),
            preview: z.boolean(),
            fingerprint: z.string().optional(),
          })
          .strict()
          .parse(req.body);
        const result = await atomic(options.database, async (records) => {
          const pid = req.params.productId;
          const definitions = await records.list<Definition>(scope(pid), "definition");
          const plans = await platform.plans(pid, records);
          const fingerprint = hash(JSON.stringify({ definitions, plans, catalog: input.catalog }));
          if (!input.preview && input.fingerprint !== fingerprint)
            throw new DomainError("revision_conflict", "Catalog changed. Preview again.", 409);
          for (const kind of ["definitions", "plans"] as const)
            if (new Set(input.catalog[kind].map((v) => v.id)).size !== input.catalog[kind].length)
              throw new DomainError("duplicate_catalog_id", "Catalog IDs must be unique.");
          const merged = new Map(definitions.map((d) => [d.id, d]));
          const licenses = await records.list<Grant>(scope(pid), "license");
          for (const def of input.catalog.definitions) {
            const prior = merged.get(def.id);
            const used =
              licenses.some((l) => def.id in l.entitlements) ||
              plans.some((p) => def.id in p.entitlements);
            if (prior && prior.type !== def.type && used)
              throw new DomainError("definition_in_use", "Used entitlement type cannot change.");
            if (def.defaultValue !== undefined && typeof def.defaultValue !== def.type)
              throw new DomainError(
                "bad_definition",
                "Resolve ambiguous entitlement types before import.",
              );
            if (def.minimum !== undefined && def.maximum !== undefined && def.minimum > def.maximum)
              throw new DomainError("bad_definition", "Minimum exceeds maximum.");
            merged.set(def.id, def);
          }
          for (const plan of input.catalog.plans)
            for (const [key, value] of Object.entries(plan.entitlements)) {
              const def = merged.get(key);
              if (
                !def ||
                def.archived ||
                typeof value !== def.type ||
                (typeof value === "number" &&
                  ((def.minimum !== undefined && value < def.minimum) ||
                    (def.maximum !== undefined && value > def.maximum)))
              )
                throw new DomainError(
                  "bad_entitlements",
                  "Plan uses an undefined or invalid entitlement: " + key,
                );
            }
          if (!input.preview) {
            for (const d of input.catalog.definitions)
              await records.put(scope(pid), "definition", d);
            for (const p of input.catalog.plans) await platform.savePlan(pid, p, records);
          }
          return {
            fingerprint,
            definitions: input.catalog.definitions.length,
            plans: input.catalog.plans.length,
            applied: !input.preview,
          };
        });
        if (!input.preview) await platform.audit(req.actor, "catalog.import", req.params.productId);
        return result;
      },
      true,
      true,
    ),
  );
  app.get(
    ap + "/catalog",
    wrap(async (req) => {
      const pid = req.params.productId;
      const licenses = await platform.records.list<Grant>(scope(pid), "license");
      const definitions = await platform.records.list<Definition>(scope(pid), "definition");
      const plans = await platform.plans(pid, platform.records, req.operatorRole === "admin");
      return {
        product: platform.publicProduct(await platform.product(pid)),
        definitions,
        plans,
        planUsage: plans.map((p) => ({
          id: p.id,
          licenseCount: licenses.filter((l) => l.plan === p.id).length,
          activeLicenseCount: licenses.filter(
            (l) => l.plan === p.id && platform.status(l) === "active",
          ).length,
        })),
        usage: definitions.map((d) => ({
          name: d.id,
          types: [
            ...new Set(
              licenses
                .filter((l) => d.id in l.entitlements)
                .map((l) => typeof l.entitlements[d.id]),
            ),
          ],
          licenseCount: licenses.filter((l) => d.id in l.entitlements).length,
          activeLicenseCount: licenses.filter(
            (l) => d.id in l.entitlements && platform.status(l) === "active",
          ).length,
          plans: plans.filter((p) => d.id in p.entitlements).map((p) => p.id),
        })),
        licensesScanned: licenses.length,
        keyStorageEnabled: Boolean(platform.vault.ring),
      };
    }, true),
  );
  for (const kind of ["definition", "plan"] as const) {
    app.put(
      ap + "/" + kind + "s/:id",
      wrap(
        async (req) => {
          const input = (kind === "definition" ? definitionSchema : planSchema).parse(req.body);
          if (input.id !== req.params.id)
            throw new DomainError("bad_request", "Record ID cannot change.");
          await atomic(options.database, async (records) => {
            const prior = await records.get<any>(scope(req.params.productId), kind, input.id);
            if (prior && input.revision === undefined)
              throw new DomainError("revision_required", "Reload the record before editing.", 409);
            if (kind === "definition") {
              const def = input as Definition;
              if (
                def.minimum !== undefined &&
                def.maximum !== undefined &&
                def.minimum > def.maximum
              )
                throw new DomainError("bad_definition", "Minimum exceeds maximum.");
              const used =
                (await records.list<Grant>(scope(req.params.productId), "license")).some(
                  (l) => input.id in l.entitlements,
                ) ||
                (await records.list<Plan>(scope(req.params.productId), "plan")).some(
                  (p) => input.id in p.entitlements,
                );
              if (prior && used && prior.type !== def.type)
                throw new DomainError(
                  "definition_in_use",
                  "A used entitlement cannot change type.",
                  409,
                );
              if (def.defaultValue !== undefined && typeof def.defaultValue !== def.type)
                throw new DomainError("bad_definition", "Default must match the type.");
            } else
              await platform.validateEntitlements(
                req.params.productId,
                (input as Plan).entitlements,
                records,
              );
            if (kind === "plan")
              await platform.savePlan(req.params.productId, input as Plan, records, input.revision);
            else await records.put(scope(req.params.productId), kind, input, input.revision);
          });
          await platform.audit(req.actor, kind + ".save", req.params.productId, { id: input.id });
          return {
            record: await platform.records.get(scope(req.params.productId), kind, input.id),
          };
        },
        true,
        true,
      ),
    );
  }
  const issueSchema = z
    .object({
      requestId: z.string().uuid(),
      plan: idSchema,
      planRevision: z.number().int().optional(),
      expectedPrice: money.optional(),
      issuedTo: z.string().trim().max(200).default(""),
      installationId: idSchema.optional(),
      licenseRequestId: z.string().uuid().optional(),
      subjectKind: z.enum(["installation", "service"]).default("installation"),
      payment: paymentFields.optional(),
    })
    .strict()
    .refine((v) => !(v.installationId && v.licenseRequestId), "Choose one delivery recipient.");
  const safeLicense = ({ encryptedKey: _key, keyHash: _hash, ...license }: Grant) => ({
    ...license,
    keyStored: Boolean(_key),
  });
  app.get(
    ap + "/reports",
    wrap(async (req) => {
      const query = reportQuerySchema.parse(req.query);
      if (query.type === "activations" && !options.config.registry.enabled)
        throw new DomainError("registry_disabled", "Registry reports are disabled.", 404);
      const pid = scope(req.params.productId);
      const licenses = await platform.records.list<Grant>(pid, "license");
      const kind =
        query.type === "usage"
          ? "usage"
          : query.type === "activations"
            ? "binding"
            : query.type === "support"
              ? "ticket"
              : null;
      const records = kind
        ? await platform.records.list<Ticket | ReportBinding | ReportUsage>(pid, kind)
        : [];
      return buildReport(query, licenses, records, platform.time());
    }, true),
  );
  app.get(
    ap + "/licenses",
    wrap(async (req) => {
      let licenses = await platform.records.list<Grant>(scope(req.params.productId), "license");
      const counts = { active: 0, expired: 0, revoked: 0 };
      for (const l of licenses) counts[platform.status(l)]++;
      if (req.query.status)
        licenses = licenses.filter((l) => platform.status(l) === req.query.status);
      const page = paged(licenses.map(safeLicense), req);
      return { licenses: page.values, total: page.total, counts };
    }, true),
  );
  app.post(
    ap + "/licenses",
    wrap(
      async (req, reply) => {
        const input = issueSchema.parse(req.body),
          pid = req.params.productId,
          s = scope(pid);
        const fingerprint = hash(JSON.stringify(input));
        const result = await atomic(options.database, async (records) => {
          const old = await records.get<any>(s, "issuance", input.requestId);
          if (old) {
            if (old.fingerprint !== fingerprint || old.actor !== req.actor)
              throw new DomainError(
                "idempotency_conflict",
                "Request ID already used for a different issuance.",
                409,
              );
            return {
              license: (await records.get<Grant>(s, "license", old.licenseId))!,
              replayed: true,
            };
          }
          if (await records.get(s, "sale", input.requestId))
            throw new DomainError(
              "idempotency_conflict",
              "This transaction ID has already been used.",
              409,
            );
          const plan = await records.get<Plan>(s, "plan", input.plan);
          if (!plan || plan.archived)
            throw new DomainError("unknown_plan", "Choose an active plan.");
          const price = await planPrice(records, s, plan.id);
          if (price === null)
            throw new DomainError(
              "price_required",
              "Set this plan's price before issuing a license.",
            );
          if (
            (input.planRevision !== undefined && input.planRevision !== plan.revision) ||
            (input.expectedPrice !== undefined && input.expectedPrice !== price)
          )
            throw new DomainError(
              "revision_conflict",
              "The plan or price changed. Reload before issuing.",
              409,
            );
          const request = input.licenseRequestId
            ? await records.get<LicenseRequest>(
                WORKSPACE,
                "license_request",
                input.licenseRequestId,
              )
            : null;
          if (
            input.licenseRequestId &&
            (!request || request.productId !== pid || request.status !== "requested")
          )
            throw new DomainError(
              "invalid_license_request",
              "Choose an unissued request for this product.",
              409,
            );
          const installation = input.installationId
            ? await records.get<Installation>(s, "installation", input.installationId)
            : null;
          if (input.installationId && !installation?.credentialHash)
            throw new DomainError(
              "invalid_recipient",
              "Choose a registered customer installation.",
            );
          const issuedTo =
            request?.name ||
            installation?.userName ||
            installation?.userEmail ||
            input.issuedTo ||
            installation?.id;
          if (!issuedTo)
            throw new DomainError(
              "customer_required",
              "Select a customer or enter the customer name.",
            );
          await platform.validateEntitlements(pid, plan.entitlements, records);
          const time = platform.time(),
            date = time.slice(0, 10),
            id = randomUUID(),
            key = generateProductKey(options.config.key);
          if (input.payment && input.payment.date !== date)
            throw new DomainError(
              "invalid_date",
              "The initial payment must use today's UTC sale date. Record other payments after issuance.",
            );
          if (input.payment && price === 0)
            throw new DomainError(
              "invalid_payment",
              "A complimentary license does not need a payment.",
            );
          const license: Grant = {
            id,
            productId: pid,
            keyHash: hashProductKey(key),
            keyReference: key.slice(0, key.indexOf("-")) + "-…" + key.slice(-5),
            encryptedKey: platform.vault.encrypt(key, "license:" + pid + ":" + id),
            plan: plan.id,
            entitlements: plan.entitlements,
            issuedTo,
            status: "active",
            subjectKind: input.subjectKind,
            issuedAt: time,
            revokedAt: null,
            activationLimit: plan.activationLimit,
            expiresAt: plan.durationDays
              ? new Date(options.now().getTime() + plan.durationDays * 86400000).toISOString()
              : null,
          };
          const product = await platform.product(pid, records);
          if (product.importPolicy) {
            if (plan.activationLimit !== 1 || input.subjectKind !== "installation")
              throw new DomainError(
                "single_installation_required",
                "Import licensing requires one installation seat.",
              );
            const account: ImportAccount = {
              id: randomUUID(),
              licenseId: id,
              granted: importUnits(plan, product.importPolicy.entitlement),
              authorizationRevision: 1,
              recoveryGeneration: 0,
              ownerInstallationId: null,
            };
            license.importAccountId = account.id;
            await records.put(s, "import_account", account);
            await recordImportEvent(records, pid, {
              id: input.requestId,
              kind: "initial",
              accountId: account.id,
              added: account.granted,
              actor: req.actor,
              createdAt: time,
            });
          }
          license.revision = await records.put(s, "license", license);
          const sale: Sale = {
            id: input.requestId,
            requestId: input.requestId,
            licenseId: id,
            kind: "initial",
            date,
            listAmount: price,
            discount: 0,
            amount: price,
            currency: "ETB",
            dueDate: null,
            note: "",
            customer: issuedTo,
            plan: plan.id,
            actor: req.actor,
            createdAt: time,
          };
          await records.put(s, "sale", sale);
          if (input.payment)
            await records.put<Entry>(s, "financial_entry", {
              id: input.requestId,
              requestId: input.requestId,
              saleId: sale.id,
              kind: "payment",
              amount: price,
              ...input.payment,
              paymentId: null,
              reason: "",
              actor: req.actor,
              createdAt: time,
            });
          await records.put<LicenseDelivery>(s, "license_delivery", {
            id,
            licenseId: id,
            installationId: input.installationId ?? null,
            requestId: request?.id ?? null,
            status: input.installationId || request ? "available" : "manual",
            createdAt: time,
            retrievedAt: null,
            error: null,
          });
          if (request)
            await records.put(WORKSPACE, "license_request", {
              ...request,
              status: "issued",
              licenseId: id,
            });
          await records.put(s, "issuance", {
            id: input.requestId,
            fingerprint,
            actor: req.actor,
            licenseId: id,
          });
          return { license, replayed: false };
        });
        if (!result.replayed)
          await platform.audit(req.actor, "license.issue", pid, {
            licenseId: result.license.id,
            saleId: input.requestId,
          });
        const sale = (await platform.records.get<Sale>(s, "sale", input.requestId))!;
        const entries = await platform.records.list<Entry>(s, "financial_entry");
        const delivery = await platform.records.get<LicenseDelivery>(
          s,
          "license_delivery",
          result.license.id,
        );
        return reply
          .header("Cache-Control", "no-store")
          .code(201)
          .send({
            license: safeLicense(result.license),
            key: platform.vault.decrypt(
              result.license.encryptedKey!,
              "license:" + pid + ":" + result.license.id,
            ),
            sale: { ...sale, ...balance(sale, entries) },
            delivery,
          });
      },
      true,
      true,
    ),
  );
  app.get(
    ap + "/licenses/:id",
    wrap(async (req) => {
      const license = await platform.records.get<Grant>(
        scope(req.params.productId),
        "license",
        req.params.id,
      );
      if (!license) throw new DomainError("unknown_license", "No such license.", 404);
      return { license: safeLicense(license) };
    }, true),
  );
  app.patch(
    ap + "/licenses/:id",
    wrap(
      async (req) => {
        const input = z
          .object({
            issuedTo: z.string().max(200).optional(),
            entitlements: entitlementsSchema.optional(),
            activationLimit: z.number().int().positive().optional(),
            expiresAt: timestamp.nullable().optional(),
            revision: z.number().int(),
          })
          .strict()
          .parse(req.body);
        await atomic(options.database, async (records) => {
          const license = await records.get<Grant>(
            scope(req.params.productId),
            "license",
            req.params.id,
          );
          if (!license) throw new DomainError("unknown_license", "No such license.", 404);
          if (
            license.importAccountId &&
            (input.entitlements !== undefined ||
              input.activationLimit !== undefined ||
              input.expiresAt !== undefined)
          )
            throw new DomainError(
              "use_license_renewal",
              "Use renewal, top-up or extension for import-account terms.",
              409,
            );
          if (input.entitlements)
            await platform.validateEntitlements(req.params.productId, input.entitlements, records);
          await records.put(
            scope(req.params.productId),
            "license",
            { ...license, ...input },
            input.revision,
          );
          await bumpImportRevision(records, req.params.productId, license);
        });
        await platform.audit(req.actor, "license.update", req.params.productId, {
          licenseId: req.params.id,
        });
        return {
          license: safeLicense(
            (await platform.records.get<Grant>(
              scope(req.params.productId),
              "license",
              req.params.id,
            ))!,
          ),
        };
      },
      true,
      true,
    ),
  );
  app.post(
    ap + "/licenses/:id/revoke",
    wrap(
      async (req) => {
        await atomic(options.database, async (records) => {
          const license = await records.get<Grant>(
            scope(req.params.productId),
            "license",
            req.params.id,
          );
          if (!license) throw new DomainError("unknown_license", "No such license.", 404);
          await records.put(scope(req.params.productId), "license", {
            ...license,
            status: "revoked",
            revokedAt: platform.time(),
          } as Grant);
          await bumpImportRevision(records, req.params.productId, license);
        });
        await platform.audit(req.actor, "license.revoke", req.params.productId, {
          licenseId: req.params.id,
        });
        return { ok: true };
      },
      true,
      true,
    ),
  );
  app.post(
    ap + "/licenses/:id/key",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    wrap(
      async (req, reply) => {
        await platform.reauthenticate(req, req.actor);
        const license = await platform.records.get<Grant>(
          scope(req.params.productId),
          "license",
          req.params.id,
        );
        if (!license) throw new DomainError("unknown_license", "No such license.", 404);
        z.object({ password: z.string().optional() })
          .strict()
          .parse(req.body ?? {});
        if (!license.encryptedKey)
          throw new DomainError(
            "original_key_unavailable",
            "Stored key unavailable. Restore a current backup or explicitly replace the key.",
            404,
          );
        await platform.audit(req.actor, "license.key.reveal", req.params.productId, {
          licenseId: license.id,
        });
        reply.header("Cache-Control", "no-store");
        return {
          key: platform.vault.decrypt(
            license.encryptedKey,
            "license:" + req.params.productId + ":" + license.id,
          ),
        };
      },
      true,
      true,
    ),
  );
  app.get(
    ap + "/licenses/:id/activations",
    wrap(async (req) => {
      const machines = await platform.records.list<Machine>(scope(req.params.productId), "machine");
      const installations = await platform.records.list<Installation>(
        scope(req.params.productId),
        "installation",
      );
      return {
        activations: (await platform.records.list<Binding>(scope(req.params.productId), "binding"))
          .filter((b) => b.licenseId === req.params.id)
          .map((b) => ({
            ...b,
            ...deviceSummary(
              machines,
              b.installationId,
              installations.find((i) => i.id === b.installationId)?.machineSignals,
            ),
          })),
      };
    }, true),
  );
  app.post(
    ap + "/licenses/:id/deactivate",
    wrap(async (req) => {
      const iid = idSchema.parse(req.body?.installationId);
      await atomic(options.database, async (records) => {
        const binding = await records.get<Binding>(
          scope(req.params.productId),
          "binding",
          req.params.id + ":" + iid,
        );
        if (binding)
          await records.put(scope(req.params.productId), "binding", {
            ...binding,
            deactivatedAt: platform.time(),
          } as Binding);
      });
      await platform.audit(req.actor, "license.deactivate", req.params.productId, {
        licenseId: req.params.id,
        installationId: iid,
      });
      return { ok: true };
    }, true),
  );
  app.get(
    ap + "/installations",
    wrap(async (req) => {
      const all = await platform.records.list<Installation>(
        scope(req.params.productId),
        "installation",
      );
      const bindings = await platform.records.list<Binding>(scope(req.params.productId), "binding");
      const grants = await platform.records.list<Grant>(scope(req.params.productId), "license");
      const machines = await platform.records.list<Machine>(scope(req.params.productId), "machine");
      const rows = all.map(({ credentialHash: _secret, machineSignals, id, ...i }) => ({
        ...i,
        ...deviceSummary(machines, id, machineSignals),
        installationId: id,
        licenses: bindings
          .filter((b) => b.installationId === id)
          .map((b) => ({
            ...b,
            keyReference: grants.find((l) => l.id === b.licenseId)?.keyReference,
            status: grants.find((l) => l.id === b.licenseId)
              ? platform.status(grants.find((l) => l.id === b.licenseId)!)
              : "unknown",
          })),
        activeLicense: bindings.some(
          (b) =>
            b.installationId === id &&
            !b.deactivatedAt &&
            grants.some((l) => l.id === b.licenseId && platform.status(l) === "active"),
        ),
      }));
      const page = paged(
        rows.filter(
          (i) => !req.query.licensed || i.activeLicense === (req.query.licensed === "yes"),
        ),
        req,
      );
      return {
        installations: page.values,
        total: page.total,
        counts: {
          total: all.length,
          licensed: rows.filter((i) => i.activeLicense).length,
          unlicensed: rows.filter((i) => !i.activeLicense).length,
          licensesIssued: grants.length,
        },
      };
    }, true),
  );
  app.get(
    ap + "/machines",
    wrap(async (req) => {
      const machines = await platform.records.list<Machine>(scope(req.params.productId), "machine");
      const page = paged(
        machines.map(({ signals, ...m }) => ({
          ...m,
          trialState: m.clearedAtCount === m.registrationCount ? "fresh" : "spent",
          signalKinds: [...new Set(signals.map((s) => s.kind))],
          signalAvailability: signalAvailability(signals.map((s) => s.kind)),
        })),
        req,
      );
      return { machines: page.values, total: page.total };
    }, true),
  );
  app.post(
    ap + "/machines/:id/clear",
    wrap(async (req) => {
      await atomic(options.database, async (records) => {
        const machine = await records.get<Machine>(
          scope(req.params.productId),
          "machine",
          req.params.id,
        );
        if (!machine) throw new DomainError("unknown_machine", "No such machine.", 404);
        await records.put(scope(req.params.productId), "machine", {
          ...machine,
          clearedAtCount: machine.registrationCount,
          clearedAt: platform.time(),
        } as Machine);
      });
      await platform.audit(req.actor, "machine.clear", req.params.productId, {
        machineId: req.params.id,
      });
      return { machine: { id: req.params.id, clearedAt: platform.time() } };
    }, true),
  );
  app.post(
    device + "/register",
    limited(options.config.limits.register),
    wrap(async (req) => {
      const input = z
        .object({
          installationId: idSchema,
          requestId: z.string().uuid(),
          appVersion: z.string().max(50).default(""),
          platform: z.string().max(100).default(""),
          userName: z.string().max(200).default(""),
          userEmail: z.string().max(200).default(""),
          machineSignals: z.unknown().optional(),
        })
        .strict()
        .parse(req.body);
      const secret = bearer(req);
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret))
        throw new DomainError(
          "bad_credential",
          "Use a random 256-bit base64url installation credential.",
        );
      return atomic(options.database, async (records) => {
        const pid = req.params.productId;
        const product = await platform.product(pid, records);
        const prior = await records.get<Installation>(
          scope(pid),
          "installation",
          input.installationId,
        );
        if (prior && prior.credentialHash !== hash(secret))
          throw new DomainError(
            "installation_unauthorized",
            "Existing identity cannot be claimed. Register a new installation ID.",
            401,
          );
        const replayId = input.installationId + ":" + input.requestId;
        const replay = await records.get<any>(scope(pid), "registration", replayId);
        if (replay) {
          if (replay.hash !== hash(JSON.stringify(input)))
            throw new DomainError(
              "idempotency_conflict",
              "Request ID already used with different content.",
              409,
            );
          return replay.response;
        }
        await records.put(scope(pid), "installation", {
          id: input.installationId,
          credentialHash: hash(secret),
          registeredAt: prior?.registeredAt ?? platform.time(),
          lastSeenAt: platform.time(),
          appVersion: options.config.registry.enabled ? input.appVersion : "",
          platform: options.config.registry.enabled ? input.platform : "",
          userName:
            options.config.registry.enabled && options.config.registry.collectUserInfo
              ? input.userName
              : "",
          userEmail:
            options.config.registry.enabled && options.config.registry.collectUserInfo
              ? input.userEmail
              : "",
          licenseId: prior?.licenseId ?? null,
          trialConvertedAt: prior?.trialConvertedAt ?? null,
          importAccountId: prior?.importAccountId ?? null,
          machineSignals: normalizeSignals(input.machineSignals),
          signalsUpdatedAt: platform.time(),
        } as Installation);
        const signals = normalizeSignals(input.machineSignals);
        const machines = await records.list<Machine>(scope(pid), "machine");
        const evidence = signals.filter(
          (s) =>
            machines.filter((m) => m.signals.some((ms) => ms.kind === s.kind && ms.hash === s.hash))
              .length <= 3,
        );
        const match = pickMatch(
          machines.map((m) => ({
            groupId: m.id,
            firstRegisteredAt: m.firstRegisteredAt,
            matchingKinds: new Set(
              evidence
                .filter((s) => m.signals.some((ms) => ms.kind === s.kind && ms.hash === s.hash))
                .map((s) => s.kind),
            ).size,
          })),
        );
        const knownMachine = machines
          .filter((m) => m.installationIds.includes(input.installationId))
          .sort((a, b) => a.firstRegisteredAt.localeCompare(b.firstRegisteredAt))[0];
        let machine =
          knownMachine ?? (match ? machines.find((m) => m.id === match.groupId)! : null);
        const converted = Boolean(prior?.trialConvertedAt);
        const verdict = converted
          ? "spent"
          : !machine || machine.clearedAtCount === machine.registrationCount
            ? "fresh"
            : "spent";
        machine ??= {
          id: randomUUID(),
          signals: [],
          installationIds: [],
          supportReference: newSupportReference(),
          registrationCount: 0,
          clearedAtCount: null,
          clearedAt: null,
          firstRegisteredAt: platform.time(),
          lastRegisteredAt: platform.time(),
        };
        machine.signals = normalizeSignals([...machine.signals, ...signals]);
        machine.installationIds = [...new Set([...machine.installationIds, input.installationId])];
        machine.registrationCount++;
        machine.lastRegisteredAt = platform.time();
        machine.signalsUpdatedAt = platform.time();
        await records.put(scope(pid), "machine", machine);
        const response = {
          ok: true,
          recorded: options.config.registry.enabled,
          serverTime: platform.time(),
          trial: product.trial.enabled
            ? {
                token: platform.sign(product, {
                  v: 1,
                  kind: "trial",
                  iss: "default",
                  productId: pid,
                  kid: product.keys.find((k) => !k.retiredAt && !k.pending)!.kid,
                  installationId: input.installationId,
                  verdict,
                  allowance: verdict === "fresh" ? product.trial.allowance : 0,
                  issuedAt: platform.time(),
                  expiresAt: product.trial.durationDays
                    ? new Date(
                        options.now().getTime() + product.trial.durationDays * 86400000,
                      ).toISOString()
                    : null,
                  supportReference: verdict === "spent" ? machine.supportReference : null,
                  converted,
                }),
              }
            : null,
        };
        await records.put(scope(pid), "registration", {
          id: replayId,
          hash: hash(JSON.stringify(input)),
          response,
        } as RecordValue);
        return response;
      });
    }),
  );
  app.put(
    device + "/installations/:installationId/device-signals",
    limited(options.config.limits.register),
    wrap(async (req) => {
      const input = z
        .object({
          machineSignals: z
            .array(
              z
                .object({
                  kind: z.enum(SIGNAL_KINDS),
                  hash: z.string().regex(/^[a-f0-9]{64}$/),
                })
                .strict(),
            )
            .max(3),
        })
        .strict()
        .parse(req.body);
      return atomic(options.database, async (records) => {
        const pid = req.params.productId;
        const installation = await platform.authenticate(
          pid,
          req.params.installationId,
          bearer(req),
          records,
        );
        await platform.product(pid, records);
        const machines = await records.list<Machine>(scope(pid), "machine");
        // Anchor by authenticated identity only: backfill must never merge or transfer groups.
        const existing = machines.filter((m) => m.installationIds.includes(installation.id));
        const groups: Machine[] = existing.length
          ? existing
          : [
              {
                id: randomUUID(),
                supportReference: newSupportReference(),
                signals: [],
                installationIds: [installation.id],
                registrationCount: 0,
                clearedAtCount: null,
                clearedAt: null,
                firstRegisteredAt: installation.registeredAt,
                lastRegisteredAt: installation.registeredAt,
              },
            ];
        for (const group of groups)
          await records.put(scope(pid), "machine", {
            ...group,
            signals: normalizeSignals([...group.signals, ...input.machineSignals]),
            signalsUpdatedAt: platform.time(),
          } as Machine);
        await records.put(scope(pid), "installation", {
          ...installation,
          machineSignals: input.machineSignals,
          signalsUpdatedAt: platform.time(),
        } as Installation);
        return { ok: true, serverTime: platform.time() };
      });
    }),
  );
  for (const operation of ["validate", "activate", "refresh", "deactivate"] as const) {
    app.post(
      device + "/" + operation,
      ["activate", "validate"].includes(operation)
        ? limited(
            operation === "activate"
              ? options.config.limits.activate
              : options.config.limits.validate,
          )
        : { config: { rateLimit: false } },
      wrap(async (req) => {
        const input = z
          .object({
            installationId: idSchema,
            key: z.string().min(1).optional(),
            licenseId: idSchema.optional(),
          })
          .strict()
          .parse(req.body);
        const pid = req.params.productId;
        return atomic(options.database, async (records) => {
          const installation = await platform.authenticate(
            pid,
            input.installationId,
            bearer(req),
            records,
          );
          const product = await platform.product(pid, records);
          const licenses = await records.list<Grant>(scope(pid), "license");
          const license = input.key
            ? licenses.find((l) => l.keyHash === hashProductKey(input.key!))
            : licenses.find((l) => l.id === input.licenseId);
          if (!license)
            throw new DomainError(
              input.key ? "unknown_key" : "unknown_license",
              "License was not recognised.",
              404,
            );
          const bindings = await records.list<Binding>(scope(pid), "binding");
          const id = license.id + ":" + input.installationId;
          const existing = bindings.find((b) => b.id === id);
          if (operation === "deactivate") {
            if (existing)
              await records.put(scope(pid), "binding", {
                ...existing,
                deactivatedAt: platform.time(),
              } as Binding);
            return { ok: true, serverTime: platform.time() };
          }
          if (operation === "refresh" && (!existing || existing.deactivatedAt))
            throw new DomainError(
              "not_activated_here",
              "Reactivate this license on this installation.",
              403,
            );
          if (operation !== "refresh" && platform.status(license) !== "active")
            throw new DomainError(
              "license_" + platform.status(license),
              "This license is " + platform.status(license) + ".",
              410,
            );
          const seatsInUse = bindings.filter(
            (b) => b.licenseId === license.id && !b.deactivatedAt,
          ).length;
          if (operation === "validate")
            return {
              valid: true,
              ...safeLicense(license),
              seatsInUse,
              seatsAvailable: Math.max(0, license.activationLimit - seatsInUse),
              serverTime: platform.time(),
            };
          if (operation === "activate") {
            if (!input.key)
              throw new DomainError("key_required", "Product key is required to activate.");
            if ((!existing || existing.deactivatedAt) && seatsInUse >= license.activationLimit)
              throw new DomainError(
                "activation_limit_reached",
                "Release an existing seat or contact support.",
                409,
              );
            const account = await importAccount(records, pid, license);
            if (account) {
              if (installation.importAccountId && installation.importAccountId !== account.id)
                throw new DomainError(
                  "account_mismatch",
                  "Renew the existing import account instead of activating a separate budget.",
                  409,
                );
              if (
                account.ownerInstallationId &&
                account.ownerInstallationId !== input.installationId
              )
                throw new DomainError(
                  "recovery_required",
                  "An operator-approved recovery is required to transfer this usage account.",
                  409,
                );
              account.ownerInstallationId = input.installationId;
              if (!existing || existing.deactivatedAt) account.authorizationRevision++;
              await records.put(scope(pid), "import_account", account);
              installation.importAccountId = account.id;
            }
            await records.put(scope(pid), "binding", {
              id,
              licenseId: license.id,
              installationId: input.installationId,
              activatedAt: existing?.activatedAt ?? platform.time(),
              deactivatedAt: null,
            } as Binding);
            installation.licenseId = license.id;
          }
          installation.trialConvertedAt ??= platform.time();
          installation.lastSeenAt = platform.time();
          await records.put(scope(pid), "installation", installation);
          return {
            token: await platform.token(product, license, input.installationId, records),
            serverTime: platform.time(),
          };
        });
      }),
    );
  }
  app.post(
    ap + "/diagnostics",
    wrap(async (req) => {
      const input = z
        .object({ token: z.string().min(1).max(65536) })
        .strict()
        .parse(req.body);
      const parts = input.token.split(".");
      if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
        throw new DomainError("malformed_token", "Expected two nonempty base64url segments.");
      let payload: any;
      try {
        payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      } catch {
        throw new DomainError("malformed_token", "Payload is not valid JSON.");
      }
      const product = await platform.product(req.params.productId);
      const key = product.keys.find((k) => k.kid === payload?.kid);
      const verified = Boolean(key && verifyLicenseToken(input.token, key.publicKeyPem).valid);
      const shape =
        payload?.productId === product.id && productTokenSchema.safeParse(payload).success;
      const grant = payload?.licenseId
        ? await platform.records.get<Grant>(scope(product.id), "license", payload.licenseId)
        : null;
      const binding = grant
        ? await platform.records.get<Binding>(
            scope(product.id),
            "binding",
            grant.id + ":" + payload.installationId,
          )
        : null;
      return {
        payload,
        signatureValid: verified,
        schemaValid: Boolean(shape),
        currentAuthorization:
          verified && shape && grant && binding && !binding.deactivatedAt
            ? platform.status(grant)
            : "not_authorized",
        serverTime: platform.time(),
      };
    }, true),
  );
  registerLicenseDelivery(app, platform, wrap, ap, device, bearer);
  registerImportLicensing(app, platform, wrap, ap, device, bearer);
  registerFinance(app, platform, wrap, ap);
  registerNotifications(app, platform, wrap, ap, device, bearer);
  await registerSupport(app, platform, wrap, ap, device, bearer, paged);
  await registerMetering(app, platform, wrap, ap, device, bearer);
  return platform;
}

async function registerSupport(
  app: FastifyInstance,
  p: Platform,
  wrap: any,
  ap: string,
  device: string,
  bearer: any,
  paged: any,
) {
  const publicTicket = (ticket: Ticket) => ({
    ...ticket,
    assignedTo: undefined,
    messages: ticket.messages
      .filter((m) => !m.internal)
      .map((m) => ({ ...m, author: m.author === "customer" ? "customer" : "support" })),
  });
  app.get(
    ap + "/support",
    wrap(async (req: any) => {
      const tickets = (await p.records.list<Ticket>(scope(req.params.productId), "ticket"))
        .filter(
          (t) =>
            (!req.query.category || t.category === req.query.category) &&
            (!req.query.urgency || t.urgency === req.query.urgency) &&
            (!req.query.status || t.status === req.query.status),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const reads = new Map(
        (await p.records.list<any>(scope(req.params.productId), "conversation_read"))
          .filter((v) => v.actor === req.actor)
          .map((v) => [v.ticketId, v.lastMessageId]),
      );
      const page = paged(
        tickets
          .map(({ message: _m, messages: _ms, ...t }) => ({
            ...t,
            preview: (_ms.at(-1)?.body ?? _m).slice(0, 180),
            previewInternal: _ms.at(-1)?.internal ?? false,
            unread: reads.get(t.id) !== (_ms.at(-1)?.id ?? "original"),
            needsAttention:
              !["closed", "resolved"].includes(t.status) &&
              (!_ms.filter((m) => !m.internal).at(-1) ||
                _ms.filter((m) => !m.internal).at(-1)?.author === "customer"),
          }))
          .filter(
            (t) =>
              !req.query.view ||
              req.query.view === "all" ||
              (req.query.view === "unread" && t.unread) ||
              (req.query.view === "attention" && t.needsAttention) ||
              (req.query.view === "unassigned" && !t.assignedTo) ||
              (req.query.view === "mine" && t.assignedTo === req.actor),
          ),
        req,
      );
      return { requests: page.values, total: page.total };
    }, true),
  );
  app.get(
    ap + "/support/:id",
    wrap(async (req: any) => {
      const ticket = await p.records.get<Ticket>(
        scope(req.params.productId),
        "ticket",
        req.params.id,
      );
      if (!ticket) throw new DomainError("unknown_support_request", "No such request.", 404);
      return { request: ticket };
    }, true),
  );
  app.post(
    ap + "/support/:id/read",
    wrap(async (req: any) => {
      const { lastMessageId } = z
        .object({ lastMessageId: z.string().max(200) })
        .strict()
        .parse(req.body);
      await atomic(p.options.database, async (r) => {
        const ticket = await r.get<Ticket>(scope(req.params.productId), "ticket", req.params.id);
        if (!ticket) throw new DomainError("unknown_support_request", "No such request.", 404);
        if (lastMessageId !== "original" && !ticket.messages.some((m) => m.id === lastMessageId))
          throw new DomainError("invalid_message", "No such message.");
        await r.put(scope(req.params.productId), "conversation_read", {
          id: JSON.stringify([req.actor, ticket.id]),
          actor: req.actor,
          ticketId: ticket.id,
          lastMessageId,
        });
      });
      return { ok: true };
    }, true),
  );
  app.patch(
    ap + "/support/:id",
    wrap(async (req: any) => {
      const input = z
        .object({
          revision: z.number().int(),
          status: z.enum(SUPPORT_STATES),
          assignedTo: z.string().nullable(),
        })
        .strict()
        .parse(req.body);
      if (input.assignedTo) {
        if (!p.options.auth)
          throw new DomainError("assignment_unavailable", "No operator directory configured.");
        const context = await p.options.auth.$context;
        const operator = (await context.adapter.findOne({
          model: "user",
          where: [{ field: "email", value: input.assignedTo }],
        })) as { role?: string; banned?: boolean } | null;
        if (!operator || operator.banned || !["admin", "support"].includes(operator.role ?? ""))
          throw new DomainError("invalid_assignee", "Choose an active admin or support operator.");
      }
      await atomic(p.options.database, async (records) => {
        const ticket = await records.get<Ticket>(
          scope(req.params.productId),
          "ticket",
          req.params.id,
        );
        if (!ticket) throw new DomainError("unknown_support_request", "No such request.", 404);
        await records.put(
          scope(req.params.productId),
          "ticket",
          { ...ticket, ...input, updatedAt: p.time() },
          input.revision,
        );
      });
      await p.audit(req.actor, "support.update", req.params.productId, {
        requestId: req.params.id,
        ...input,
      });
      return { ok: true };
    }, true),
  );
  const addMessage = async (req: any, customer: boolean) => {
    const input = z
      .object({
        requestId: z.string().uuid(),
        message: z.string().trim().min(1).max(5000),
        internal: z.boolean().default(false),
        revision: z.number().int(),
      })
      .strict()
      .parse(req.body);
    return atomic(p.options.database, async (records) => {
      const ticket = await records.get<Ticket>(
        scope(req.params.productId),
        "ticket",
        req.params.id,
      );
      if (!ticket) throw new DomainError("unknown_support_request", "No such request.", 404);
      if (customer) {
        await p.authenticate(req.params.productId, req.params.installationId, bearer(req), records);
        if (ticket.installationId !== req.params.installationId)
          throw new DomainError("unknown_support_request", "No such request.", 404);
        if (input.internal)
          throw new DomainError("bad_request", "Customers cannot submit internal notes.");
      }
      const prior = ticket.messages.find((m) => m.id === input.requestId);
      const author = customer ? "customer" : req.actor;
      if (prior) {
        if (
          prior.body !== input.message ||
          prior.internal !== input.internal ||
          prior.author !== author
        )
          throw new DomainError("idempotency_conflict", "Message ID already used.", 409);
        return { request: customer ? publicTicket(ticket) : ticket };
      }
      if (ticket.status === "closed")
        throw new DomainError("request_closed", "Create a new support request.", 409);
      ticket.messages.push({
        id: input.requestId,
        author,
        internal: input.internal,
        body: input.message,
        createdAt: p.time(),
      });
      if (customer && ["resolved", "waiting_customer"].includes(ticket.status))
        ticket.status = "queued";
      ticket.updatedAt = p.time();
      ticket.revision = await records.put(
        scope(req.params.productId),
        "ticket",
        ticket,
        input.revision,
      );
      return { request: customer ? publicTicket(ticket) : ticket };
    });
  };
  app.post(
    ap + "/support/:id/messages",
    wrap(async (req: any) => {
      const result = await addMessage(req, false);
      await p.audit(req.actor, "support.message", req.params.productId, {
        requestId: req.params.id,
        internal: req.body.internal === true,
      });
      return result;
    }, true),
  );
  const customer = device + "/installations/:installationId/support";
  app.get(
    customer,
    wrap(async (req: any) => {
      await p.authenticate(req.params.productId, req.params.installationId, bearer(req));
      return {
        requests: (await p.records.list<Ticket>(scope(req.params.productId), "ticket"))
          .filter((t) => t.installationId === req.params.installationId)
          .map(publicTicket),
      };
    }),
  );
  app.get(
    customer + "/:id",
    wrap(async (req: any) => {
      await p.authenticate(req.params.productId, req.params.installationId, bearer(req));
      const ticket = await p.records.get<Ticket>(
        scope(req.params.productId),
        "ticket",
        req.params.id,
      );
      if (!ticket || ticket.installationId !== req.params.installationId)
        throw new DomainError("unknown_support_request", "No such request.", 404);
      return { request: publicTicket(ticket) };
    }),
  );
  app.post(
    customer + "/:id/messages",
    wrap((req: any) => addMessage(req, true)),
  );
  app.post(
    customer,
    wrap(async (req: any, reply: FastifyReply) => {
      const { licenseId, ...body } = req.body ?? {};
      idSchema.parse(licenseId);
      const input = supportRequestBodySchema.parse(body);
      const normalized = normalizeSupportRequest(input);
      if (!normalized || req.headers["idempotency-key"] !== input.requestId)
        throw new DomainError(
          "invalid_support_request",
          "Invalid support content or Idempotency-Key.",
        );
      const result = await atomic(p.options.database, async (records) => {
        await p.authenticate(req.params.productId, req.params.installationId, bearer(req), records);
        const grant = await records.get<Grant>(scope(req.params.productId), "license", licenseId);
        const binding = await records.get<Binding>(
          scope(req.params.productId),
          "binding",
          licenseId + ":" + req.params.installationId,
        );
        if (
          !grant ||
          !binding ||
          (!["licensing", "billing"].includes(input.category) &&
            (p.status(grant) !== "active" || binding.deactivatedAt))
        )
          throw new DomainError(
            "paid_license_required",
            "This category requires an active license binding.",
            403,
          );
        const tickets = await records.list<Ticket>(scope(req.params.productId), "ticket");
        const prior = tickets.find(
          (t) =>
            t.licenseId === licenseId &&
            t.installationId === req.params.installationId &&
            t.clientRequestId === input.requestId,
        );
        if (prior) {
          if (
            JSON.stringify({
              category: prior.category,
              urgency: prior.urgency,
              subject: prior.subject,
              message: prior.message,
              reporterName: prior.reporterName,
              appVersion: prior.appVersion,
              platform: prior.platform,
              clientCreatedAt: prior.clientCreatedAt,
            }) !==
            JSON.stringify({
              category: normalized.category,
              urgency: normalized.urgency,
              subject: normalized.subject,
              message: normalized.message,
              reporterName: normalized.reporterName,
              appVersion: normalized.appVersion,
              platform: normalized.platform,
              clientCreatedAt: normalized.clientCreatedAt,
            })
          )
            throw new DomainError(
              "idempotency_conflict",
              "Request ID already used with different content.",
              409,
            );
          return prior;
        }
        const windowStart =
          p.options.now().getTime() - durationMs(p.options.config.limits.support.timeWindow);
        if (
          p.options.config.limits.enabled &&
          tickets.filter(
            (t) =>
              t.licenseId === licenseId &&
              t.installationId === req.params.installationId &&
              Date.parse(t.receivedAt) > windowStart,
          ).length >= p.options.config.limits.support.max
        )
          throw new DomainError(
            "support_rate_limited",
            "Support quota exceeded. Retry after " +
              p.options.config.limits.support.timeWindow +
              ".",
            429,
          );
        const ticket: Ticket = {
          id: "srv_" + randomUUID(),
          ...normalized,
          licenseId,
          installationId: req.params.installationId,
          status: "queued",
          assignedTo: null,
          messages: [],
          receivedAt: p.time(),
          updatedAt: p.time(),
        };
        await records.put(scope(req.params.productId), "ticket", ticket);
        return ticket;
      });
      return reply.code(202).send({
        request: {
          id: result.id,
          clientRequestId: result.clientRequestId,
          status: result.status,
          receivedAt: result.receivedAt,
        },
        serverTime: p.time(),
      });
    }),
  );
}

async function registerMetering(
  app: FastifyInstance,
  p: Platform,
  wrap: any,
  ap: string,
  device: string,
  bearer: any,
) {
  const meterSchema = z
    .object({
      id: slugSchema,
      entitlement: idSchema,
      period: z.enum(["lifetime", "daily", "monthly"]),
      description: z.string().max(500),
      archived: z.boolean().default(false),
      revision: z.number().int().optional(),
    })
    .strict();
  app.get(
    ap + "/meters",
    wrap(
      async (req: any) => ({
        meters: await p.records.list<Meter>(scope(req.params.productId), "meter"),
        usage: await p.records.list(scope(req.params.productId), "usage"),
      }),
      true,
    ),
  );
  app.put(
    ap + "/meters/:id",
    wrap(
      async (req: any) => {
        const input = meterSchema.parse(req.body);
        if (input.id !== req.params.id)
          throw new DomainError("bad_request", "Meter ID cannot change.");
        await atomic(p.options.database, async (records) => {
          const definition = await records.get<Definition>(
            scope(req.params.productId),
            "definition",
            input.entitlement,
          );
          if (!definition || definition.archived || definition.type !== "number")
            throw new DomainError("bad_meter", "Choose an active numeric entitlement.");
          const prior = await records.get<Meter>(scope(req.params.productId), "meter", input.id);
          if (prior && (prior.period !== input.period || prior.entitlement !== input.entitlement))
            throw new DomainError(
              "meter_in_use",
              "Create a new meter to change its period or entitlement.",
              409,
            );
          if (prior && input.revision === undefined)
            throw new DomainError("revision_required", "Reload before saving.", 409);
          await records.put(scope(req.params.productId), "meter", input, input.revision);
        });
        await p.audit(req.actor, "meter.save", req.params.productId, { meterId: input.id });
        return { ok: true };
      },
      true,
      true,
    ),
  );
  app.get(
    ap + "/credentials",
    wrap(
      async (req: any) => ({
        credentials: (await p.records.list<any>(scope(req.params.productId), "credential")).map(
          ({ secretHash: _secret, ...c }) => c,
        ),
      }),
      true,
      true,
    ),
  );
  app.post(
    ap + "/credentials",
    wrap(
      async (req: any) => {
        const input = z
          .object({
            name: z.string().trim().min(1).max(100),
            permissions: z.array(z.enum(["usage:read", "usage:consume"])).min(1),
          })
          .strict()
          .parse(req.body);
        const secret = randomBytes(32).toString("base64url");
        const id = randomUUID();
        await atomic(p.options.database, (records) =>
          records.put(scope(req.params.productId), "credential", {
            id,
            ...input,
            secretHash: hash(secret),
            createdAt: p.time(),
            revoked: false,
          } as RecordValue),
        );
        await p.audit(req.actor, "credential.create", req.params.productId, { id });
        return { id, secret };
      },
      true,
      true,
    ),
  );
  app.post(
    ap + "/credentials/:id/revoke",
    wrap(
      async (req: any) => {
        await atomic(p.options.database, async (records) => {
          const credential = await records.get<any>(
            scope(req.params.productId),
            "credential",
            req.params.id,
          );
          if (!credential) throw new DomainError("unknown_credential", "No such credential.", 404);
          await records.put(scope(req.params.productId), "credential", {
            ...credential,
            revoked: true,
          });
        });
        await p.audit(req.actor, "credential.revoke", req.params.productId, { id: req.params.id });
        return { ok: true };
      },
      true,
      true,
    ),
  );
  for (const operation of ["summary", "consume"] as const) {
    app.post(
      device + "/usage/" + operation,
      wrap(async (req: any) => {
        const input = z
          .object({
            licenseId: idSchema,
            meterId: idSchema,
            eventId: z.string().uuid().optional(),
            units: z.number().int().positive().safe().optional(),
          })
          .strict()
          .parse(req.body);
        return atomic(p.options.database, async (records) => {
          const pid = req.params.productId;
          const credential = (await records.list<any>(scope(pid), "credential")).find(
            (c) => !c.revoked && c.secretHash === hash(bearer(req)),
          );
          if (
            !credential?.permissions.includes(
              operation === "consume" ? "usage:consume" : "usage:read",
            )
          )
            throw new DomainError(
              "service_unauthorized",
              "A scoped service credential is required.",
              401,
            );
          const meter = await records.get<Meter>(scope(pid), "meter", input.meterId);
          const license = await records.get<Grant>(scope(pid), "license", input.licenseId);
          if (!meter || meter.archived || !license)
            throw new DomainError(
              "unknown_meter_or_license",
              "No such active meter or license.",
              404,
            );
          const quota = license.entitlements[meter.entitlement];
          if (
            p.status(license) !== "active" ||
            typeof quota !== "number" ||
            !Number.isSafeInteger(quota) ||
            quota < 0
          )
            throw new DomainError("usage_unauthorized", "No usable quota for this license.", 403);
          const period =
            meter.period === "lifetime"
              ? "lifetime"
              : p.time().slice(0, meter.period === "daily" ? 10 : 7);
          const usageId = license.id + ":" + meter.id + ":" + period;
          let usage = (await records.get<any>(scope(pid), "usage", usageId)) ?? {
            id: usageId,
            licenseId: license.id,
            meterId: meter.id,
            period,
            consumed: 0,
          };
          if (operation === "consume") {
            if (!input.eventId || !input.units)
              throw new DomainError(
                "bad_request",
                "eventId and positive integer units are required.",
              );
            const eventId = license.id + ":" + meter.id + ":" + input.eventId;
            const prior = await records.get<any>(scope(pid), "usage-event", eventId);
            if (prior) {
              if (prior.units !== input.units)
                throw new DomainError(
                  "idempotency_conflict",
                  "Event ID already used with different units.",
                  409,
                );
              return prior.response;
            }
            if (usage.consumed + input.units > quota)
              throw new DomainError("quota_exhausted", "Usage quota exhausted.", 409);
            usage.consumed += input.units;
            await records.put(scope(pid), "usage", usage);
            const response = {
              ...usage,
              quota,
              remaining: quota - usage.consumed,
              serverTime: p.time(),
            };
            await records.put(scope(pid), "usage-event", {
              id: eventId,
              units: input.units,
              response,
            } as RecordValue);
            return response;
          }
          return {
            ...usage,
            quota,
            remaining: Math.max(0, quota - usage.consumed),
            serverTime: p.time(),
          };
        });
      }),
    );
  }
}
