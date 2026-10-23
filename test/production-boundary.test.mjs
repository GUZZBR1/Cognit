import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectProductionPackage } from '../scripts/check-production-boundary.mjs';

async function createPackageFixture(t, manifest, extraFiles = []) {
  const root = await mkdtemp(join(process.cwd(), '.tmp-production-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));

  for (const file of [...(manifest.files ?? []), ...extraFiles]) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'fixture');
  }
  return root;
}

test('passes a clean production package layout', async (t) => {
  const root = await createPackageFixture(t, {
    files: ['src/index.js'],
    dependencies: {},
  });

  assert.deepEqual(await inspectProductionPackage(root), { fileCount: 1, violations: [] });
});

test('flags lab dependencies in production dependency sections', async (t) => {
  const root = await createPackageFixture(t, {
    files: ['src/index.js'],
    dependencies: { 'selenium-webdriver': '^4.0.0' },
    optionalDependencies: { lightgbm: '^1.0.0' },
    peerDependencies: { xgboost: '^2.0.0' },
    devDependencies: { playwright: '^1.0.0', puppeteer: '^1.0.0' },
  });

  const { violations } = await inspectProductionPackage(root);
  assert.equal(violations.length, 3);
  assert.ok(violations.some((violation) => violation.includes('dependencies: selenium-webdriver')));
  assert.ok(violations.some((violation) => violation.includes('optionalDependencies: lightgbm')));
  assert.ok(violations.some((violation) => violation.includes('peerDependencies: xgboost')));
});

test('flags lab-only artifacts added to the production allowlist', async (t) => {
  const root = await createPackageFixture(t, {
    files: ['attack-lab/selenium.js', 'test/fixtures/sample.json', 'evaluation_runner.py', 'src/feature-pipeline.mjs', 'scripts/run-playwright.mjs'],
    dependencies: {},
  });

  const { violations } = await inspectProductionPackage(root);
  assert.equal(violations.length, 5);
  assert.ok(violations.every((violation) => violation.startsWith('lab-only artifact included in package:')));
});

test('allows Attack Lab files and tools in the experimental checkout when excluded from the package', async (t) => {
  const root = await createPackageFixture(t, {
    files: ['src/index.js'],
    dependencies: {},
    devDependencies: {
      playwright: '^1.0.0',
      puppeteer: '^1.0.0',
      'selenium-webdriver': '^4.0.0',
    },
  }, ['attack-lab/selenium.js', 'attack-lab/puppeteer.js', 'scripts/run-playwright.mjs']);

  assert.deepEqual(await inspectProductionPackage(root), { fileCount: 1, violations: [] });
});

test('requires explicit file paths rather than directories or globs', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.tmp-production-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'index.js'), 'fixture');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    files: ['src', 'src/*.js'],
    dependencies: {},
  }));

  const { violations } = await inspectProductionPackage(root);
  assert.ok(violations.includes('allowlisted package path is not a file: src'));
  assert.ok(violations.includes('package path must be an explicit repository-relative file: src/*.js'));
});
