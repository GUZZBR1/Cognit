import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LAB_DEPENDENCIES = new Set([
  'playwright',
  'puppeteer',
  'selenium-webdriver',
  'lightgbm',
  'xgboost',
]);

const LAB_ARTIFACT_FILES = new Set([
  'ai_observer.py',
  'benchmark_report.py',
  'evaluation_harness.py',
  'evaluation_runner.py',
  'scripts/run-playwright.mjs',
  'src/feature-pipeline.mjs',
  'src/human-dataset.js',
  'src/session-signature.mjs',
  'supervised_classifier.py',
]);

function normalizePath(filePath) {
  return String(filePath).replaceAll('\\', '/').replace(/^\.\//, '');
}

function isLabArtifact(filePath) {
  const path = normalizePath(filePath);
  const segments = path.split('/');
  const basename = segments.at(-1) ?? '';

  return (
    LAB_ARTIFACT_FILES.has(path) ||
    segments.includes('attack-lab') ||
    segments.includes('test') ||
    segments.includes('tests') ||
    segments.includes('fixtures') ||
    segments.some((segment) => /^(datasets?|benchmarks?)$/i.test(segment)) ||
    /^(evaluation[_-].*|.*[_-]evaluation\.(?:py|mjs|cjs|js|ts)|test_.*\.(?:py|mjs|cjs|js|ts))$/i.test(basename) ||
    /^(benchmark[_-].*|.*[_-]benchmark\.(?:py|mjs|cjs|js|ts))$/i.test(basename) ||
    /^(supervised_classifier|human-dataset)\.(?:py|mjs|cjs|js|ts)$/i.test(basename) ||
    /(?:^|[/_-])(?:human[-_])?datasets?(?:[/_.-]|$)/i.test(path)
  );
}

function isExplicitFilePath(filePath) {
  const path = normalizePath(filePath);
  return path.length > 0 &&
    !path.startsWith('/') &&
    !/^[a-z]:\//i.test(path) &&
    !path.split('/').includes('..') &&
    !/[?*\[\]!]/.test(path);
}

/** Return package-boundary violations without invoking npm or reading files. */
export function validateProductionBoundary(packFiles, manifest) {
  const violations = [];
  for (const file of packFiles) {
    const path = typeof file === 'string' ? file : file?.path;
    if (typeof path !== 'string' || !isExplicitFilePath(path)) {
      violations.push(`package path must be an explicit repository-relative file: ${String(path)}`);
    } else if (isLabArtifact(path)) {
      violations.push(`lab-only artifact included in package: ${normalizePath(path)}`);
    }
  }

  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest?.[section] ?? {};
    for (const name of Object.keys(dependencies)) {
      if (LAB_DEPENDENCIES.has(name)) {
        violations.push(`lab-only dependency in ${section}: ${name}`);
      }
    }
  }
  return violations;
}

export async function inspectProductionPackage(root) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  } catch (error) {
    return { fileCount: 0, violations: [`could not read package.json (${error.message})`] };
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { fileCount: 0, violations: ['package.json must define a non-empty files allowlist'] };
  }

  const violations = validateProductionBoundary(manifest.files, manifest);
  for (const file of manifest.files) {
    if (typeof file !== 'string' || !isExplicitFilePath(file)) continue;
    try {
      if (!(await lstat(resolve(root, file))).isFile()) {
        violations.push(`allowlisted package path is not a file: ${file}`);
      }
    } catch {
      violations.push(`allowlisted package file does not exist: ${file}`);
    }
  }
  return { fileCount: manifest.files.length, violations };
}

async function main() {
  const { fileCount, violations } = await inspectProductionPackage(process.cwd());
  if (violations.length) {
    console.error(`FAIL production boundary check (${violations.length} violation${violations.length === 1 ? '' : 's'}):`);
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS production boundary check (${fileCount} allowlisted paths inspected)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
