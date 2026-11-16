import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../src/index.js';

test('unknown API paths return not found', async () => {
  const request = new Request('https://openjob.softprobe.ai/v1/unknown');
  const response = await worker.fetch(request, {DATASETS: {get: async () => null}}, {});
  assert.equal(response.status, 404);
});

test('dataset routes stream objects from the R2 binding', async () => {
  const keys = [];
  const bytes = new TextEncoder().encode('{"snapshot_id":"current"}\n');
  const env = {DATASETS: {get: async key => {
    keys.push(key);
    if (key !== 'manifest.json') return null;
    return {body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),httpEtag:'etag',writeHttpMetadata(headers){headers.set('content-type','application/json');}};
  }}};
  const response = await worker.fetch(new Request('https://openjob.softprobe.ai/data/manifest.json'), env, {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"snapshot_id":"current"}\n');
  assert.deepEqual(keys, ['manifest.json']);
});
