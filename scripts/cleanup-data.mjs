import { cleanupLocalData } from "../dist/src/maintenance.js";
import { flags, requireOffline } from "./maintenance-common.mjs";
const flag = flags();
try {
  if (flag.has("apply")) await requireOffline(flag.has("maintenance"));
  console.log(JSON.stringify(await cleanupLocalData({}, flag.has("apply")), null, 2));
  if (!flag.has("apply"))
    console.log(
      "Preview only. Remove obsolete local data with vp run data:clean --apply --maintenance. Use db:reset to clear the active database.",
    );
} catch (error) {
  console.error(error?.message || "Cleanup failed.");
  process.exitCode = 1;
}
