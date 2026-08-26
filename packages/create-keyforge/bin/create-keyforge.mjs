#!/usr/bin/env node
import { main } from "../src/index.mjs";

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`\ncreate-keyforge: ${error.message}\n`);
  process.exitCode = 1;
}
