import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { generateProductKey, hashProductKey } from "./db.js";
import { balance, money, paymentFields, planPrice, type Entry, type Sale } from "./finance.js";
import { atomic, DomainError, type Records, type RecordValue } from "./platform-store.js";
import type { Grant, Plan, Platform } from "./platform.js";
import { recoveryTokenSchema } from "./token-contract.js";

export interface ImportAccount extends RecordValue {
  licenseId: string;
  granted: number;
  authorizationRevision: number;
  recoveryGeneration: number;
  ownerInstallationId: string | null;
}
const units = z.number().int().nonnegative().safe();
const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(200);
const scope = (pid: string) => "product:" + pid;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function importUnits(plan: Pick<Plan, "entitlements">, entitlement: string) {
  const parsed = units.safeParse(plan.entitlements[entitlement]);
  if (!parsed.success)
    throw new DomainError(
      "invalid_import_allowance",
      "The plan needs a finite nonnegative safe-integer import allowance.",
    );
  return parsed.data;
}
export async function importAccount(records: Records, pid: string, grant: Grant) {
  if (!grant.importAccountId) return null;
  const account = await records.get<ImportAccount>(
    scope(pid),
    "import_account",
    grant.importAccountId,
  );
  if (!account)
    throw new DomainError(
      "import_account_missing",
      "Restore the licensing account before authorizing imports.",
      503,
    );
  return account;
}
export async function bumpImportRevision(records: Records, pid: string, grant: Grant) {
  const account = await importAccount(records, pid, grant);
  if (account) {
    account.authorizationRevision = units.parse(account.authorizationRevision + 1);
    await records.put(scope(pid), "import_account", account);
  }
}
export async function recordImportEvent(
  records: Records,
  pid: string,
  value: RecordValue & Record<string, unknown>,
) {
  if (await records.get(scope(pid), "licensing_event", value.id))
    throw new DomainError("idempotency_conflict", "This operation ID has already been used.", 409);
  await records.put(scope(pid), "licensing_event", value);
}

/** Recognition and money never substitute for authorization. All writes use the existing ledger transaction. */
export function registerImportLicensing(
  app: FastifyInstance,
  p: Platform,
  wrap: any,
  ap: string,
  device: string,
  bearer: any,
) {
  const write = (fn: any) => wrap(fn, true, true);
  const license = async (r: Records, pid: string, id: string) => {
    const grant = await r.get<Grant>(scope(pid), "license", id);
    if (!grant) throw new DomainError("unknown_license", "No such license.", 404);
    return grant;
  };
  app.put(
    ap + "/import-policy",
    write(async (req: any) => {
      const input = z
        .object({ entitlement: z.string().min(1).max(64), revision: z.number().int() })
        .strict()
        .parse(req.body);
      return atomic(p.options.database, async (r) => {
        const product = await p.product(req.params.productId, r);
        const definition = await r.get<any>(scope(product.id), "definition", input.entitlement);
        if (!definition || definition.archived || definition.type !== "number")
          throw new DomainError("bad_entitlements", "Select an active numeric import entitlement.");
        if (product.importPolicy && product.importPolicy.entitlement !== input.entitlement)
          throw new DomainError(
            "policy_locked",
            "The configured import entitlement cannot be reassigned.",
            409,
          );
        await r.put(
          "workspace:default",
          "product",
          { ...product, importPolicy: { entitlement: input.entitlement } },
          input.revision,
        );
        await r.put(scope(product.id), "licensing_event", {
          id: randomUUID(),
          kind: "policy.enable",
          actor: req.actor,
          createdAt: p.time(),
          entitlement: input.entitlement,
        });
        return { ok: true };
      });
    }),
  );
  app.get(
    ap + "/licenses/:id/import-account",
    write(async (req: any) => {
      const grant = await license(p.records, req.params.productId, req.params.id);
      const account = await importAccount(p.records, req.params.productId, grant);
      return {
        account,
        events: (await p.records.list<any>(scope(req.params.productId), "licensing_event")).filter(
          (e) => e.accountId === account?.id,
        ),
      };
    }),
  );
  app.post(
    ap + "/licenses/:id/import-account",
    write(async (req: any) => {
      const input = z
        .object({
          requestId: uuid,
          revision: z.number().int(),
          granted: units,
          reason: z.string().trim().min(10).max(1000),
        })
        .strict()
        .parse(req.body);
      return atomic(p.options.database, async (r) => {
        const pid = req.params.productId,
          s = scope(pid),
          grant = await license(r, pid, req.params.id);
        const prior = await r.get<any>(s, "licensing_event", input.requestId);
        const fingerprint = digest({ ...input, licenseId: grant.id, actor: req.actor });
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new DomainError("idempotency_conflict", "Operation ID changed.", 409);
          return { account: await importAccount(r, pid, grant) };
        }
        if (
          grant.importAccountId ||
          grant.activationLimit !== 1 ||
          grant.subjectKind !== "installation" ||
          !(await p.product(pid, r)).importPolicy
        )
          throw new DomainError(
            "import_migration_required",
            "Enable policy and use a single-installation legacy license without an existing account.",
            409,
          );
        const bindings = (await r.list<any>(s, "binding")).filter((b) => b.licenseId === grant.id);
        if (new Set(bindings.map((b) => b.installationId)).size > 1)
          throw new DomainError(
            "import_migration_required",
            "Multiple historical installations require explicit operator reconciliation.",
            409,
          );
        const account: ImportAccount = {
          id: randomUUID(),
          licenseId: grant.id,
          granted: input.granted,
          authorizationRevision: 1,
          recoveryGeneration: 0,
          ownerInstallationId: bindings[0]?.installationId ?? null,
        };
        await r.put(s, "import_account", account);
        await r.put(s, "license", { ...grant, importAccountId: account.id }, input.revision);
        await recordImportEvent(r, pid, {
          id: input.requestId,
          kind: "legacy.adopt",
          accountId: account.id,
          actor: req.actor,
          fingerprint,
          reason: input.reason,
          createdAt: p.time(),
        });
        return { account };
      });
    }),
  );
  app.post(
    ap + "/licenses/:id/renew",
    write(async (req: any) => {
      const input = z
        .object({
          requestId: uuid,
          plan: text,
          mode: z.enum(["renewal", "top_up", "extension"]).default("renewal"),
          planRevision: z.number().int().optional(),
          expectedPrice: money.optional(),
          payment: paymentFields.optional(),
        })
        .strict()
        .parse(req.body);
      return atomic(p.options.database, async (r) => {
        const pid = req.params.productId,
          s = scope(pid),
          grant = await license(r, pid, req.params.id);
        const fingerprint = digest({ ...input, licenseId: grant.id, actor: req.actor });
        const old = await r.get<any>(s, "licensing_event", input.requestId);
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new DomainError("idempotency_conflict", "Operation ID changed.", 409);
          const sale = (await r.get<Sale>(s, "sale", input.requestId))!;
          return {
            account: await importAccount(r, pid, grant),
            licenseId: grant.id,
            sale: { ...sale, ...balance(sale, await r.list<Entry>(s, "financial_entry")) },
          };
        }
        if (await r.get(s, "sale", input.requestId))
          throw new DomainError("idempotency_conflict", "Transaction ID already used.", 409);
        const product = await p.product(pid, r),
          account = await importAccount(r, pid, grant);
        if (!account || !product.importPolicy || grant.status === "revoked")
          throw new DomainError(
            "renewal_unavailable",
            "Use an import-account license that has not been revoked.",
            409,
          );
        const plan = await r.get<Plan>(s, "plan", input.plan);
        if (!plan || plan.archived || plan.activationLimit !== 1)
          throw new DomainError("unknown_plan", "Select an active single-installation plan.");
        await p.validateEntitlements(pid, plan.entitlements, r);
        const price = await planPrice(r, s, plan.id);
        if (price === null) throw new DomainError("price_required", "Configure a plan price.");
        if (
          (input.planRevision !== undefined && plan.revision !== input.planRevision) ||
          (input.expectedPrice !== undefined && price !== input.expectedPrice)
        )
          throw new DomainError("revision_conflict", "The plan or price changed.", 409);
        const date = p.time().slice(0, 10);
        if (input.payment && (input.payment.date !== date || price === 0))
          throw new DomainError(
            "invalid_payment",
            "Initial receipt must be today and the sale must have positive value.",
          );
        const added =
          input.mode === "extension" ? 0 : importUnits(plan, product.importPolicy.entitlement);
        const granted = units.safeParse(account.granted + added);
        if (!granted.success)
          throw new DomainError(
            "invalid_import_allowance",
            "Cumulative allowance exceeds the supported integer range.",
          );
        let expiresAt = grant.expiresAt;
        if (input.mode !== "top_up") {
          if (plan.durationDays === null) expiresAt = null;
          else if (expiresAt !== null)
            expiresAt = new Date(
              Math.max(Date.parse(expiresAt), p.options.now().getTime()) +
                plan.durationDays * 86400000,
            ).toISOString();
        }
        account.granted = granted.data;
        account.authorizationRevision = units.parse(account.authorizationRevision + 1);
        await r.put(s, "import_account", account);
        await r.put(s, "license", { ...grant, expiresAt });
        const sale: Sale = {
          id: input.requestId,
          requestId: input.requestId,
          licenseId: grant.id,
          kind: input.mode,
          date,
          listAmount: price,
          discount: 0,
          amount: price,
          currency: "ETB",
          dueDate: null,
          note: "",
          customer: grant.issuedTo,
          plan: plan.id,
          actor: req.actor,
          createdAt: p.time(),
        };
        await r.put(s, "sale", sale);
        if (input.payment)
          await r.put<Entry>(s, "financial_entry", {
            id: input.requestId,
            requestId: input.requestId,
            saleId: sale.id,
            kind: "payment",
            amount: price,
            ...input.payment,
            paymentId: null,
            reason: "",
            actor: req.actor,
            createdAt: p.time(),
          });
        await recordImportEvent(r, pid, {
          id: input.requestId,
          kind: input.mode,
          accountId: account.id,
          added,
          actor: req.actor,
          fingerprint,
          createdAt: p.time(),
        });
        return {
          account,
          licenseId: grant.id,
          sale: { ...sale, ...balance(sale, await r.list<Entry>(s, "financial_entry")) },
        };
      });
    }),
  );
  app.post(
    ap + "/licenses/:id/replace-key",
    write(async (req: any) => {
      await p.reauthenticate(req, req.actor);
      const { password: _password, ...body } = req.body ?? {};
      const input = z
        .object({ requestId: uuid, reason: z.string().trim().min(10).max(1000) })
        .strict()
        .parse(body);
      return atomic(p.options.database, async (r) => {
        const pid = req.params.productId,
          s = scope(pid),
          grant = await license(r, pid, req.params.id);
        if (!grant.importAccountId)
          throw new DomainError(
            "import_account_required",
            "This operation requires an import account.",
          );
        const fingerprint = digest({ ...input, licenseId: grant.id, actor: req.actor });
        const old = await r.get<any>(s, "licensing_event", input.requestId);
        if (old && old.fingerprint !== fingerprint)
          throw new DomainError("idempotency_conflict", "Operation ID changed.", 409);
        if (!old) {
          const key = generateProductKey(p.options.config.key);
          grant.keyHash = hashProductKey(key);
          grant.keyReference = key.slice(0, key.indexOf("-")) + "-…" + key.slice(-5);
          grant.encryptedKey = p.vault.encrypt(key, "license:" + pid + ":" + grant.id);
          await r.put(s, "license", grant);
          await bumpImportRevision(r, pid, grant);
          await recordImportEvent(r, pid, {
            id: input.requestId,
            kind: "key.replace",
            accountId: grant.importAccountId,
            fingerprint,
            actor: req.actor,
            reason: input.reason,
            createdAt: p.time(),
          });
        }
        return {
          key: p.vault.decrypt(grant.encryptedKey!, "license:" + pid + ":" + grant.id),
          licenseId: grant.id,
        };
      });
    }),
  );

  const recovery = device + "/installations/:installationId/recovery-requests";
  app.post(
    recovery,
    wrap(async (req: any) => {
      const input = z
        .object({
          requestId: uuid,
          licenseId: text,
          challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          usageDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
        })
        .strict()
        .parse(req.body);
      return atomic(p.options.database, async (r) => {
        const pid = req.params.productId,
          s = scope(pid);
        await p.authenticate(pid, req.params.installationId, bearer(req), r);
        const grant = await license(r, pid, input.licenseId),
          account = await importAccount(r, pid, grant);
        if (!account) throw new DomainError("import_account_required", "No import account.");
        const id = req.params.installationId + ":" + input.requestId,
          fingerprint = digest(input);
        const old = await r.get<any>(s, "usage_recovery", id);
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new DomainError("idempotency_conflict", "Recovery request changed.", 409);
          return { id, status: old.status };
        }
        const pending = (await r.list<any>(s, "usage_recovery")).filter(
          (v) => v.installationId === req.params.installationId && v.status === "requested",
        );
        if (pending.length >= 5)
          throw new DomainError(
            "recovery_rate_limited",
            "Resolve existing recovery requests first.",
            429,
          );
        await r.put(s, "usage_recovery", {
          ...input,
          id,
          accountId: account.id,
          installationId: req.params.installationId,
          fingerprint,
          status: "requested",
          createdAt: p.time(),
        });
        return { id, status: "requested" };
      });
    }),
  );
  app.get(
    ap + "/recovery-requests",
    write(async (req: any) => {
      const all = await p.records.list<any>(scope(req.params.productId), "usage_recovery");
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25)),
        offset = Math.max(0, Number(req.query.offset) || 0);
      return {
        requests: all
          .slice(offset, offset + limit)
          .map(
            ({
              challenge: _challenge,
              token: _token,
              fingerprint: _fingerprint,
              payload: _payload,
              ...v
            }) => v,
          ),
        total: all.length,
      };
    }),
  );
  app.post(
    ap + "/recovery-requests/:id/reject",
    write(async (req: any) => {
      const input = z
        .object({
          requestId: uuid,
          revision: z.number().int(),
          reason: z.string().trim().min(10).max(1000),
        })
        .strict()
        .parse(req.body);
      return atomic(p.options.database, async (r) => {
        const s = scope(req.params.productId),
          request = await r.get<any>(s, "usage_recovery", req.params.id);
        if (!request) throw new DomainError("unknown_recovery", "No such recovery request.", 404);
        const fingerprint = digest({ ...input, id: request.id, actor: req.actor });
        const old = await r.get<any>(s, "licensing_event", input.requestId);
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new DomainError("idempotency_conflict", "Rejection changed.", 409);
          return { ok: true };
        }
        if (request.status === "claimed" || request.status === "rejected")
          throw new DomainError("recovery_unavailable", "The request is already final.", 409);
        await r.put(
          s,
          "usage_recovery",
          { ...request, status: "rejected", token: null, payload: null },
          input.revision,
        );
        await recordImportEvent(r, req.params.productId, {
          id: input.requestId,
          kind: "recovery.reject",
          accountId: request.accountId,
          fingerprint,
          actor: req.actor,
          reason: input.reason,
          createdAt: p.time(),
        });
        return { ok: true };
      });
    }),
  );
  app.post(
    ap + "/recovery-requests/:id/approve",
    write(async (req: any) => {
      const input = z
        .object({
          requestId: uuid,
          revision: z.number().int(),
          mode: z.enum(["restore", "lost_history"]),
          reason: z.string().trim().min(10).max(1000),
        })
        .strict()
        .parse(req.body);
      return atomic(p.options.database, async (r) => {
        const pid = req.params.productId,
          s = scope(pid),
          request = await r.get<any>(s, "usage_recovery", req.params.id);
        if (!request) throw new DomainError("unknown_recovery", "No such recovery request.", 404);
        const fingerprint = digest({ ...input, id: request.id, actor: req.actor });
        const old = await r.get<any>(s, "licensing_event", input.requestId);
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new DomainError("idempotency_conflict", "Approval changed.", 409);
          return { ok: true };
        }
        if (request.status !== "requested" || (input.mode === "restore" && !request.usageDigest))
          throw new DomainError(
            "recovery_unavailable",
            "Request cannot be approved in this mode.",
            409,
          );
        const grant = await license(r, pid, request.licenseId),
          account = (await importAccount(r, pid, grant))!,
          product = await p.product(pid, r);
        const payload = {
          v: 1,
          kind: "usage-recovery",
          iss: "default",
          productId: pid,
          kid: product.keys.find((k) => !k.retiredAt && !k.pending)!.kid,
          installationId: request.installationId,
          recoveryId: input.requestId,
          accountId: account.id,
          challenge: request.challenge,
          mode: input.mode,
          usageDigest: input.mode === "restore" ? request.usageDigest : null,
          paidImportsFloor: input.mode === "lost_history" ? account.granted : 0,
          trialImportsFloor: input.mode === "lost_history" ? (product.trial.allowance ?? 0) : 0,
          recoveryGeneration: account.recoveryGeneration + 1,
          authorizationRevision: account.authorizationRevision + 1,
          issuedAt: p.time(),
          expiresAt: new Date(p.options.now().getTime() + 86400000).toISOString(),
        };
        const token = p.sign(product, recoveryTokenSchema.parse(payload));
        await r.put(
          s,
          "usage_recovery",
          {
            ...request,
            status: "approved",
            token,
            payload,
            expectedRevision: account.authorizationRevision,
          },
          input.revision,
        );
        await recordImportEvent(r, pid, {
          id: input.requestId,
          kind: "recovery.approve",
          accountId: account.id,
          fingerprint,
          actor: req.actor,
          reason: input.reason,
          createdAt: p.time(),
        });
        return { ok: true };
      });
    }),
  );
  app.post(
    recovery + "/:id/claim",
    wrap(async (req: any) => {
      return atomic(p.options.database, async (r) => {
        const pid = req.params.productId,
          s = scope(pid);
        const installation = await p.authenticate(pid, req.params.installationId, bearer(req), r);
        const request = await r.get<any>(s, "usage_recovery", req.params.id);
        if (!request || request.installationId !== req.params.installationId)
          throw new DomainError("unknown_recovery", "No such recovery request.", 404);
        if (!request.payload || Date.parse(request.payload.expiresAt) <= p.options.now().getTime())
          throw new DomainError(
            "recovery_unavailable",
            "Await staff approval or request a new recovery after expiry.",
            409,
          );
        const grant = await license(r, pid, request.licenseId),
          account = (await importAccount(r, pid, grant))!,
          product = await p.product(pid, r);
        if (installation.importAccountId && installation.importAccountId !== account.id)
          throw new DomainError(
            "account_mismatch",
            "This installation belongs to another usage account.",
            409,
          );
        if (p.status(grant) !== "active")
          throw new DomainError("recovery_unavailable", "An active license is required.", 409);
        if (request.status === "claimed") {
          if (
            account.ownerInstallationId !== installation.id ||
            account.recoveryGeneration !== request.payload.recoveryGeneration
          )
            throw new DomainError(
              "recovery_stale",
              "A newer recovery superseded this request.",
              409,
            );
        } else {
          if (
            request.status !== "approved" ||
            account.authorizationRevision !== request.expectedRevision
          )
            throw new DomainError(
              "recovery_stale",
              "Authorization changed; obtain a new approval.",
              409,
            );
          for (const b of await r.list<any>(s, "binding"))
            if (b.licenseId === grant.id && !b.deactivatedAt)
              await r.put(s, "binding", { ...b, deactivatedAt: p.time() });
          account.recoveryGeneration = request.payload.recoveryGeneration;
          account.authorizationRevision = request.payload.authorizationRevision;
          account.ownerInstallationId = installation.id;
          await r.put(s, "import_account", account);
          await r.put(s, "binding", {
            id: grant.id + ":" + installation.id,
            licenseId: grant.id,
            installationId: installation.id,
            activatedAt: p.time(),
            deactivatedAt: null,
          });
          await r.put(s, "installation", {
            ...installation,
            importAccountId: account.id,
            licenseId: grant.id,
            trialConvertedAt: installation.trialConvertedAt ?? p.time(),
          });
          await r.put(s, "usage_recovery", { ...request, status: "claimed", claimedAt: p.time() });
          await r.put(s, "licensing_event", {
            id: "claim:" + request.payload.recoveryId,
            kind: "recovery.claim",
            accountId: account.id,
            actor: "installation:" + installation.id,
            createdAt: p.time(),
          });
        }
        return {
          recoveryToken: request.token,
          token: await p.token(product, grant, installation.id, r),
          serverTime: p.time(),
        };
      });
    }),
  );
}
