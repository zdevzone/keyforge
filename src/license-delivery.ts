import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { atomic, DomainError, type RecordValue } from "./platform-store.js";
import type { Grant, Platform, Product, Plan } from "./platform.js";

export interface LicenseRequest extends RecordValue {
  productId: string;
  plan: string;
  name: string;
  email: string;
  secretHash: string;
  status: "requested" | "issued";
  licenseId: string | null;
  createdAt: string;
}
export interface LicenseDelivery extends RecordValue {
  licenseId: string;
  installationId: string | null;
  requestId: string | null;
  status: "available" | "retrieved" | "manual" | "failed";
  createdAt: string;
  retrievedAt: string | null;
  error: string | null;
}
const workspace = "workspace:default";
const scope = (id: string) => "product:" + id;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const publicRequest = ({ secretHash: _secret, ...value }: LicenseRequest) => value;

/** Private links use a browser fragment, sent only as a bearer credential to this API. */
export function registerLicenseDelivery(
  app: FastifyInstance,
  p: Platform,
  wrap: any,
  ap: string,
  device: string,
  bearer: any,
) {
  const authorizeRequest = async (req: any) => {
    const r = await p.records.get<LicenseRequest>(workspace, "license_request", req.params.id);
    const token = bearer(req);
    if (!r || !token || digest(token) !== r.secretHash)
      throw new DomainError(
        "request_not_found",
        "Request not found or private link is invalid.",
        404,
      );
    return r;
  };
  const collect = async (pid: string, licenseId: string) => {
    const result = await atomic(p.options.database, async (r) => {
      const delivery = await r.get<LicenseDelivery>(scope(pid), "license_delivery", licenseId);
      const license = await r.get<Grant>(scope(pid), "license", licenseId);
      if (!delivery || !license || p.status(license) !== "active")
        throw new DomainError(
          "delivery_unavailable",
          "This license is not available. Contact support.",
          409,
        );
      let key: string;
      try {
        key = p.vault.decrypt(license.encryptedKey!, "license:" + pid + ":" + licenseId);
      } catch {
        await r.put(scope(pid), "license_delivery", {
          ...delivery,
          status: "failed",
          error: "Key retrieval failed. Contact the license operator.",
        });
        return null;
      }
      await r.put(scope(pid), "license_delivery", {
        ...delivery,
        status: "retrieved",
        retrievedAt: delivery.retrievedAt ?? p.time(),
        error: null,
      });
      return {
        key,
        license: {
          id: license.id,
          plan: license.plan,
          issuedTo: license.issuedTo,
          expiresAt: license.expiresAt,
        },
      };
    });
    if (!result)
      throw new DomainError(
        "delivery_failed",
        "Key retrieval failed. Contact the license operator, then retry this link.",
        503,
      );
    return result;
  };
  app.get(
    "/v1/license-request-catalog",
    wrap(async () => {
      const products = (await p.records.list<Product>(workspace, "product")).filter(
        (v) => !v.archived,
      );
      return {
        products: await Promise.all(
          products.map(async (product) => ({
            id: product.id,
            name: product.name,
            plans: (await p.records.list<Plan>(scope(product.id), "plan"))
              .filter((v) => !v.archived)
              .map((v) => ({ id: v.id, description: v.description })),
          })),
        ),
      };
    }),
  );
  app.post(
    "/v1/license-requests",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    wrap(async (req: any, reply: any) => {
      const input = z
        .object({
          id: z.string().uuid(),
          productId: z.string().min(1).max(60),
          plan: z.string().min(1).max(200),
          name: z.string().trim().min(1).max(100),
          email: z.email().max(254),
        })
        .strict()
        .parse(req.body);
      const token = bearer(req);
      if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token))
        throw new DomainError(
          "invalid_request_secret",
          "A private request credential is required.",
        );
      await atomic(p.options.database, async (r) => {
        const old = await r.get<LicenseRequest>(workspace, "license_request", input.id);
        if (old) {
          if (
            old.secretHash !== digest(token) ||
            Object.entries(input).some(([k, v]) => old[k as keyof LicenseRequest] !== v)
          )
            throw new DomainError(
              "idempotency_conflict",
              "This request ID has already been used.",
              409,
            );
          return;
        }
        const product = await p.product(input.productId, r),
          plan = await r.get<Plan>(scope(input.productId), "plan", input.plan);
        if (product.archived || !plan || plan.archived)
          throw new DomainError("unknown_plan", "Choose an available product and plan.");
        await r.put<LicenseRequest>(workspace, "license_request", {
          ...input,
          secretHash: digest(token),
          status: "requested",
          licenseId: null,
          createdAt: p.time(),
        });
      });
      return reply.code(202).send({ id: input.id, status: "requested" });
    }),
  );
  app.get(
    "/v1/license-requests/:id",
    wrap(async (req: any, reply: any) => {
      const request = await authorizeRequest(req);
      reply.header("Cache-Control", "no-store");
      return {
        request: publicRequest(request),
        delivery: request.licenseId
          ? await p.records.get(scope(request.productId), "license_delivery", request.licenseId)
          : null,
      };
    }),
  );
  app.post(
    "/v1/license-requests/:id/collect",
    wrap(async (req: any, reply: any) => {
      const request = await authorizeRequest(req);
      if (!request.licenseId)
        throw new DomainError("request_pending", "Your request is awaiting an operator.", 409);
      reply.header("Cache-Control", "no-store");
      return collect(request.productId, request.licenseId);
    }),
  );
  app.get(
    ap + "/license-recipients",
    wrap(
      async (req: any) => ({
        installations: (await p.records.list<any>(scope(req.params.productId), "installation"))
          .filter((v) => v.credentialHash)
          .map((v) => ({ id: v.id, name: v.userName, email: v.userEmail })),
        requests: (await p.records.list<LicenseRequest>(workspace, "license_request"))
          .filter((v) => v.productId === req.params.productId && v.status === "requested")
          .map(publicRequest),
      }),
      true,
      true,
    ),
  );
  app.get(
    ap + "/license-requests",
    wrap(
      async (req: any) => ({
        requests: (await p.records.list<LicenseRequest>(workspace, "license_request"))
          .filter((v) => v.productId === req.params.productId)
          .map(publicRequest),
      }),
      true,
    ),
  );
  app.get(
    ap + "/licenses/:id/delivery",
    wrap(
      async (req: any) => ({
        delivery: await p.records.get(
          scope(req.params.productId),
          "license_delivery",
          req.params.id,
        ),
      }),
      true,
    ),
  );
  app.post(
    device + "/installations/:installationId/licenses/:id/collect",
    wrap(async (req: any, reply: any) => {
      await p.authenticate(req.params.productId, req.params.installationId, bearer(req));
      const d = await p.records.get<LicenseDelivery>(
        scope(req.params.productId),
        "license_delivery",
        req.params.id,
      );
      if (!d || d.installationId !== req.params.installationId)
        throw new DomainError(
          "delivery_unavailable",
          "No license delivery for this installation.",
          404,
        );
      reply.header("Cache-Control", "no-store");
      return collect(req.params.productId, d.licenseId);
    }),
  );
}
