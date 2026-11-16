import test from 'node:test';
import assert from 'node:assert/strict';
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
  const assets = {'/data/jobs.jsonl': rows.map(r=>JSON.stringify(r)).join('\n')+'\n', '/data/talent.jsonl': JSON.stringify(profile)+'\n'};
  return {m, env:{ASSETS:{fetch: async req => {const path = new URL(req.url).pathname; return new Response(path === '/data/manifest.json' ? JSON.stringify(m) : assets[path], {status:path === '/data/manifest.json' || path in assets ? 200 : 404});}}}};
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
