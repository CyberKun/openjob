import assert from 'node:assert/strict';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const origin = process.env.OPENJOB_API_ORIGIN || 'http://localhost:5173';
const client = new Client({name:'openjob-smoke', version:'1.0.0'});
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin)));
try {
  const tools = await client.listTools();
  assert.deepEqual(new Set(tools.tools.map(tool => tool.name)), new Set(['get_dataset','list_jobs','get_job','list_talent','get_talent']));
  const result = await client.callTool({name:'list_jobs',arguments:{limit:1}});
  assert.ok(!result.isError, JSON.stringify(result));
  const http = await fetch(new URL('/v1/jobs?limit=1', origin)).then(response => response.json());
  assert.deepEqual(result.structuredContent, http);
  const manifest = await client.callTool({name:'get_dataset',arguments:{kind:'jobs'}});
  assert.equal(manifest.structuredContent.snapshot_id, http.snapshot_id);
  console.log('MCP and HTTP return the same snapshot and records');
} finally { await client.close(); }
