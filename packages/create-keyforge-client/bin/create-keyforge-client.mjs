#!/usr/bin/env node
import { main } from "../src/index.mjs";

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`create-keyforge-client: ${error.message}`);
  process.exitCode = 1;
}
