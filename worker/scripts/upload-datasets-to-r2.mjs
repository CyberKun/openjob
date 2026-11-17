import {readFile, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {PutObjectCommand, S3Client} from '@aws-sdk/client-s3';

const [datasetsDir, bucket = 'openjob-datasets'] = process.argv.slice(2);
if (!datasetsDir) throw new Error('usage: upload-datasets-to-r2.mjs DATASETS_DIRECTORY [BUCKET]');

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) {
  throw new Error('Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, and CLOUDFLARE_R2_SECRET_ACCESS_KEY');
}

if (!(await stat(datasetsDir)).isDirectory()) throw new Error(`Dataset directory not found: ${datasetsDir}`);
const manifestPath = join(datasetsDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const snapshot = manifest.snapshot_id;
if (!/^[0-9a-f]{64}$/.test(snapshot || '')) throw new Error('Invalid snapshot ID in dataset manifest');

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.OPENJOB_R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {accessKeyId, secretAccessKey},
});

async function putObject(key, filePath, contentType) {
  const body = await readFile(filePath);
  if (body.length === 0) throw new Error(`Cannot upload empty dataset artifact: ${filePath}`);
  await client.send(new PutObjectCommand({Bucket: bucket, Key: key, Body: body, ContentType: contentType}));
}

try {
  const names = (await readdir(datasetsDir)).sort();
  for (const name of names) {
    if (name === 'manifest.json') continue;
    let contentType;
    if (name.endsWith('.jsonl')) continue;
    if (name.endsWith('.jsonl.gz')) contentType = 'application/gzip';
    else if (name.endsWith('.json')) contentType = 'application/json';
    else throw new Error(`Unexpected dataset artifact: ${name}`);
    await putObject(`snapshots/${snapshot}/${name}`, join(datasetsDir, name), contentType);
  }

  // Publish the pointer only after every immutable snapshot object is present.
  await putObject('manifest.json', manifestPath, 'application/json');
  console.log(`Published OpenJob dataset snapshot ${snapshot} to R2 bucket ${bucket}`);
} catch (error) {
  console.error(`R2 dataset upload failed: ${error?.name || 'Error'}: ${error?.message || 'Unknown error'}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
