#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCENARIOS, describeComparison, generateScenario } from './engine.mjs';

function parseArgs(args) {
  const options = { scenario: null, seed: null, trials: null, fixture: null, output: null, compare: null, config: null };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const values = { '--scenario': 'scenario', '--seed': 'seed', '--trials': 'trials', '--fixture': 'fixture', '--output': 'output', '--compare': 'compare', '--config': 'config' };
    if (!values[flag] || args[index + 1] === undefined) throw new Error(`unknown or incomplete option: ${flag}`);
    options[values[flag]] = args[++index];
  }
  return options;
}

function help() {
  return [
    'Usage: node examples/scripted-automation/run.mjs (--config <path> | --scenario <steady|bursty> --seed <value>) [options]',
    '',
    'Options:',
    '  --trials <count>       Challenge trials to run (default: 3)',
    '  --fixture <path>       Local challenge fixture (default: fixtures/challenge-v1.json)',
    '  --compare <scenario>   Add a descriptive comparison with a second scenario',
    '  --config <path>        JSON config with scenario_id, seed, optional trials, fixture and profile ranges',
    '  --output <path>        Write JSON to a file instead of stdout',
    '  --help                 Show this help',
  ].join('\n');
}

export async function runCli(args = process.argv.slice(2), cwd = process.cwd()) {
  let options = parseArgs(args);
  const explicitScenario = options.scenario;
  if (options.help) return { text: help(), exitCode: 0 };
  if (options.config) {
    const config = JSON.parse(await readFile(resolve(cwd, options.config), 'utf8'));
    options = { ...config, ...Object.fromEntries(Object.entries(options).filter(([key, value]) => key !== 'config' && value !== null)), config: options.config };
    if (explicitScenario) {
      options.scenario = explicitScenario;
      options.scenario_id = explicitScenario;
      options.profile = undefined;
    } else {
      options.scenario ??= config.scenario_id ?? 'steady';
    }
  }
  options.scenario ??= 'steady';
  options.trials = Number(options.trials ?? 3);
  options.fixture ??= 'fixtures/challenge-v1.json';
  if (options.seed === null || options.seed === undefined || options.seed === '') throw new Error('--seed is required directly or in --config');
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 1000) throw new Error('--trials must be an integer from 1 to 1000');
  if (options.profile && !options.config) throw new Error('custom profile must be supplied through --config');
  const profile = options.profile ?? DEFAULT_SCENARIOS[options.scenario];
  if (!profile) throw new Error(`unknown scenario: ${options.scenario}`);
  if (options.compare && !DEFAULT_SCENARIOS[options.compare]) throw new Error(`unknown comparison scenario: ${options.compare}`);
  const fixturePath = resolve(cwd, options.fixture);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const fixtureName = options.fixture.replaceAll('\\', '/');
  const first = generateScenario({ fixture, fixtureName, scenarioId: options.scenario_id ?? options.scenario, seed: options.seed, trials: options.trials, profile });
  let records = first;
  let comparison = null;
  if (options.compare) {
    const second = generateScenario({ fixture, fixtureName, scenarioId: options.compare, seed: options.seed, trials: options.trials });
    records = [...first, ...second];
    comparison = describeComparison(first, second);
  }
  const output = `${JSON.stringify({ schema_version: 1, evidence_class: 'SIMULATED', records, comparison }, null, 2)}\n`;
  if (options.output) await writeFile(resolve(cwd, options.output), output, 'utf8');
  return { text: output, exitCode: 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await runCli();
    process.stdout.write(result.text);
  } catch (error) {
    process.stderr.write(`scripted automation: ${error.message}\n`);
    process.exitCode = 1;
  }
}
