import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../src/index.js';

test('unknown API paths return not found', async () => {
  const request = new Request('https://openjob.softprobe.ai/v1/unknown');
  const response = await worker.fetch(request, {ASSETS: {fetch: async () => new Response('asset')}}, {});
  assert.equal(response.status, 404);
});
