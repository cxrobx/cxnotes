const test = require('node:test');
const assert = require('node:assert');
const { parakeetCommand } = require('./transcriber');

test('parakeetCommand prefers the installed tool over uvx', () => {
  assert.deepStrictEqual(
    parakeetCommand('/u/.local/bin/parakeet-mlx', '/u/.local/bin/uvx'),
    { cmd: '/u/.local/bin/parakeet-mlx', prefix: [] },
  );
});

test('parakeetCommand falls back to uvx parakeet-mlx', () => {
  assert.deepStrictEqual(
    parakeetCommand(null, '/u/.local/bin/uvx'),
    { cmd: '/u/.local/bin/uvx', prefix: ['parakeet-mlx'] },
  );
});

test('parakeetCommand is null when neither is available', () => {
  assert.strictEqual(parakeetCommand(null, null), null);
});
