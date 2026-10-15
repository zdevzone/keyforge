import { z } from "zod";

import { encodeBase64url, TokenError, verifySignedToken, type SignedToken } from "./tokens.js";
import { DEVICE_SIGNAL_KINDS } from "./types.js";
import type {
  Authorization,
  ClientState,
  CustomerNotification,
  CustomerThread,
  DeviceSignalsProvider,
  DeviceSignalsReport,
  NotificationPreferences,
  RegistrationMetadata,
  SecureStorage,
  SupportRequest,
  ValidationResult,
} from "./types.js";

export class KeyForgeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    public readonly retryable = false,
  ) {
    super(`KeyForge request failed (${code}).`);
    this.name = "KeyForgeError";
  }
}
/** Ephemeral test/example storage. Not a production persistence implementation. */
export class MemoryStorage implements SecureStorage {
  private state: ClientState | null = null;
  async load() {
    return structuredClone(this.state);
  }
  async save(state: ClientState) {
    this.state = structuredClone(state);
  }
}
export interface ClientOptions {
  serverUrl: string;
  productId: string;
  publicKeys: Readonly<Record<string, string>>;
  storage: SecureStorage;
  subjectKind?: "installation" | "service";
  registration?: RegistrationMetadata;
  /** Opt-in collection. Raw identifiers must never leave the provider. */
  deviceSignalsProvider?: DeviceSignalsProvider;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  clockToleranceMs?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Injectable to make retry tests deterministic. */
  sleep?: (ms: number) => Promise<void>;
}
const metadataSchema = z
  .object({
    appVersion: z.string().max(50).optional(),
    platform: z.string().max(100).optional(),
    userName: z.string().max(200).optional(),
    userEmail: z.string().max(200).optional(),
    machineSignals: z
      .array(
        z
          .object({
            kind: z.enum(DEVICE_SIGNAL_KINDS),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(3)
      .optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    serverUrl: z.string(),
    productId: z.string(),
    subjectKind: z.enum(["installation", "service"]),
    installationId: z.string().uuid(),
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    registration: metadataSchema.extend({
      installationId: z.string().uuid(),
      requestId: z.string().uuid(),
    }),
    registered: z.boolean(),
    trialStarted: z.boolean(),
    trialConsumed: z.number().int().nonnegative().safe(),
    trialToken: z.string().nullable(),
    licenseToken: z.string().nullable(),
    denial: z.string().nullable(),
    lastObservedTime: z.number().finite().nonnegative(),
    deviceSignals: z
      .object({
        signals: metadataSchema.shape.machineSignals.unwrap(),
        diagnostics: z
          .array(
            z
              .object({
                kind: z.enum(DEVICE_SIGNAL_KINDS),
                status: z.enum([
                  "available",
                  "unavailable",
                  "invalid",
                  "timeout",
                  "permission_denied",
                  "unsupported",
                  "query_failed",
                ]),
              })
              .strict(),
          )
          .max(3),
      })
      .strict()
      .optional(),
  })
  .strict();

export class KeyForgeClient {
  private readonly options: ClientOptions;
  private readonly url: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: ClientOptions) {
    if (
      !options.storage ||
      !options.publicKeys ||
      !/^[a-z][a-z0-9-]{0,59}$/.test(options.productId)
    )
      throw new KeyForgeError("invalid_configuration");
    let u: URL;
    try {
      u = new URL(options.serverUrl);
    } catch {
      throw new KeyForgeError("invalid_server_url");
    }
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.protocol !== "https:" &&
        !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    )
      throw new KeyForgeError("invalid_server_url");
    this.url = u.toString().replace(/\/$/, "");
    this.options = {
      ...options,
      publicKeys: { ...options.publicKeys },
      registration: metadataSchema.parse(options.registration ?? {}),
    };
    if (
      !Number.isInteger(options.maxAttempts ?? 3) ||
      (options.maxAttempts ?? 3) < 1 ||
      (options.maxAttempts ?? 3) > 5 ||
      !Number.isFinite(options.timeoutMs ?? 10000) ||
      (options.timeoutMs ?? 10000) <= 0 ||
      !Number.isFinite(options.clockToleranceMs ?? 300000) ||
      (options.clockToleranceMs ?? 300000) < 0
    )
      throw new KeyForgeError("invalid_configuration");
  }
  private now() {
    const time = (this.options.now ?? Date.now)();
    if (!Number.isFinite(time) || time < 0) throw new KeyForgeError("invalid_clock");
    return time;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private async load(): Promise<ClientState> {
    const stored = await this.options.storage.load();
    if (stored !== null) {
      const parsed = stateSchema.safeParse(stored);
      if (!parsed.success) throw new KeyForgeError("invalid_stored_state");
      const state = parsed.data;
      if (
        state.serverUrl !== this.url ||
        state.productId !== this.options.productId ||
        state.subjectKind !== (this.options.subjectKind ?? "installation") ||
        state.registration.installationId !== state.installationId
      )
        throw new KeyForgeError("storage_context_mismatch");
      return state;
    }
    const installationId = crypto.randomUUID();
    const deviceSignals = this.options.deviceSignalsProvider
      ? await this.collectDeviceSignals()
      : undefined;
    const state: ClientState = {
      version: 1,
      serverUrl: this.url,
      productId: this.options.productId,
      subjectKind: this.options.subjectKind ?? "installation",
      installationId,
      credential: encodeBase64url(crypto.getRandomValues(new Uint8Array(32))),
      registration: {
        ...this.options.registration,
        ...(deviceSignals && !this.options.registration?.machineSignals
          ? { machineSignals: deviceSignals.signals }
          : {}),
        installationId,
        requestId: crypto.randomUUID(),
      },
      registered: false,
      trialStarted: false,
      trialConsumed: 0,
      trialToken: null,
      licenseToken: null,
      denial: null,
      lastObservedTime: this.now(),
      ...(deviceSignals ? { deviceSignals } : {}),
    };
    // Identity and exact registration body must be durable before the first network request.
    await this.options.storage.save(state);
    return state;
  }
  private async collectDeviceSignals(): Promise<DeviceSignalsReport> {
    try {
      const result = await this.options.deviceSignalsProvider!({
        serverUrl: this.url,
        productId: this.options.productId,
      });
      return stateSchema.shape.deviceSignals.unwrap().parse(result);
    } catch {
      // Never propagate system query output or provider exceptions (which may contain identifiers).
      return {
        signals: [],
        diagnostics: ["machine-guid", "smbios-uuid", "volume-serial"].map((kind) => ({
          kind: kind as DeviceSignalsReport["diagnostics"][number]["kind"],
          status: "query_failed",
        })),
      };
    }
  }
  /** Recollect recognition hints for this authenticated installation; never re-registers it. */
  async updateDeviceSignals(): Promise<DeviceSignalsReport> {
    return this.serial(async () => {
      if (!this.options.deviceSignalsProvider)
        throw new KeyForgeError("device_signals_provider_required");
      const state = await this.load();
      if (!state.registered) throw new KeyForgeError("registration_required");
      const report = await this.collectDeviceSignals();
      await this.request(state, "PUT", this.installationPath(state, "/device-signals"), {
        machineSignals: report.signals,
      });
      state.deviceSignals = report;
      await this.options.storage.save(state);
      return structuredClone(report);
    });
  }
  async getDeviceSignalsDiagnostics(): Promise<DeviceSignalsReport["diagnostics"]> {
    return this.serial(async () =>
      structuredClone((await this.load()).deviceSignals?.diagnostics ?? []),
    );
  }
  private context(state: ClientState) {
    return {
      productId: state.productId,
      installationId: state.installationId,
      subjectKind: state.subjectKind,
      publicKeys: this.options.publicKeys,
      now: this.now(),
      clockToleranceMs: this.options.clockToleranceMs,
    };
  }
  private productPath(suffix: string) {
    return `/v1/products/${encodeURIComponent(this.options.productId)}${suffix}`;
  }
  private installationPath(state: ClientState, suffix: string) {
    return this.productPath(`/installations/${encodeURIComponent(state.installationId)}${suffix}`);
  }
  private async request<T>(
    state: ClientState,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const attempts = this.options.maxAttempts ?? 3;
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10000);
      let failure: KeyForgeError;
      let retryAfter = 0;
      try {
        const response = await (this.options.fetch ?? globalThis.fetch)(this.url + path, {
          method,
          headers: {
            authorization: "Bearer " + state.credential,
            ...(serialized === undefined ? {} : { "content-type": "application/json" }),
            ...extraHeaders,
          },
          body: serialized,
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        });
        let value: unknown;
        try {
          value = await response.json();
        } catch {
          if (response.ok) throw new KeyForgeError("invalid_response", response.status);
        }
        if (response.ok) return value as T;
        const error = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const code =
          typeof error.error === "string" && /^[a-z_]{1,100}$/.test(error.error)
            ? error.error
            : "http_error";
        failure = new KeyForgeError(
          code,
          response.status,
          [429, 502, 503, 504].includes(response.status),
        );
        const header = response.headers.get("retry-after");
        retryAfter = header
          ? /^\d+$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - Date.now()
          : 0;
      } catch (error) {
        if (error instanceof KeyForgeError) throw error;
        failure = new KeyForgeError(
          controller.signal.aborted ? "request_timeout" : "network_error",
          0,
          true,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!failure.retryable || attempt === attempts - 1) throw failure;
      // Do not retry earlier than Retry-After; return control for long server throttles.
      if (Number.isFinite(retryAfter) && retryAfter > 30000) throw failure;
      const backoff = Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random());
      await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        Math.max(backoff, retryAfter || 0),
      );
    }
    throw new KeyForgeError("network_error", 0, true);
  }
  private async ensureRegistered(state: ClientState) {
    if (state.registered) return;
    const response = await this.request<{ ok: true; trial: { token: string } | null }>(
      state,
      "POST",
      this.productPath("/register"),
      state.registration,
    );
    if (
      response?.ok !== true ||
      !(response.trial === null || typeof response.trial?.token === "string")
    )
      throw new KeyForgeError("invalid_response");
    if (response.trial) {
      const grant = await verifySignedToken(response.trial.token, this.context(state));
      if (grant.kind !== "trial") throw new TokenError("unexpected_token_kind");
      state.trialToken = response.trial.token;
      this.observe(state, grant);
    }
    state.registered = true;
    await this.options.storage.save(state);
  }
  private observe(state: ClientState, grant?: SignedToken) {
    state.lastObservedTime = Math.max(
      state.lastObservedTime,
      this.now(),
      grant ? Date.parse(grant.issuedAt) : 0,
    );
  }
  private async evaluate(state: ClientState): Promise<Authorization> {
    const now = this.now();
    if (now + (this.options.clockToleranceMs ?? 300000) < state.lastObservedTime)
      return { state: "reconnect_required", reason: "clock_rollback" };
    this.observe(state);
    await this.options.storage.save(state);
    if (state.denial) return { state: "reconnect_required", reason: state.denial };
    const token = state.licenseToken ?? (state.trialStarted ? state.trialToken : null);
    if (!token) return { state: "unlicensed", reason: "activation_required" };
    let grant: SignedToken;
    try {
      grant = await verifySignedToken(token, this.context(state));
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      return { state: "reconnect_required", reason: error.code };
    }
    const time = Math.max(now, state.lastObservedTime);
    if (grant.kind === "license") {
      if (grant.status === "revoked") return { state: "revoked", reason: "license_revoked" };
      if (
        grant.status === "expired" ||
        (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= time)
      )
        return { state: "expired", reason: "license_expired" };
      if (Date.parse(grant.offlineGraceUntil) <= time)
        return { state: "reconnect_required", reason: "offline_grace_expired" };
      const deadline = new Date(
        Math.min(
          Date.parse(grant.offlineGraceUntil),
          grant.expiresAt ? Date.parse(grant.expiresAt) : Infinity,
        ),
      ).toISOString();
      return { state: "licensed", token: grant, entitlements: grant.entitlements, deadline };
    }
    if (grant.verdict !== "fresh") return { state: "expired", reason: "trial_spent" };
    if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= time)
      return { state: "expired", reason: "trial_expired" };
    if (grant.allowance !== null && state.trialConsumed >= grant.allowance)
      return { state: "expired", reason: "trial_exhausted" };
    return {
      state: "trial",
      token: grant,
      remaining: grant.allowance === null ? null : grant.allowance - state.trialConsumed,
    };
  }
  /** Registers online but does not select a trial or unlock features. */
  register() {
    return this.serial(async () => {
      const state = await this.load();
      await this.ensureRegistered(state);
      const grant = state.trialToken
        ? await verifySignedToken(state.trialToken, this.context(state))
        : null;
      return {
        installationId: state.installationId,
        trialAvailable:
          grant?.kind === "trial" &&
          grant.verdict === "fresh" &&
          (grant.expiresAt === null ||
            Date.parse(grant.expiresAt) > Math.max(this.now(), state.lastObservedTime)) &&
          (grant.allowance === null || grant.allowance > state.trialConsumed),
      };
    });
  }
  startTrial(): Promise<Authorization> {
    return this.serial(async () => {
      const state = await this.load(),
        wasRegistered = state.registered;
      await this.ensureRegistered(state);
      // Explicit trial onboarding requires connectivity even if registration was completed earlier.
      if (wasRegistered)
        await this.request(state, "POST", this.productPath("/register"), state.registration);
      state.trialStarted = true;
      await this.options.storage.save(state);
      return this.evaluate(state);
    });
  }
  getAuthorization(): Promise<Authorization> {
    return this.serial(async () => this.evaluate(await this.load()));
  }
  /** Saves usage independently of grants. Refresh/activation never resets this counter. */
  consumeTrial(units = 1): Promise<Authorization> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(units) || units <= 0) throw new KeyForgeError("invalid_units");
      const state = await this.load(),
        authorization = await this.evaluate(state);
      if (
        authorization.state !== "trial" ||
        (authorization.remaining !== null && units > authorization.remaining)
      )
        throw new KeyForgeError("trial_unavailable");
      if (!Number.isSafeInteger(state.trialConsumed + units))
        throw new KeyForgeError("invalid_units");
      state.trialConsumed += units;
      await this.options.storage.save(state);
      return this.evaluate(state);
    });
  }
  validate(key: string): Promise<ValidationResult> {
    return this.serial(async () => {
      const state = await this.load();
      await this.ensureRegistered(state);
      return this.request(state, "POST", this.productPath("/validate"), {
        installationId: state.installationId,
        key,
      });
    });
  }
  activate(key: string): Promise<Authorization> {
    return this.serial(async () => {
      if (typeof key !== "string" || !key.trim()) throw new KeyForgeError("key_required");
      const state = await this.load();
      await this.ensureRegistered(state);
      const response = await this.request<{ token: string }>(
        state,
        "POST",
        this.productPath("/activate"),
        { installationId: state.installationId, key },
      );
      await this.saveLicense(state, response?.token);
      return this.evaluate(state);
    });
  }
  private async saveLicense(state: ClientState, token: string, expectedLicenseId?: string) {
    const grant = await verifySignedToken(token, this.context(state));
    if (grant.kind !== "license" || (expectedLicenseId && grant.licenseId !== expectedLicenseId))
      throw new TokenError("unexpected_license");
    if (state.licenseToken) {
      let prior: SignedToken | null = null;
      try {
        prior = await verifySignedToken(state.licenseToken, this.context(state));
      } catch (error) {
        if (!(error instanceof TokenError)) throw error;
      }
      if (
        prior?.kind === "license" &&
        prior.licenseId === grant.licenseId &&
        (Date.parse(grant.issuedAt) < Date.parse(prior.issuedAt) ||
          (grant.issuedAt === prior.issuedAt &&
            prior.status !== "active" &&
            grant.status === "active"))
      )
        throw new TokenError("stale_grant");
    }
    state.licenseToken = token;
    state.denial = null;
    this.observe(state, grant);
    // Persist authenticated negative status before returning it, including HTTP 200 revocations.
    await this.options.storage.save(state);
  }
  refresh(): Promise<Authorization> {
    return this.serial(async () => {
      const state = await this.load();
      if (!state.licenseToken) throw new KeyForgeError("activation_required");
      const grant = await verifySignedToken(state.licenseToken, this.context(state));
      if (grant.kind !== "license") throw new TokenError("unexpected_token_kind");
      let response: { token: string };
      try {
        response = await this.request(state, "POST", this.productPath("/refresh"), {
          installationId: state.installationId,
          licenseId: grant.licenseId,
        });
      } catch (error) {
        if (
          error instanceof KeyForgeError &&
          [
            "installation_unauthorized",
            "not_activated_here",
            "unknown_license",
            "unknown_product",
            "product_archived",
          ].includes(error.code)
        ) {
          state.denial = error.code;
          await this.options.storage.save(state);
        }
        throw error;
      }
      await this.saveLicense(state, response?.token, grant.licenseId);
      return this.evaluate(state);
    });
  }
  deactivate(): Promise<void> {
    return this.serial(async () => {
      const state = await this.load();
      if (!state.licenseToken) return;
      const grant = await verifySignedToken(state.licenseToken, this.context(state));
      if (grant.kind !== "license") throw new TokenError("unexpected_token_kind");
      await this.request(state, "POST", this.productPath("/deactivate"), {
        installationId: state.installationId,
        licenseId: grant.licenseId,
      });
      state.licenseToken = null;
      state.trialStarted = false;
      state.denial = null;
      await this.options.storage.save(state);
    });
  }
  getNotifications() {
    return this.serial(async () => {
      const state = await this.load();
      await this.ensureRegistered(state);
      return this.request<{ items: CustomerNotification[]; preferences: NotificationPreferences }>(
        state,
        "GET",
        this.installationPath(state, "/notifications"),
      );
    });
  }
  setNotificationPreferences(preferences: NotificationPreferences) {
    return this.serial(async () => {
      const state = await this.load();
      return this.request<{ ok: true }>(
        state,
        "PUT",
        this.installationPath(state, "/notifications/preferences"),
        preferences,
      );
    });
  }
  markNotificationRead(eventId: string) {
    return this.serial(async () => {
      const state = await this.load();
      return this.request<{ ok: true }>(
        state,
        "POST",
        this.installationPath(state, "/notifications/read"),
        { eventId },
      );
    });
  }
  collectLicense(licenseId: string) {
    return this.serial(async () => {
      const state = await this.load();
      // Construct locally rather than following an untrusted collectPath with our bearer credential.
      return this.request<{
        key: string;
        license: { id: string; plan: string; issuedTo: string; expiresAt: string | null };
      }>(
        state,
        "POST",
        this.installationPath(state, `/licenses/${encodeURIComponent(licenseId)}/collect`),
      );
    });
  }
  listSupportThreads() {
    return this.serial(async () => {
      const state = await this.load();
      return this.request<{ requests: CustomerThread[] }>(
        state,
        "GET",
        this.installationPath(state, "/support"),
      );
    });
  }
  getSupportThread(id: string) {
    return this.serial(async () => {
      const state = await this.load();
      return this.request<{ request: CustomerThread }>(
        state,
        "GET",
        this.installationPath(state, `/support/${encodeURIComponent(id)}`),
      );
    });
  }
  createSupportThread(input: SupportRequest) {
    return this.serial(async () => {
      const state = await this.load();
      return this.request<{
        request: {
          id: string;
          clientRequestId: string;
          status: CustomerThread["status"];
          receivedAt: string;
        };
        serverTime: string;
      }>(state, "POST", this.installationPath(state, "/support"), input, {
        "idempotency-key": input.requestId,
      });
    });
  }
  replyToSupportThread(
    id: string,
    input: { requestId: string; revision: number; message: string },
  ) {
    return this.serial(async () => {
      const state = await this.load();
      return this.request<{ request: CustomerThread }>(
        state,
        "POST",
        this.installationPath(state, `/support/${encodeURIComponent(id)}/messages`),
        { requestId: input.requestId, revision: input.revision, message: input.message },
      );
    });
  }
}
