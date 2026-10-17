# Publishing KeyForge packages

Release packages from the public [zdevzone/keyforge](https://github.com/zdevzone/keyforge) repository. The root application is intentionally `private: true`; never publish it.

| Order | Directory | npm package | Current version |
| --- | --- | --- | --- |
| 1 | `packages/keyforge-client` | `@zdevzone/keyforge-client` | `0.1.0` |
| 2 | `packages/create-keyforge` | `create-keyforge` | `1.0.1` |
| 3 | `packages/create-keyforge-client` | `create-keyforge-client` | `0.1.0` |

The SDK must be available before the client generator installs it. Publish only versions you own that have not already been used. `@keyforge/client` belongs to an unrelated project; our SDK uses `@zdevzone/keyforge-client`.

The original `create-keyforge@1.0.0` was unpublished. npm requires a **24-hour wait after fully unpublishing a package** and never allows reusing a published version, even after removal. Keep the corrected generator at `1.0.1` or a later unused version. Tags do not bypass the hold. See [npm's unpublish policy](https://docs.npmjs.com/policies/unpublish/#considerations).

## GitHub Actions release

The workflow is [release.yml](../.github/workflows/release.yml), named **Release npm packages**. It runs only when manually dispatched on `main` in `zdevzone/keyforge`; pushes, pull requests, forks and the development repository cannot publish. Dry run is enabled by default.

Before publication it installs the frozen lockfile, runs lint/format/typechecks, builds the server/UI/SDK, runs all Node tests, exercises both generators against a temporary registry, and runs the console, issuance and docs browser suites. It then packs and inspects all three release archives. The publish job downloads those exact archives; it does not rebuild them. Artifacts are retained for seven days.

The workflow uses npm's OIDC trusted publishing with provenance, without a stored npm token. Only the publish job receives `id-token: write`. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

### One-time setup

1. Sync this workflow and the packages to the public repository's `main` branch.
2. If a package does not exist on npm yet, publish its initial version using the manual commands below. Then configure trusted publishing for later releases. The account must control `@zdevzone` and both unscoped CLI names.
3. In GitHub repository **Settings → Environments**, create `npm`. Restrict deployment branches to `main`; optional reviewers can be configured here.
4. For **each of the three npm packages**, open **Settings → Trusted publishing** and add GitHub Actions with these exact values:

   | Field | Value |
   | --- | --- |
   | Organization or user | `zdevzone` |
   | Repository | `keyforge` |
   | Workflow filename | `release.yml` |
   | Environment | `npm` |
   | Allowed action | Permit direct `npm publish` |

   Do not enter `.github/workflows/release.yml` in the filename field. Complete a release promptly after configuring trust; npm documents expiration for new, unvalidated configurations. No `NPM_TOKEN` repository secret is needed.
5. For a new release, bump the changed packages' manifest versions, update the client starter's SDK dependency range when needed, run `vp install` to update the lockfile, commit, sync to public `main`, and confirm normal CI is green. The release workflow reads manifest versions and does not bump versions, push commits or create tags.

### Run a release

In **Actions → Release npm packages → Run workflow**, select `main`. Leave **Check and pack only** checked for the first dry run. Review the logs and download the `npm-release-<commit>` artifact. Run again with the checkbox cleared to publish.

With [GitHub CLI](https://cli.github.com/), these commands work in Bash and PowerShell:

```sh
# Checks and archives only: no npm publication.
gh workflow run release.yml --repo zdevzone/keyforge --ref main -F dry_run=true

# Inspect the run before publishing.
gh run list --repo zdevzone/keyforge --workflow release.yml --limit 5

# Actual publication, after npm trusted publishing is configured.
gh workflow run release.yml --repo zdevzone/keyforge --ref main -F dry_run=false
```

Find the new run ID using `gh run list`, then monitor it with `gh run watch RUN_ID --repo zdevzone/keyforge --exit-status`.

Only one release runs at a time. All archives and existing npm versions are checked before the first publication. Existing versions are skipped **only when their SHA-512 archive integrity matches exactly**, allowing a partially completed release to resume on the same commit. Conflicting contents, registry errors, publishing failures, or a package not becoming visible stop the release before the next package. npm cannot publish three packages atomically; an earlier successful package stays published if a later one fails. Do not unpublish it to retry. Rerun the same commit after resolving the error; if contents changed, bump the affected versions first. An already-published version is not retagged automatically.

## Manual release: Bash on Linux or macOS

Run these blocks in the same terminal. `set -e` stops on a failed command. If already cloned, enter the public checkout and run `git pull --ff-only` instead of cloning again.

```bash
set -euo pipefail

git clone https://github.com/zdevzone/keyforge.git
cd keyforge
vp install --frozen-lockfile
vp run check
vp run build:all
vp run test
vp run test:packages

npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/

vp -C packages/keyforge-client pm pack --pack-destination ../../.artifacts
vp -C packages/create-keyforge pm pack --pack-destination ../../.artifacts
vp -C packages/create-keyforge-client pm pack --pack-destination ../../.artifacts

tar -tzf .artifacts/zdevzone-keyforge-client-0.1.0.tgz
tar -tzf .artifacts/create-keyforge-1.0.1.tgz
tar -tzf .artifacts/create-keyforge-client-0.1.0.tgz
```

Review the archives before continuing. The SDK must include `package/dist/index.js`, declarations and Windows/Linux/macOS/automatic device-signal modules. A README-and-skill-only archive is broken: stop. Never disable lifecycle scripts. No signing keys, environment files, databases or credentials belong in these archives.

```bash
# 1. SDK
vp -C packages/keyforge-client pm publish --access public --tag latest --registry=https://registry.npmjs.org/
npm view @zdevzone/keyforge-client@0.1.0 version --registry=https://registry.npmjs.org/

# 2. Server CLI
vp -C packages/create-keyforge pm publish --access public --tag latest --registry=https://registry.npmjs.org/
npm view create-keyforge@1.0.1 version --registry=https://registry.npmjs.org/

# 3. Client CLI
vp -C packages/create-keyforge-client pm publish --access public --tag latest --registry=https://registry.npmjs.org/
npm view create-keyforge-client@0.1.0 version --registry=https://registry.npmjs.org/
```

## Manual release: Windows PowerShell

Install the Node.js version in `.node-version`, Vite+, and Git. Use the same PowerShell session for these blocks. This helper checks native program exit codes, including in Windows PowerShell 5.1, where `$ErrorActionPreference` alone does not stop failed native commands. `npm.cmd` avoids execution-policy problems with the npm PowerShell shim.

```powershell
$ErrorActionPreference = 'Stop'
function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program failed with exit code $LASTEXITCODE"
    }
}

Invoke-Checked git @('clone', 'https://github.com/zdevzone/keyforge.git')
Set-Location keyforge
# Existing checkout: use Invoke-Checked git @('pull', '--ff-only') instead.

Invoke-Checked vp @('install', '--frozen-lockfile')
Invoke-Checked vp @('run', 'check')
Invoke-Checked vp @('run', 'build:all')
Invoke-Checked vp @('run', 'test')
Invoke-Checked vp @('run', 'test:packages')

Invoke-Checked npm.cmd @('login', '--registry=https://registry.npmjs.org/')
Invoke-Checked npm.cmd @('whoami', '--registry=https://registry.npmjs.org/')

Invoke-Checked vp @('-C', 'packages/keyforge-client', 'pm', 'pack', '--pack-destination', '../../.artifacts')
Invoke-Checked vp @('-C', 'packages/create-keyforge', 'pm', 'pack', '--pack-destination', '../../.artifacts')
Invoke-Checked vp @('-C', 'packages/create-keyforge-client', 'pm', 'pack', '--pack-destination', '../../.artifacts')

Invoke-Checked tar.exe @('-tzf', '.artifacts/zdevzone-keyforge-client-0.1.0.tgz')
Invoke-Checked tar.exe @('-tzf', '.artifacts/create-keyforge-1.0.1.tgz')
Invoke-Checked tar.exe @('-tzf', '.artifacts/create-keyforge-client-0.1.0.tgz')
```

Review the archives as described above, then publish in order. Complete npm's sign-in or two-factor prompts when requested.

```powershell
# 1. SDK
Invoke-Checked vp @('-C', 'packages/keyforge-client', 'pm', 'publish', '--access', 'public', '--tag', 'latest', '--registry=https://registry.npmjs.org/')
Invoke-Checked npm.cmd @('view', '@zdevzone/keyforge-client@0.1.0', 'version', '--registry=https://registry.npmjs.org/')

# 2. Server CLI
Invoke-Checked vp @('-C', 'packages/create-keyforge', 'pm', 'publish', '--access', 'public', '--tag', 'latest', '--registry=https://registry.npmjs.org/')
Invoke-Checked npm.cmd @('view', 'create-keyforge@1.0.1', 'version', '--registry=https://registry.npmjs.org/')

# 3. Client CLI
Invoke-Checked vp @('-C', 'packages/create-keyforge-client', 'pm', 'publish', '--access', 'public', '--tag', 'latest', '--registry=https://registry.npmjs.org/')
Invoke-Checked npm.cmd @('view', 'create-keyforge-client@0.1.0', 'version', '--registry=https://registry.npmjs.org/')
```

The listed archive filenames and version checks match the current manifests. Update those examples to your new versions on subsequent releases. The SDK's `prepack` hook builds and verifies exports automatically for manual publication; GitHub Actions publishes the verified archives directly.

## Test the published packages

From a separate directory outside the repository, test both generators:

```sh
vp create keyforge@1.0.1
vp create keyforge-client@0.1.0
```

These same commands work in PowerShell. Interactive choices support Up/Down, Enter and Ctrl+C. Vite+ should finish at the generated project's root, without looking for removed upstream workspaces.

For an existing dependent app:

```sh
vp add @zdevzone/keyforge-client
```

Implement secure atomic storage, pin approved public keys and test offline restart before shipping; the starter's memory demo intentionally supports only local unlicensed status. See the [SDK guide](../packages/keyforge-client/README.md) and [client starter](../packages/create-keyforge-client/README.md).
