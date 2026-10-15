import { randomBytes } from "node:crypto";

import { z } from "zod";

export const SUPPORT_CATEGORIES = [
  "technical",
  "licensing",
  "billing",
  "feature_request",
  "other",
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_URGENCIES = ["low", "normal", "high", "critical"] as const;
export type SupportUrgency = (typeof SUPPORT_URGENCIES)[number];

const optionalText = (max: number) => z.string().max(max).optional();

export const supportRequestBodySchema = z
  .object({
    requestId: z.string().uuid(),
    category: z.enum(SUPPORT_CATEGORIES),
    urgency: z.enum(SUPPORT_URGENCIES),
    subject: z.string(),
    message: z.string(),
    createdAt: z.string(),
    reporter: z
      .object({ name: optionalText(200) })
      .strict()
      .optional(),
    app: z
      .object({
        version: optionalText(50),
        platform: optionalText(100),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface NormalizedSupportRequest {
  clientRequestId: string;
  category: SupportCategory;
  urgency: SupportUrgency;
  subject: string;
  message: string;
  reporterName: string | null;
  appVersion: string | null;
  platform: string | null;
  clientCreatedAt: string;
}

function nullableTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

/** Normalize once before both persistence and idempotency comparison. */
export function normalizeSupportRequest(
  body: z.infer<typeof supportRequestBodySchema>,
): NormalizedSupportRequest | null {
  const subject = body.subject.trim();
  const message = body.message.trim();
  const createdAt = new Date(body.createdAt);
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    subject.length < 3 ||
    subject.length > 120 ||
    message.length < 10 ||
    message.length > 5_000 ||
    !isoTimestamp.test(body.createdAt) ||
    Number.isNaN(createdAt.getTime())
  ) {
    return null;
  }
  return {
    clientRequestId: body.requestId,
    category: body.category,
    urgency: body.urgency,
    subject,
    message,
    reporterName: nullableTrimmed(body.reporter?.name),
    appVersion: nullableTrimmed(body.app?.version),
    platform: nullableTrimmed(body.app?.platform),
    clientCreatedAt: createdAt.toISOString(),
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A standard 48-bit-time + 80-bit-randomness ULID with the service prefix. */
export function newSupportRequestId(at = Date.now()): string {
  let timestamp = at;
  let timePart = "";
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD[timestamp % 32] + timePart;
    timestamp = Math.floor(timestamp / 32);
  }
  let random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let randomPart = "";
  for (let index = 0; index < 16; index += 1) {
    randomPart = CROCKFORD[Number(random & 31n)] + randomPart;
    random >>= 5n;
  }
  return `srv_${timePart}${randomPart}`;
}
