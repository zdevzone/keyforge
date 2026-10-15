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
    v: z.literal(4),
    licenseId: id,
    plan: id,
    entitlements: entitlementsSchema,
    issuedTo: z.string(),
    subject: z.object({ kind: z.enum(["installation", "service"]), id }).strict(),
    offlineGraceUntil: date,
    status: z.enum(["active", "revoked", "expired"]),
  })
  .strict()
  .refine((p) => p.subject.id === p.installationId);
export const trialTokenSchema = z
  .object({
    ...common,
    kind: z.literal("trial"),
    v: z.literal(2),
    verdict: z.enum(["fresh", "spent"]),
    allowance: z.number().int().nonnegative().nullable(),
    supportReference: z.string().nullable(),
  })
  .strict();
export const productTokenSchema = z.union([licenseTokenSchema, trialTokenSchema]);
