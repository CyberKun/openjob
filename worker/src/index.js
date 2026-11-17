import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { getHealth, openApiDocument, operations, parseInput, resources } from './contracts.js';
import { ConflictError, InputError, RateLimitError, purgeExpiredTalent, serveDataAsset, serveManifest, serveProfilePage } from './data.js';

const defaultAnnotations = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};

/** @param {unknown} result @returns {import('@modelcontextprotocol/server').CallToolResult} */
const respond = result => ({structuredContent: result, content: [{type: 'text', text: JSON.stringify(result)}]});

/** @type {(fn: (args: any) => Promise<unknown>) => (args: any) => Promise<import('@modelcontextprotocol/server').CallToolResult>} */
const safe = fn => async args => {
  try { return respond(await fn(args)); }
  catch (error) {
    const message = error instanceof InputError || error instanceof RateLimitError || error instanceof ConflictError
      ? error.message
      : 'Dataset unavailable; try again later';
    return {isError: true, content: [{type: 'text', text: message}]};
  }
};

/** Build the remote MCP server from the same operation registry as HTTP and OpenAPI. */
export function createMcpServer(env) {
  const server = new McpServer({name: 'openjob', version: '1.0.0'});
  for (const operation of operations) {
    server.registerTool(operation.name, {
      description: operation.description,
      inputSchema: operation.input,
      outputSchema: operation.output,
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
  return error instanceof InputError || error instanceof RateLimitError || error instanceof ConflictError
    ? error.message
    : 'Dataset unavailable; try again later';
}

function errorStatus(error) {
  if (error instanceof InputError) return 400;
  if (error instanceof RateLimitError) return 429;
  if (error instanceof ConflictError) return 409;
  return 503;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return {error: new InputError('Content-Type must be application/json'), status: 415};
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 16 * 1024) return {error: new InputError('Request body must be 16 KB or smaller'), status: 413};
  if (!request.body) return {error: new InputError('A JSON request body is required'), status: 400};
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        return {error: new InputError('Request body must be 16 KB or smaller'), status: 413};
      }
      chunks.push(value);
    }
  } catch {
    return {error: new InputError('Could not read JSON request body'), status: 400};
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return {value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))};
  } catch {
    return {error: new InputError('Request body must contain valid UTF-8 JSON'), status: 400};
  }
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
  async scheduled(controller, env) {
    await purgeExpiredTalent({DATASETS: env.DATASETS});
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dataEnv = {
      DATASETS: env.DATASETS,
      PROFILE_WRITE_LIMITER: env.PROFILE_WRITE_LIMITER,
      CLIENT_IP: request.headers.get('cf-connecting-ip') || 'unknown',
    };

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
    if (url.pathname.startsWith('/p/api-talent/')) return serveProfilePage(request, dataEnv);
    if (url.pathname === '/api/data/manifest.json') return serveManifest(request, dataEnv);
    if (url.pathname.startsWith('/api/data/')) return serveDataAsset(request, dataEnv);

    if (url.pathname === resources.health.path) {
      try { return Response.json(await getHealth(dataEnv)); }
      catch { return Response.json({error: 'Dataset unavailable; try again later'}, {status: 503}); }
    }

    const matchingPath = operations.filter(candidate => candidate.path === url.pathname);
    if (!matchingPath.length) return new Response('Not found', {status: 404});
    const operation = matchingPath.find(candidate => candidate.method === request.method.toLowerCase());
    if (!operation) return new Response('Method not allowed', {status: 405, headers: {allow: [...new Set(matchingPath.map(item => item.method.toUpperCase()))].join(', ')}});
    try {
      let raw;
      if (operation.method === 'get') raw = Object.fromEntries(url.searchParams);
      else {
        const result = await readJson(request);
        if (result.error) return Response.json({error: result.error.message}, {status: result.status});
        raw = result.value;
      }
      const args = parseInput(operation, raw);
      const response = Response.json(await operation.run(dataEnv, args), {status: operation.successStatus || 200});
      if (operation.method === 'post') response.headers.set('cache-control', 'no-store');
      return response;
    } catch (error) {
      const status = errorStatus(error);
      const headers = status === 429 ? {'retry-after': '60'} : undefined;
      return Response.json({error: errorMessage(error)}, {status, headers});
    }
  },
};
