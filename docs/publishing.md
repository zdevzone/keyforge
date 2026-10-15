# Publishing KeyForge packages

The server root is a private application manifest (`private: true`), not an SDK package. Release individual packages from the public `zdevzone/keyforge` source after syncing and checking it. Repository visibility and package publication are separate actions.

| Directory | Package | Purpose |
| --- | --- | --- |
| `packages/keyforge-client` | `@zdevzone/keyforge-client` | Runtime SDK for dependent apps |
| `packages/create-keyforge` | `create-keyforge` | Server generator: `vp create keyforge` |
| `packages/create-keyforge-client` | `create-keyforge-client` | Node.js starter: `vp create keyforge-client` |

`@keyforge/client` belongs to an unrelated project. Do not publish there, install it as this SDK, or use another tag to bypass the version error. Our SDK starts at `0.1.0` under the new scope; the publisher must control `@zdevzone`.

The original `create-keyforge@1.0.0` was unpublished. Release the corrected generator as `1.0.1` or a later unused version. npm requires a **24-hour wait after fully unpublishing a package**, and previously published versions cannot be reused. See [npm's unpublish policy](https://docs.npmjs.com/policies/unpublish/#considerations); changing tags or repeatedly retrying does not bypass the hold.

## Check and pack

From the public source checkout:

```sh
vp install --frozen-lockfile
vp run check
vp run test
vp run build:all
vp run test:packages
vp -C packages/keyforge-client pm pack --pack-destination ../../.artifacts
vp -C packages/create-keyforge pm pack --pack-destination ../../.artifacts
vp -C packages/create-keyforge-client pm pack --pack-destination ../../.artifacts
```

`test:packages` packs a clean SDK source copy, verifies every exported JavaScript/type file, and exercises both generators through actual Vite+ creation using a temporary registry and disposable server template. It does not publish. CI runs it on Linux and Windows.

The SDK's `prepack` hook builds and verifies exports automatically, including with `npm publish`. Its archive must contain `dist/index.js`, declarations, and Windows/Linux/macOS/auto-signal entry points. A README-and-skill-only archive is broken: stop the release. Never disable lifecycle scripts. Inspect archives for secrets; no keys, databases, registry credentials or generated environment files belong in them.

## Publish in order

After signing in to the intended npm account and reviewing the archives:

```sh
vp -C packages/keyforge-client pm publish --access public
vp -C packages/create-keyforge pm publish --access public
vp -C packages/create-keyforge-client pm publish --access public
```

Publish the SDK before the client generator so new starters can resolve it. These are explicit release commands; normal builds and CI never publish. Verify ownership, the unused version and the intended tag. Do not force `latest` on another project's package.

## Verify the release

```sh
vp create keyforge@1.0.1 -- my-license-server --yes
vp create keyforge-client -- my-client --server-url https://licenses.example.com --product studio --yes
```

Vite+ must complete at the generated project root, without looking for a removed `packages/create-keyforge/package.json`. Interactive choices support Up/Down, Enter and Ctrl+C; `--yes` and noninteractive runs use defaults.

Existing apps use `vp add @zdevzone/keyforge-client` after release. Before release, install the reviewed local archive (`zdevzone-keyforge-client-0.1.0.tgz`) using the [SDK guide](../packages/keyforge-client/README.md). Implement secure atomic storage, pin approved public keys and test offline restart before shipping; the starter's memory demo intentionally supports only local unlicensed status.
