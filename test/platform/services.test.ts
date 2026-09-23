import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiLabel } from '../../src/services/services.ts';

test('the API a service was started against, by its label', () => {
  const hosts = 'localhost:8080=local api.example.com=staging';
  assert.equal(apiLabel(['VITE_API_URL=http://localhost:8080'], hosts), 'local');
  assert.equal(apiLabel(['PORT=3000', 'API=https://api.example.com/v1/x'], hosts), 'staging');
  assert.equal(apiLabel(['API=https://other.example.com/'], hosts), 'other.example.com');
  // The last url wins, as each one overwrote the file.
  assert.equal(apiLabel(['A=http://localhost:8080', 'B=https://api.example.com'], hosts), 'staging');
  assert.equal(apiLabel(['PORT=3000'], hosts), '');
  // Only http(s) loses its scheme: a ws url keeps the part before its first slash.
  assert.equal(apiLabel(['WS=ws://h:1/x'], hosts), 'ws:');
});
