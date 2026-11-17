import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const uploader = fileURLToPath(new URL('../scripts/upload-datasets-to-r2.mjs', import.meta.url));

function runUploader(directory, bucket, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [uploader, directory, bucket], {env});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({status, stdout, stderr}));
  });
}

test('uploads gzipped shards and publishes the manifest last through S3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openjob-r2-upload-'));
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    requests.push({url: new URL(request.url, 'http://127.0.0.1').pathname, contentType: request.headers['content-type'], authorization: request.headers.authorization});
    response.writeHead(200, {ETag: '"fixture"'}).end();
  });

  try {
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({snapshot_id: 'a'.repeat(64)}));
    await writeFile(join(directory, 'jobs-a.jsonl'), 'plain jsonl is not uploaded');
    await writeFile(join(directory, 'jobs-a.jsonl.gz'), Buffer.from('compressed fixture'));
    await writeFile(join(directory, 'record.schema.json'), '{"type":"object"}');

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const result = await runUploader(directory, 'openjob-datasets', {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_R2_ACCESS_KEY_ID: 'fixture-access-key',
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'fixture-secret-key',
        OPENJOB_R2_ENDPOINT: `http://127.0.0.1:${address.port}`,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Published OpenJob dataset snapshot/);
    assert.deepEqual(requests.map(({url}) => url), [
      `/openjob-datasets/snapshots/${'a'.repeat(64)}/jobs-a.jsonl.gz`,
      `/openjob-datasets/snapshots/${'a'.repeat(64)}/record.schema.json`,
      '/openjob-datasets/manifest.json',
    ]);
    assert.deepEqual(requests.map(({contentType}) => contentType), [
      'application/gzip',
      'application/json',
      'application/json',
    ]);
    assert.ok(requests.every(({authorization}) => authorization?.startsWith('AWS4-HMAC-SHA256 Credential=fixture-access-key/')));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});
