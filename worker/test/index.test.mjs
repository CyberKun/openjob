import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../src/index.js';

test('site requests pass through to the configured origin', async () => {
  const originalFetch = globalThis.fetch;
  let fetched;
  globalThis.fetch = async request => {
    fetched = request;
    return new Response('origin page');
  };
  try {
    const request = new Request('https://openjob.softprobe.ai/about/');
    const response = await worker.fetch(request, {ASSETS: {fetch: async () => new Response('asset')}}, {});
    assert.equal(await response.text(), 'origin page');
    assert.equal(fetched.url, request.url);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
