#!/usr/bin/env node
import { runCli } from "./commands.js";

try {
  await runCli();
} catch (error) {
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
}
