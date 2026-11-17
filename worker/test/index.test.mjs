import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import worker from '../src/index.js';
import {serveDataAsset} from '../src/data.js';

test('unknown API paths return not found', async () => {
  const request = new Request('https://openjob.softprobe.ai/api/v1/unknown');
  const response = await worker.fetch(request, {DATASETS: {get: async () => null}}, {});
  assert.equal(response.status, 404);
});

test('dataset routes stream objects from the R2 binding', async () => {
  const keys = [];
  const bytes = new TextEncoder().encode('{"snapshot_id":"current"}\n');
  const env = {DATASETS: {get: async key => {
    keys.push(key);
    if (key !== 'test.json') return null;
    return {body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),httpEtag:'etag',writeHttpMetadata(headers){headers.set('content-type','application/json');}};
  }}};
  const response = await worker.fetch(new Request('https://openjob.softprobe.ai/api/data/test.json'), env, {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"snapshot_id":"current"}\n');
  assert.deepEqual(keys, ['test.json']);
});

function r2Object(bytes, key, onCancel = () => {}, holdOpen = false) {
  return {
    body: new ReadableStream({
      start(controller) { controller.enqueue(bytes); if (!holdOpen) controller.close(); },
      cancel() { onCancel(); },
    }),
    httpEtag: `etag-${key}`,
    writeHttpMetadata(headers) {
      headers.set('content-type', 'application/gzip');
      headers.set('content-encoding', 'gzip');
      headers.set('content-length', String(bytes.byteLength));
    },
  };
}

test('plain JSONL decompresses gzip and drops stored-object headers', async () => {
  const plain = Buffer.from('{"path":"jobs/example.md"}\n');
  const compressed = gzipSync(plain);
  const keys = [];
  const env = {DATASETS: {get: async key => {
    keys.push(key);
    return r2Object(compressed, key);
  }}};
  const response = await worker.fetch(new Request('https://openjob.softprobe.ai/api/data/jobs-000.jsonl'), env, {});

  assert.equal(response.status, 200);
  assert.equal(await response.text(), plain.toString());
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.has('content-encoding'), false);
  assert.equal(response.headers.has('content-length'), false);
  assert.equal(response.headers.has('etag'), false);
  assert.deepEqual(keys, ['jobs-000.jsonl.gz']);
});

test('gzip download preserves the stored bytes without HTTP content encoding', async () => {
  const compressed = gzipSync(Buffer.from('{"path":"jobs/example.md"}\n'));
  const env = {DATASETS: {get: async key => r2Object(compressed, key)}};
  const response = await worker.fetch(new Request('https://openjob.softprobe.ai/api/data/jobs-000.jsonl.gz'), env, {});

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  assert.equal(response.headers.get('etag'), 'etag-jobs-000.jsonl.gz');
  assert.equal(response.headers.has('content-encoding'), false);
});

test('HEAD cancels the unused R2 body without decompressing it', async () => {
  let cancelled = false;
  const compressed = gzipSync(Buffer.from('unused'));
  const env = {DATASETS: {get: async key => r2Object(compressed, key, () => { cancelled = true; }, true)}};
  const response = await worker.fetch(new Request('https://openjob.softprobe.ai/api/data/jobs-000.jsonl', {method: 'HEAD'}), env, {});

  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(cancelled, true);
});

test('POST is rejected before reading R2', async () => {
  let reads = 0;
  const env = {DATASETS: {get: async () => { reads++; return null; }}};
  const response = await worker.fetch(new Request('https://openjob.softprobe.ai/api/data/manifest.json', {method: 'POST'}), env, {});

  assert.equal(response.status, 405);
  assert.equal(reads, 0);
});

test('encoded traversal paths are rejected before reading R2', async () => {
  let reads = 0;
  const env = {DATASETS: {get: async () => { reads++; return null; }}};
  for (const url of [
    'https://openjob.softprobe.ai/data/%5c..%5csecret',
    'https://openjob.softprobe.ai/data/%2e%2e/secret',
    'https://openjob.softprobe.ai/data/a%2f..%2fsecret',
  ]) {
    const response = await serveDataAsset({method: 'GET', url}, env);
    assert.equal(response.status, 400, url);
  }
  assert.equal(reads, 0);
});
