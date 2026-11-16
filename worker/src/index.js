import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { getDataset, list, get, manifest, InputError } from './data.js';

const filterSchema = {
  text: z.string().optional().describe('Literal case-insensitive substring, not a relevance query.'),
  location: z.string().optional(), remote: z.string().optional(), language: z.string().optional(),
  tag: z.string().optional(), employment_type: z.string().optional(), open_to: z.string().optional(),
  origin: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
};
const record = z.record(z.string(), z.unknown());
const listOutput = {snapshot_id: z.string(), items: z.array(record), next_cursor: z.string().nullable()};
const detailOutput = {snapshot_id: z.string(), record};
const datasetOutput = {schema_version: z.string(), snapshot_id: z.string(), generated: z.string(), indexed_notice: z.string(), owner_license: z.string(), kind: z.string(), count: z.number(), schema_url: z.string(), shards: z.array(record)};
const annotations = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
/** @returns {import('@modelcontextprotocol/server').CallToolResult} */
const respond = result => ({structuredContent: result, content: [{type: 'text', text: JSON.stringify(result)}]});
/** @type {(fn: Function) => (args: any) => Promise<import('@modelcontextprotocol/server').CallToolResult>} */
const safe = fn => async args => {
  try { return respond(await fn(args)); }
  catch (error) { return {isError: true, content: [{type: 'text', text: error instanceof InputError ? error.message : 'Dataset unavailable; try again later'}]}; }
};
function serverFor(env) {
  const server = new McpServer({name: 'openjob', version: '1.0.0'});
  server.registerTool('get_dataset', {description: 'Get complete public dataset download URLs, schema, checksums, and freshness. Agents can use their own matching code.', inputSchema: {kind: z.enum(['jobs', 'talent'])}, outputSchema: datasetOutput, annotations}, safe(({kind}) => getDataset(env, kind)));
  server.registerTool('list_jobs', {description: 'List public job facts in identifier order with optional literal filters. No personalized ranking.', inputSchema: filterSchema, outputSchema: listOutput, annotations}, safe(args => list(env, 'jobs', args)));
  server.registerTool('get_job', {description: 'Get a job by path or permalink, including the employer source and apply method.', inputSchema: {id: z.string()}, outputSchema: detailOutput, annotations}, safe(({id}) => get(env, 'jobs', id)));
  server.registerTool('list_talent', {description: 'List public talent profiles in identifier order with optional literal filters. No personalized ranking.', inputSchema: filterSchema, outputSchema: listOutput, annotations}, safe(args => list(env, 'talent', args)));
  server.registerTool('get_talent', {description: 'Get a public talent profile by path, permalink, or GitHub login.', inputSchema: {id: z.string()}, outputSchema: detailOutput, annotations}, safe(({id}) => get(env, 'talent', id)));
  return server;
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dataEnv = { ASSETS: env.ASSETS, origin: url.origin };
    if (url.pathname === '/mcp') return createMcpHandler(() => serverFor(dataEnv))(request, env, ctx);
    if (url.pathname.startsWith('/data/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return new Response('Method not allowed', {status: 405});
    const options = Object.fromEntries(url.searchParams);
    try {
      let result;
      switch (url.pathname) {
        case '/health': { const m = await manifest(dataEnv); result = {snapshot_id: m.snapshot_id, generated: m.generated}; break; }
        case '/v1/datasets': result = await getDataset(dataEnv, options.kind); break;
        case '/v1/jobs': result = await list(dataEnv, 'jobs', options); break;
        case '/v1/talent': result = await list(dataEnv, 'talent', options); break;
        case '/v1/job': result = await get(dataEnv, 'jobs', options.id); break;
        case '/v1/profile': result = await get(dataEnv, 'talent', options.id); break;
        default: return new Response('Not found', {status: 404});
      }
      return Response.json(result);
    } catch (error) {
      return Response.json({error: error instanceof InputError ? error.message : 'Dataset unavailable; try again later'}, {status: error instanceof InputError ? 400 : 503});
    }
  }
};
