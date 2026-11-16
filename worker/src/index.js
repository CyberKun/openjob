import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { getHealth, openApiDocument, operations, parseInput, resources } from './contracts.js';
import { InputError, manifest, serveDataAsset } from './data.js';

const defaultAnnotations = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};

/** @param {unknown} result @returns {import('@modelcontextprotocol/server').CallToolResult} */
const respond = result => ({structuredContent: result, content: [{type: 'text', text: JSON.stringify(result)}]});

/** @type {(fn: (args: any) => Promise<unknown>) => (args: any) => Promise<import('@modelcontextprotocol/server').CallToolResult>} */
const safe = fn => async args => {
  try { return respond(await fn(args)); }
  catch (error) {
    const message = error instanceof InputError ? error.message : 'Dataset unavailable; try again later';
    return {isError: true, content: [{type: 'text', text: message}]};
  }
};

/** Build the remote MCP server from the same operation registry as HTTP and OpenAPI. */
export function createMcpServer(env) {
  const server = new McpServer({name: 'openjob', version: '1.0.0'});
  for (const operation of operations) {
    server.registerTool(operation.name, {
      description: operation.description,
      inputSchema: operation.input.shape,
      outputSchema: operation.output.shape,
      annotations: operation.annotations || defaultAnnotations,
    }, safe(args => operation.run(env, parseInput(operation, args))));
  }
  return server;
}

const catalogUrl = 'https://openjob.softprobe.ai/.well-known/api-catalog';
const catalogContentType = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
const catalog = {
  linkset: [{
    anchor: 'https://openjob.softprobe.ai/',
    item: [
      {href: 'https://openjob.softprobe.ai/api/v1/datasets', title: 'OpenJob public read API'},
      {href: 'https://openjob.softprobe.ai/api/data/manifest.json', title: 'Complete dataset manifest'},
      {href: 'https://openjob.softprobe.ai/api/mcp', title: 'OpenJob remote MCP server'},
    ],
    'service-desc': [{href: 'https://openjob.softprobe.ai/api/openapi.json', type: 'application/vnd.oai.openapi+json;version=3.1.0'}],
    'service-doc': [{href: 'https://openjob.softprobe.ai/llms.txt', type: 'text/plain'}],
    status: [{href: 'https://openjob.softprobe.ai/api/health', type: 'application/json'}],
  }],
};

function errorMessage(error) {
  return error instanceof InputError ? error.message : 'Dataset unavailable; try again later';
}

async function serveCatalog(request) {
  const headers = {
    'content-type': catalogContentType,
    link: `<${catalogUrl}>; rel="api-catalog"`,
  };
  if (request.method === 'HEAD') return new Response(null, {headers});
  return Response.json(catalog, {headers});
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dataEnv = {DATASETS: env.DATASETS};

    if (url.pathname === '/.well-known/api-catalog') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status: 405});
      return serveCatalog(request);
    }
    if (url.pathname === '/api/mcp') {
      return createMcpHandler(() => createMcpServer(dataEnv), {route: '/api/mcp'})(request, env, ctx);
    }
    if (url.pathname === '/api/openapi.json') {
      if (request.method !== 'GET') return new Response('Method not allowed', {status: 405});
      return Response.json(openApiDocument, {headers: {'content-type': 'application/vnd.oai.openapi+json;version=3.1.0'}});
    }
    if (url.pathname.startsWith('/api/data/')) return serveDataAsset(request, dataEnv);
    if (request.method !== 'GET') return new Response('Method not allowed', {status: 405});

    if (url.pathname === resources.health.path) {
      try { return Response.json(await getHealth(dataEnv)); }
      catch { return Response.json({error: 'Dataset unavailable; try again later'}, {status: 503}); }
    }

    const operation = operations.find(candidate => candidate.path === url.pathname && candidate.method === 'get');
    if (!operation) return new Response('Not found', {status: 404});
    try {
      const args = parseInput(operation, Object.fromEntries(url.searchParams));
      return Response.json(await operation.run(dataEnv, args));
    } catch (error) {
      return Response.json({error: errorMessage(error)}, {status: error instanceof InputError ? 400 : 503});
    }
  },
};
