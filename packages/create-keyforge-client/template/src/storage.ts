import { MemoryStorage, type SecureStorage } from "@zdevzone/keyforge-client";

export function createStorage(demo: boolean): SecureStorage {
  if (demo) return new MemoryStorage();
  // Implement load/save using your OS credential vault. Save one atomic record
  // containing identity, pending registration, grants, counters and clock state.
  // Encrypt file-backed state with a vault-held key and atomically replace it.
  // Keep one SDK owner per installation; coordinate multiple processes explicitly.
  throw new Error("Implement the secure storage adapter in src/storage.ts first.");
}
