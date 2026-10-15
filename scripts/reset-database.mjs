import { inspectMaintenance, resetAppDatabase, cleanupLocalData } from "../dist/src/maintenance.js";
import { flags, requireOffline, maintenanceOptions } from "./maintenance-common.mjs";
const flag = flags();
try {
  const options = maintenanceOptions(flag),
    plan = await inspectMaintenance(options);
  console.log(JSON.stringify({ action: "drop and recreate", ...plan }, null, 2));
  if (!flag.has("apply"))
    console.log(
      "Preview only. To reset: vp run db:reset --apply --maintenance (add --scope/--confirm for a whole schema or database).",
    );
  else {
    await requireOffline(flag.has("maintenance"));
    await resetAppDatabase(options);
    if (flag.has("clean-local")) console.log(JSON.stringify(await cleanupLocalData(options, true)));
    if (flag.has("demo")) {
      const { seedDemo } = await import("./demo-seed.mjs");
      await seedDemo();
    }
    console.log(
      "Database recreated. Signing keys, encryption rings, provider credentials and remote buckets were preserved.",
    );
  }
} catch (error) {
  console.error(error?.message || "Reset failed.");
  process.exitCode = 1;
}
