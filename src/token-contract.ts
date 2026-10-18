import { z } from "zod";

import { entitlementsSchema } from "./config.js";

const id = z.string().min(1).max(200);
const date = z.string().datetime({ offset: true });
const common = {
  iss: z.literal("default"),
  productId: id,
  kid: id,
  installationId: id,
  issuedAt: date,
  expiresAt: date.nullable(),
};
export const licenseTokenSchema = z
  .object({
    ...common,
    kind: z.literal("license"),
    v: z.literal(1),
    licenseId: id,
    plan: id,
    entitlements: entitlementsSchema,
    issuedTo: z.string(),
    subject: z.object({ kind: z.enum(["installation", "service"]), id }).strict(),
    offlineGraceUntil: date,
    status: z.enum(["active", "revoked", "expired"]),
    accountId: id.nullable(),
    authorizationRevision: z.number().int().positive().safe(),
    paidImportsGranted: z.number().int().nonnegative().safe().nullable(),
    recoveryGeneration: z.number().int().nonnegative().safe(),
    trialConverted: z.literal(true),
  })
  .strict()
  .refine((p) => p.subject.id === p.installationId)
  .refine((p) =>
    p.accountId === null
      ? p.paidImportsGranted === null && p.recoveryGeneration === 0
      : p.paidImportsGranted !== null && p.subject.kind === "installation",
  );
export const trialTokenSchema = z
  .object({
    ...common,
    kind: z.literal("trial"),
    v: z.literal(1),
    verdict: z.enum(["fresh", "spent"]),
    allowance: z.number().int().nonnegative().nullable(),
    supportReference: z.string().nullable(),
    converted: z.boolean(),
  })
  .strict();
export const recoveryTokenSchema = z
  .object({
    ...common,
    v: z.literal(1),
    kind: z.literal("usage-recovery"),
    recoveryId: z.string().uuid(),
    accountId: id,
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    mode: z.enum(["restore", "lost_history"]),
    usageDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    paidImportsFloor: z.number().int().nonnegative().safe(),
    trialImportsFloor: z.number().int().nonnegative().safe(),
    recoveryGeneration: z.number().int().positive().safe(),
    authorizationRevision: z.number().int().positive().safe(),
    expiresAt: date,
  })
  .strict();
export const productTokenSchema = z.union([licenseTokenSchema, trialTokenSchema]);
