#!/usr/bin/env node
import { evaluateOfflineMatrix } from "./evaluation.js";

const summary = await evaluateOfflineMatrix();
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (!summary.ok) process.exitCode = 1;
