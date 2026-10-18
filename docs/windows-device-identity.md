# Optional Windows device recognition

Windows remains supported with the same v1 hashes and `/windows` entry point. For automatic Windows/Linux/macOS selection and language/runtime guidance, see [desktop device identity](device-identity.md).

The SDK always creates a random installation ID and an independent secret. These remain the authenticated identity and the unit counted by activation limits. Optional Windows signals help recognize reported machine groups across installations; they do not attest to a physical device or prevent credential cloning.

## Enable the adapter

```ts
import { KeyForgeClient } from "@zdevzone/keyforge-client";
import { createWindowsDeviceSignalsProvider } from "@zdevzone/keyforge-client/windows";

const client = new KeyForgeClient({
  serverUrl, productId, publicKeys,
  storage, // application-supplied, atomic secure storage
  deviceSignalsProvider: createWindowsDeviceSignalsProvider(),
});
await client.activate(customerKey);
const diagnostics = await client.getDeviceSignalsDiagnostics();
```

Only the `/windows` entry point imports Node built-ins. Use it in an installed app's trusted Node process, not a browser renderer. No Electron dependency or production storage default is supplied. Collection is opt-in. Existing `registration.machineSignals` manual inputs take precedence at initial registration; the provider supplies subsequent backfill. The Node example enables collection only with `KEYFORGE_WINDOWS_SIGNALS=1`.

The adapter runs three fixed read-only PowerShell queries: Windows `MachineGuid`, `Win32_ComputerSystemProduct.UUID`, and `Win32_LogicalDisk.VolumeSerialNumber` for `SystemDrive`. It uses an absolute system PowerShell path, no profile/noninteractive mode, hidden windows, an 8-second timeout and 4 KiB output limit per subprocess. It requests no elevation. CPU identifiers, MAC addresses and IP addresses are not collected. Raw values remain inside the provider and are never sent or persisted by the SDK.

Permissions, missing values, OEM placeholders, subprocess failure and non-Windows runtimes produce kind-specific diagnostic codes without identifiers, command output or exception text. Remaining signals are usable; missing signals never replace credentials or block ordinary licensing. Treat hashes as pseudonymous metadata, not anonymous data: low-entropy identifiers can be guessed. Explain collection to users and protect SDK state and server backups.

## Hash scheme v1

1. Trim surrounding whitespace and lowercase ASCII hex values.
2. Machine GUID/system UUID: accept a hyphenated UUID, optionally enclosed in braces. Reject all-zero/all-`f`, repeated-digit and known OEM placeholder UUIDs. UUID version bits are not required because SMBIOS identifiers are not necessarily RFC-generated UUIDs.
3. Volume serial: exactly eight hex digits, optionally `XXXX-XXXX`; remove the hyphen. Reject `00000000`, `ffffffff` and `12345678` placeholders.
4. Canonical deployment is `new URL(serverUrl).toString()` with one final slash removed. Credentials, query strings and fragments are forbidden. Product IDs are stable lowercase slugs.
5. SHA-256 hash the UTF-8 bytes of the compact `JSON.stringify` array:

```text
["keyforge-device-signals",1,"https://licenses.example.test","studio","machine-guid","a1234567-b123-c123-d123-e123456789ab"]
SHA-256 = aa7f9a3b0eeee456daced7ae390c08795b46934418950b09e5a7aeb7a0d8127f
```

Each signal has a separate digest. Deployment URL, product, kind and version separate namespaces. No raw identifier or global cross-product fingerprint is transmitted. A deployment URL/custom-domain change changes hashes and SDK storage context; plan a credential-preserving storage migration and authenticated backfill with the operator instead of silently registering new identities. Never automatically downgrade to unscoped hashing.

## Registration, updates and recovery

Initial collection happens only when creating SDK state. The SDK atomically saves identity, credential, exact registration UUID/body and diagnostics **before** the first request. Restarts and ambiguous response loss replay that saved registration even if hardware or provider options change. Do not erase state to refresh metadata.

Call `await client.updateDeviceSignals()` while online to recollect and send recognition hints through the installation-authenticated PUT. It preserves the original registration body. Updates never increment trial counters, reset local consumption/server meters, change bindings, release seats, create licenses or modify sales. If collection is unavailable, current installation availability becomes Unavailable; historical evidence stays retained. Retrying an interrupted update is safe.

Authenticated signal updates enrich an existing registered identity without consuming seats or restarting trials. Only the documented v1 hash scheme is used.

Two distinct matching kinds can associate a **new registration** with a group under existing trial policy; common hashes are excluded. Hardware may be missing, replaced, cloned or forged. Matching never transfers a paid seat. Lost credentials require a new identity and operator-assisted seat recovery. Windows reinstalls and hardware/volume changes may affect recognition. Restore secure app state when possible; never use a hash as a credential.

## Console interpretation

- **Installations:** authenticated identities, active licensed counts, current signal kinds and group references. Available means all three kinds; Partial means one or two; Unavailable means none. Missing individual signal metadata is shown as Unavailable; group evidence is never substituted for an installation report.
- **Machines:** reported groups and historical evidence, registration counts and trial clear state. Availability describes retained evidence, not a live inspection. Last registration and last signal update are separate timestamps.
- **License activations:** binding history and active installation seats, with group references. Release permissions and installation limits are unchanged.

These are not verified physical-device counts. TPM attestation and physical-device enforcement are outside this implementation.
