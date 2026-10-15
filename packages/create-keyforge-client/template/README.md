# KeyForge client starter

A Node.js integration example for `@zdevzone/keyforge-client`. No server secrets or administrator credentials belong here.

## Start

1. Run `vp install`.
2. Copy `.env.example` to `.env.local` and set your server origin and product ID.
3. Put the product's approved public verification keys in `public-keys.json`, as a JSON object mapping each trusted `kid` to its PEM public key. Do not trust keys fetched over the network without approving/pinning them.
4. Run `vp run demo` to see an unlicensed local state. This explicitly uses memory storage, performs no network requests and cannot activate or start a trial.
5. Implement `src/storage.ts` with your runtime's secure credential vault and atomic state updates, then run `vp run typecheck` and `vp run start`.

The default storage adapter deliberately refuses real use until implemented. Never replace it with an unencrypted JSON file. Persist identity, pending registration, grants and trial counters together; losing credentials requires a new installation and operator-assisted seat recovery.

## Onboarding

Use `vp run start activate` with `KEYFORGE_LICENSE_KEY` set privately in the environment to activate a purchased license. `vp run start trial` explicitly requests a permitted trial; `vp run start refresh` refreshes authorization online; `vp run start deactivate` releases a seat. `vp run start` reads cached status locally. Initial registration, activation and trials require internet.

No authorization is granted merely by skipping onboarding. Gate protected operations using the returned signed entitlements and state. Refresh online before the signed deadline; never extend offline access locally. Do not erase saved state to retry rejected authorization or restart a trial.

Set `KEYFORGE_DEVICE_SIGNALS=1` to opt in to Windows/Linux/macOS recognition hints. Signals do not replace the installation credential or automatically transfer seats. Do not log tokens, license keys, device identifiers or stored credentials.

## Verification before shipping

Test activation, offline restart with the same secure record, signed grace expiry, revocation refresh, interrupted registration, lost credentials and seat exhaustion against a test server. Ensure unsupported hardware collection still permits installation-based operation. The supplied demo checks wiring only; it is not production storage.

The SDK archive includes the `skill/keyforge-integrate` AI integration skill and its references. Use the matching server's `/docs` and client OpenAPI for language-independent integration details.
