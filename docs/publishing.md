# Publishing KeyForge packages

Release from the public [zdevzone/keyforge](https://github.com/zdevzone/keyforge) repository. The root app is private and must never be published. The public repository is now authoritative; no private-to-public synchronization step is needed.

| Order | Package | Next stable version |
| --- | --- | --- |
| 1 | `@zdevzone/keyforge-client` | `0.1.1` |
| 2 | `create-keyforge` | `1.0.2` |
| 3 | `create-keyforge-client` | `0.1.1` |

Previously published stable versions remain available until a deliberate stable release. `@keyforge/client` is unrelated to this project; do not publish to it. Never unpublish packages to repair a release or reuse an old version.

## GitHub Actions releases (recommended)

[release.yml](https://github.com/zdevzone/keyforge/blob/main/.github/workflows/release.yml), **Release npm packages**, is manually dispatched only in the public repository. Choose a channel and branch:

| Channel | Branch | npm tag | Version |
| --- | --- | --- | --- |
| stable | main | latest | Committed manifest version |
| beta | dev | beta | `<next-stable>-beta.<run-id>.<attempt>` |

Wrong branch/channel combinations fail before building or publishing. **Dry run** defaults to true. A beta never changes `latest`. Beta versions are generated in temporary packaging copies; committed versions remain stable. The client starter installs its exact beta SDK, while stable starters use a compatible stable range. Server starter archives pin their default template to the tested source commit. An explicit `--template` remains available.

Before publication the workflow requires successful branch CI, including its database and operating-system checks, then runs lint/format/typechecks, builds, Node tests, package smoke checks and all three browser suites. It packs all three archives, verifies their contents and release metadata, and exercises those exact archives through both generators. The publish job downloads the checked archives without rebuilding. Archives are retained for seven days.

Only the publish job receives `id-token: write`. npm trusted publishing provides OIDC authentication and provenance; no `NPM_TOKEN` is needed. Package versions are published in SDK → server CLI → client CLI order. Each must become visible with matching SHA-512 integrity before the next starts; registry processing is allowed up to five minutes plus request time.

### Trusted publisher and approval setup

All three packages must configure the same relationship in npm **Settings → Trusted publishing**:

| Field | Value |
| --- | --- |
| Organization/user | zdevzone |
| Repository | keyforge |
| Workflow filename | release.yml |
| Environment | npm |
| Permission | Publish |

Inspect existing entries before adding one; preserve unrelated intentional relationships. Use the filename only, not `.github/workflows/release.yml`. npm configuration requires package write access and account two-factor authentication. New unvalidated trust configurations must be exercised promptly; see [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The GitHub environment `npm` permits only the protected `main` and `dev` branches and requires the owner's manual approval. Self-approval is allowed for a solo maintainer. A real maintainer team should require independent review instead. Do not put a personal npm token in Actions secrets.

The following commands work in **Bash and Windows PowerShell**:

```sh
# Check and pack without publication.
gh workflow run release.yml --repo zdevzone/keyforge --ref dev -f channel=beta -F dry_run=true
# After reviewing a successful dry run, request a beta and approve its npm environment job.
gh workflow run release.yml --repo zdevzone/keyforge --ref dev -f channel=beta -F dry_run=false
# Stable releases are a separate deliberate action after promotion and checks.
gh workflow run release.yml --repo zdevzone/keyforge --ref main -f channel=stable -F dry_run=true
gh workflow run release.yml --repo zdevzone/keyforge --ref main -f channel=stable -F dry_run=false
# Find the run ID, then inspect or watch it.
gh run list --repo zdevzone/keyforge --workflow release.yml --limit 5
gh run watch RUN_ID --repo zdevzone/keyforge --exit-status
```

In the GitHub UI select **Actions → Release npm packages → Run workflow**, choose the branch/channel, and leave dry run checked initially. A successful dry run does not validate OIDC; an actual approved beta release does. Package publishing does not deploy the website.

### Version updates and recovery

Bump changed package manifests and the client starter's `keyforgeSdkVersion` together. Also bump the server CLI whenever its default server-source commit changes, because that pin is part of its immutable package. Unchanged stable SDK/client archives can be reused without adding unrelated source metadata. Then run the required checks, and merge the change through `dev`. Use a promotion PR for a stable release. Beta packaging appends the current run ID/attempt to those next-stable versions. It does not push commits or tags.

All archives and existing versions are inspected before the first publish. A matching existing archive is skipped; a different integrity stops the release. Publication is not atomic across three packages. If a later package fails, keep earlier successes published. A failed publish job can be rerun using its existing checked artifacts and original beta attempt: the workflow records that attempt with the artifacts. Rerunning all jobs creates a new beta attempt and therefore new beta versions. Stable reruns use the same manifest versions and must have identical archives. Already published versions are not retagged automatically.

Verify registry metadata and both generators before announcing a release:

```sh
vp add @zdevzone/keyforge-client@beta
vp create keyforge@beta
vp create keyforge-client@beta
```

Use a separate disposable directory and the matching staging server/public keys. `@beta` is explicitly opt-in. Plain `vp add @zdevzone/keyforge-client` and `vp create keyforge` continue using `latest`.

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

tar -tzf .artifacts/zdevzone-keyforge-client-0.1.1.tgz
tar -tzf .artifacts/create-keyforge-1.0.2.tgz
tar -tzf .artifacts/create-keyforge-client-0.1.1.tgz
```

Review the archives before continuing. The SDK must include `package/dist/index.js`, declarations and Windows/Linux/macOS/automatic device-signal modules. A README-and-skill-only archive is broken: stop. Never disable lifecycle scripts. No signing keys, environment files, databases or credentials belong in these archives.

```bash
# 1. SDK
vp -C packages/keyforge-client pm publish --access public --tag latest --registry=https://registry.npmjs.org/
npm view @zdevzone/keyforge-client@0.1.1 version --registry=https://registry.npmjs.org/

# 2. Server CLI
vp -C packages/create-keyforge pm publish --access public --tag latest --registry=https://registry.npmjs.org/
npm view create-keyforge@1.0.2 version --registry=https://registry.npmjs.org/

# 3. Client CLI
vp -C packages/create-keyforge-client pm publish --access public --tag latest --registry=https://registry.npmjs.org/
npm view create-keyforge-client@0.1.1 version --registry=https://registry.npmjs.org/
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

Invoke-Checked tar.exe @('-tzf', '.artifacts/zdevzone-keyforge-client-0.1.1.tgz')
Invoke-Checked tar.exe @('-tzf', '.artifacts/create-keyforge-1.0.2.tgz')
Invoke-Checked tar.exe @('-tzf', '.artifacts/create-keyforge-client-0.1.1.tgz')
```

Review the archives as described above, then publish in order. Complete npm's sign-in or two-factor prompts when requested.

```powershell
# 1. SDK
Invoke-Checked vp @('-C', 'packages/keyforge-client', 'pm', 'publish', '--access', 'public', '--tag', 'latest', '--registry=https://registry.npmjs.org/')
Invoke-Checked npm.cmd @('view', '@zdevzone/keyforge-client@0.1.1', 'version', '--registry=https://registry.npmjs.org/')

# 2. Server CLI
Invoke-Checked vp @('-C', 'packages/create-keyforge', 'pm', 'publish', '--access', 'public', '--tag', 'latest', '--registry=https://registry.npmjs.org/')
Invoke-Checked npm.cmd @('view', 'create-keyforge@1.0.2', 'version', '--registry=https://registry.npmjs.org/')

# 3. Client CLI
Invoke-Checked vp @('-C', 'packages/create-keyforge-client', 'pm', 'publish', '--access', 'public', '--tag', 'latest', '--registry=https://registry.npmjs.org/')
Invoke-Checked npm.cmd @('view', 'create-keyforge-client@0.1.1', 'version', '--registry=https://registry.npmjs.org/')
```

The listed archive filenames and version checks match the current manifests. Update those examples to your new versions on subsequent releases. The SDK's `prepack` hook builds and verifies exports automatically for manual publication; GitHub Actions publishes the verified archives directly.

## Test the published packages

From a separate directory outside the repository, test both generators:

```sh
vp create keyforge@1.0.2
vp create keyforge-client@0.1.1
```

These same commands work in PowerShell. Interactive choices support Up/Down, Enter and Ctrl+C. Vite+ should finish at the generated project's root, without looking for removed upstream workspaces.

For an existing dependent app:

```sh
vp add @zdevzone/keyforge-client
```

Implement secure atomic storage, pin approved public keys and test offline restart before shipping; the starter's memory demo intentionally supports only local unlicensed status. See the [SDK guide](../packages/keyforge-client/README.md) and [client starter](../packages/create-keyforge-client/README.md).
