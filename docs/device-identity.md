# Desktop device recognition and language support

## Which integration should an app use?

The HTTP API is language- and framework-independent. Any application able to make HTTPS requests can register an installation, activate/refresh/deactivate a license and use the permitted customer endpoints. See [OpenAPI](client-openapi.json), [the API reference](api.md) and [integration guide](dependent-app-integration.md).

The official SDK is currently **JavaScript/TypeScript only**. The core `@zdevzone/keyforge-client` uses Fetch, Web Crypto and explicit application-supplied secure storage. Optional OS collectors run in a **trusted Node process**; they are separate imports and never enter the core/browser bundle. No Python, C#, Go, Rust, Swift or mobile SDK is shipped. Node 22.18+ is the reference runtime; package publication remains a separate release step.

The SDK adds work an ordinary REST wrapper does not do: create and securely persist installation identity/credential, preserve exact registration UUID/body across retries and restarts, retry transient failures with bounds, verify pinned Ed25519 v1 grants, enforce signed deadlines/context/status and maintain trial consumption across refresh. Applications still enforce their own entitlements at protected operations. Online API inspection alone does not produce offline authorization.

Other languages can implement this contract directly. Verify the exact decoded JSON bytes and token schemas described in [token verification](verify-token.md); these tokens are not JWTs. An OpenAPI-generated HTTP client does not automatically supply secure storage, offline verification, clock handling or an idempotent onboarding workflow. Do not embed Node merely to call REST from an otherwise native app. Add a native SDK when a real dependent application's language justifies maintaining and testing it. Keep the HTTP contract, shared hash/token vectors and integration skill as the common reference.

## Opt-in automatic desktop collection

```ts
import { KeyForgeClient } from "@zdevzone/keyforge-client";
import { createDeviceSignalsProvider } from "@zdevzone/keyforge-client/device-signals";

const client = new KeyForgeClient({
  serverUrl, productId, publicKeys, storage,
  deviceSignalsProvider: createDeviceSignalsProvider(),
});
await client.activate(customerLicenseKey); // online registration/activation
const diagnostics = await client.getDeviceSignalsDiagnostics();
// Later, recollect metadata for the same authenticated identity:
await client.updateDeviceSignals();
```

Explicit adapters remain available as `@zdevzone/keyforge-client/windows`, `/linux`, and `/macos`, exporting `createWindowsDeviceSignalsProvider`, `createLinuxDeviceSignalsProvider`, and `createMacOSDeviceSignalsProvider`. Existing Windows imports, manual signals, registration state and v1 hashes remain compatible. The Node reference enables automatic selection with `KEYFORGE_DEVICE_SIGNALS=1`; its older `KEYFORGE_WINDOWS_SIGNALS=1` option remains Windows-only.

| Desktop OS | Reported kinds | Fixed read-only sources |
| --- | --- | --- |
| Windows | `machine-guid`, `smbios-uuid`, `volume-serial` | MachineGuid registry value, SMBIOS system UUID, system-volume serial via hidden PowerShell |
| Linux | `linux-machine-id`, `smbios-uuid`, `root-volume-uuid` | `/etc/machine-id` (missing/empty fallback `/var/lib/dbus/machine-id`), `/sys/class/dmi/id/product_uuid`, `findmnt --noheadings --raw --output UUID --target /` |
| macOS | `macos-platform-uuid`, `root-volume-uuid` | `IOPlatformUUID` from `/usr/sbin/ioreg -r -d 1 -c IOPlatformExpertDevice -w 0`; `VolumeUUID` from `/usr/sbin/diskutil info -plist /` |

No sudo, elevation prompt, device writes, CPU IDs, MAC/IP addresses or hardware serial-number collection is introduced. Native tools use absolute executable paths and argument arrays; no caller input is interpolated into a shell. Queries have an eight-second deadline. Reads/individual returned values are limited to 4 KiB; Apple utility output is bounded to 64 KiB and reduced locally to the named scalar before normalization. Error text and raw utility output are never returned in reports, persisted or transmitted. No snapshot UUID is substituted for a missing macOS volume UUID.

Available means a complete expected set for an OS (three Windows/Linux kinds or two macOS kinds). Partial means some evidence; Unavailable means none. Group rows describe retained historical evidence, whereas installation rows describe their latest report. Missing permissions, tools, unsupported filesystems, containers/VMs, Linux ARM hardware without DMI, sandboxing and OEM placeholders can legitimately yield partial/unavailable reports. Linux DMI product UUID is commonly root-readable only: report permission denial; do not request sudo. The adapter still operates without it.

Browsers, iOS, Android and other sandboxed runtimes do not gain unrestricted desktop hardware access through this SDK. They continue using secure installation identity and HTTP; use a host-provided signal adapter only when that platform legitimately exposes suitable identifiers. Unsupported Node platforms return an empty safe report. There is no promise of one physical identity across dual boot, OS reinstalls, hardware changes or cloned VMs.

## Shared v1 normalization and hashing

The existing [Windows v1 contract](windows-device-identity.md) is preserved. UUIDs normalize to trimmed lowercase unbraced hyphenated hex; reject all-zero/all-`f`, repeated-digit and known OEM placeholders. Linux machine IDs must be exactly 32 lowercase hex digits after trimming/lowercasing (reject repeated digits/uninitialized/empty values). Root-volume UUIDs use the UUID normalization, with no fabricated fallback ID for unsupported formats. Windows volume serial normalization is unchanged.

Hash each signal separately as SHA-256 over compact UTF-8 JSON:

```text
["keyforge-device-signals",1,canonicalServerUrl,productId,kind,normalizedIdentifier]
```

Deployment URL and product scope prevent global cross-product fingerprints. Canonical URL is `new URL(serverUrl).toString()` with a final slash removed and no credentials, query or fragment. For `https://licenses.example.test` / `studio`:

| Kind | Normalized fixture | SHA-256 |
| --- | --- | --- |
| `machine-guid` | `a1234567-b123-c123-d123-e123456789ab` | `aa7f9a3b0eeee456daced7ae390c08795b46934418950b09e5a7aeb7a0d8127f` |
| `linux-machine-id` | `a1234567b123c123d123e123456789ab` | `f7736a4b994708015d9f047378b6db01b7e794ac9301f59ee354e4e4dc76e47a` |
| `macos-platform-uuid` | `a1234567-b123-c123-d123-e123456789ab` | `2c696778660c3bf7a4245764b919128ecb411182f33caced158fa3b405870fe3` |

Raw values stay local. Treat hashes as pseudonymous metadata and explain optional collection to users. Systemd explicitly treats machine-id as confidential and recommends app-specific derivation: [systemd identity guidance](https://www.freedesktop.org/software/systemd/man/sd_id128_get_machine.html). DMI availability/permissions follow [Linux's DMI sysfs interface](https://github.com/torvalds/linux/blob/master/drivers/firmware/dmi-id.c); Apple documents the read-only [ioreg tool](https://github.com/apple-oss-distributions/IOKitTools/blob/main/ioreg.tproj/ioreg.8). Volume identifiers describe a filesystem, not attested physical hardware.

## Existing installations and server compatibility

Upgrade the server before using new kinds. Older servers ignore unknown registration hints and may reject new kinds on backfill; that must not be treated as authorization. Existing Windows state requires no migration. Newly collected registration hashes are persisted before networking and replayed unchanged after interruptions, even when hardware/provider options change. Do not erase credentials or change a pending body to refresh signals.

`updateDeviceSignals()` requires successful prior registration and the same installation credential. It adds recognition evidence to that installation's existing group without automatic group merges. It does not issue a license, consume/release a seat, restart trials, reset usage or alter financial records. Initial registration and backfill support at most three current signals; historical groups can retain older kinds. Changes to server URL/product require a coordinated credential-preserving state migration, not silent identity replacement. Avoid SDK downgrades that cannot understand newly stored kinds.

Two distinct matching kinds remain the threshold for recognizing a new registration. Signals are forgeable hints, not proof of physical-device count; a missing second signal can prevent recognition across a reinstall. Installation-based license limits, operator-assisted recovery and signed offline policy remain the actual licensing rules.
