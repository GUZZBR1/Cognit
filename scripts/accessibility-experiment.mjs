#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReport } from '../src/accessibility-experiment.mjs';

export async function run(inputPath) {
  if (!inputPath) throw new Error('usage: node scripts/accessibility-experiment.mjs <sessions.json>');
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  process.stdout.write(`${JSON.stringify(buildReport(input), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await run(process.argv[2]);
  } catch (error) {
    console.error(`accessibility experiment: ${error.message}`);
    process.exitCode = 1;
  }
}
