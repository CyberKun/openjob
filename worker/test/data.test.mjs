import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {list, get, getDataset} from '../src/data.js';

function setup() {
  const rows = [
    {path:'indexed/a',kind:'job',title:'Backend engineer',org:'A',location:'Remote',remote:'remote',origin:'indexed'},
    {path:'indexed/b',kind:'job',title:'Marketing lead',org:'B',location:'Berlin',remote:'onsite',origin:'indexed'},
    {path:'indexed/c',kind:'job',title:'Backend developer',org:'C',location:'Remote',remote:'remote',origin:'indexed'},
  ];
  const profile = {path:'talents/ada.md',kind:'talent',title:'Ada',body_markdown:'Skills'};
  const m = {schema_version:'1',snapshot_id:'snapshot',generated:'today',indexed_notice:'notice',owner_license:'CC BY 4.0', datasets: {
    jobs:{count:3,schema_url:'schema',shards:[{first_id:'indexed/a',last_id:'indexed/c',url:'https://openjob.softprobe.ai/data/jobs.jsonl'}]},
    talent:{count:1,schema_url:'schema',shards:[{first_id:'talents/ada.md',last_id:'talents/ada.md',url:'https://openjob.softprobe.ai/data/talent.jsonl'}]},
  }};
  const assets = {'jobs.jsonl.gz': gzipSync(rows.map(r=>JSON.stringify(r)).join('\n')+'\n'), 'talent.jsonl.gz': gzipSync(JSON.stringify(profile)+'\n')};
  return {m, env:{DATASETS:{get: async key => {
    const value = key === 'manifest.json' ? JSON.stringify(m) : assets[key.split('/').at(-1)];
    if (value === undefined) return null;
    const body = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return {body:new ReadableStream({start(controller){controller.enqueue(body);controller.close();}}),httpEtag:'etag',writeHttpMetadata(headers){headers.set('content-length',String(body.length));}};
  }}}};
}

test('dataset, filtering, pagination, details and stale cursors', async () => {
  const {env,m} = setup();
  assert.equal((await getDataset(env,'jobs')).count,3);
  const first = await list(env,'jobs',{text:'BACKEND',limit:1});
  assert.equal(first.items[0].path,'indexed/a');
  const second = await list(env,'jobs',{text:'BACKEND',limit:1,cursor:first.next_cursor});
  assert.equal(second.items[0].path,'indexed/c');
  assert.equal(second.next_cursor,null);
  assert.equal((await get(env,'talent','ada')).record.body_markdown,'Skills');
  await assert.rejects(list(env,'jobs',{text:'marketing',cursor:first.next_cursor}),/filters/);
  m.snapshot_id='new';
  await assert.rejects(list(env,'jobs',{text:'BACKEND',cursor:first.next_cursor}),/Snapshot changed/);
});
