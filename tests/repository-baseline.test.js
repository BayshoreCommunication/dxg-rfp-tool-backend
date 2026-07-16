const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('repository contains the required application boundaries', () => {
  const requiredPaths = [
    'server.ts',
    'routes',
    'controller',
    'middleware',
    'modal',
    'utils',
  ];

  for (const relativePath of requiredPaths) {
    assert.equal(
      fs.existsSync(path.join(root, relativePath)),
      true,
      `Missing required baseline path: ${relativePath}`,
    );
  }
});

test('package scripts expose a deterministic CI quality gate', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );

  assert.equal(typeof packageJson.scripts['type-check'], 'string');
  assert.equal(typeof packageJson.scripts.test, 'string');
  assert.equal(typeof packageJson.scripts.build, 'string');
  assert.equal(typeof packageJson.scripts.ci, 'string');
});

test('generated output and local secrets are excluded from TypeScript source', () => {
  const tsconfig = JSON.parse(
    fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'),
  );

  assert.ok(tsconfig.exclude.includes('node_modules'));
  assert.ok(tsconfig.exclude.includes('dist'));
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.env'), true);
});

test('HTTP controllers do not import persistence models or provider utilities', () => {
  const controllerDirectory = path.join(root, 'controller');
  const violations = [];
  for (const fileName of fs.readdirSync(controllerDirectory).filter((name) => name.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(controllerDirectory, fileName), 'utf8');
    for (const pattern of [
      /from\s+["'][^"']*\/modal\//,
      /from\s+["'][^"']*\/utils\//,
      /from\s+["'][^"']*\/config\/jwt["']/,
    ]) {
      if (pattern.test(source)) violations.push(`${fileName}: ${pattern}`);
    }
  }
  assert.deepEqual(violations, []);
});
