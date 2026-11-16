import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { getDataset, get, InputError, list, manifest } from './data.js';

const recordSchema = z.record(z.string(), z.unknown()).meta({
  id: 'DatasetRecord',
  description: 'A complete OpenJob dataset record. See the record schema URL returned by get_dataset for the current field contract.',
  externalDocs: {url: 'https://openjob.softprobe.ai/api/data/manifest.json'},
});

const shardSchema = z.object({
  first_id: z.string(),
  last_id: z.string(),
  count: z.number().int().nonnegative(),
  url: z.string().url(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  gzip: z.object({url: z.string().url(), bytes: z.number().int().nonnegative(), sha256: z.string()}),
});

const datasetOutput = z.object({
  schema_version: z.string(),
  snapshot_id: z.string(),
  generated: z.string(),
  indexed_notice: z.string(),
  owner_license: z.string(),
  kind: z.enum(['jobs', 'talent']),
  complete: z.boolean().describe('True when this describes every available record in the snapshot.'),
  count: z.number().int().nonnegative(),
  schema_url: z.string().url().describe('JSON Schema for exported records.'),
  shards: z.array(shardSchema),
});

const listOutput = z.object({
  snapshot_id: z.string(),
  items: z.array(recordSchema),
  next_cursor: z.string().nullable(),
});

const detailOutput = z.object({snapshot_id: z.string(), record: recordSchema});
const errorOutput = z.object({error: z.string()});
const textErrorOutput = z.string().describe('Human-readable request error.');

const filterSchema = z.object({
  text: z.string().optional().describe('Literal case-insensitive substring filter; this is not relevance search or ranking.'),
  location: z.string().optional(),
  remote: z.string().optional(),
  language: z.string().optional(),
  tag: z.string().optional(),
  employment_type: z.string().optional(),
  open_to: z.string().optional(),
  origin: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().describe('Results per page. Defaults to 25; maximum 100.'),
  cursor: z.string().optional().describe('Continue a listing for the same snapshot and filters.'),
});

const jobIdInput = z.object({id: z.string().min(1).describe('Job repository path or permalink.')});
const talentIdInput = z.object({id: z.string().min(1).describe('Talent repository path, permalink, or GitHub login.')});
const datasetInput = z.object({kind: z.enum(['jobs', 'talent'])});
const annotations = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};

/**
 * The shared read contract for the public HTTP API and remote MCP server.
 * Keep each tool's schema, description, HTTP route, and data handler together.
 */
export const operations = [
  {
    name: 'get_dataset', operationId: 'get_dataset', method: 'get', path: '/api/v1/datasets', tags: ['Datasets'],
    summary: 'Get dataset download information',
    description: 'Get complete public dataset download URLs, record schema, checksums, and freshness. Use your own matching code; OpenJob does not rank records.',
    input: datasetInput, output: datasetOutput, annotations,
    run: (env, {kind}) => getDataset(env, kind),
  },
  {
    name: 'list_jobs', operationId: 'list_jobs', method: 'get', path: '/api/v1/jobs', tags: ['Jobs'],
    summary: 'List public jobs',
    description: 'List public job facts in identifier order with optional literal filters. No personalized ranking.',
    input: filterSchema, output: listOutput, annotations,
    run: (env, args) => list(env, 'jobs', args),
  },
  {
    name: 'get_job', operationId: 'get_job', method: 'get', path: '/api/v1/job', tags: ['Jobs'],
    summary: 'Get one job',
    description: 'Get a job by repository path or permalink, including the employer source and stored application method.',
    input: jobIdInput, output: detailOutput, annotations,
    run: (env, {id}) => get(env, 'jobs', id),
  },
  {
    name: 'list_talent', operationId: 'list_talent', method: 'get', path: '/api/v1/talent', tags: ['Talent'],
    summary: 'List published talent profiles',
    description: 'List public talent profiles in identifier order with optional literal filters. No personalized ranking.',
    input: filterSchema, output: listOutput, annotations,
    run: (env, args) => list(env, 'talent', args),
  },
  {
    name: 'get_talent', operationId: 'get_talent', method: 'get', path: '/api/v1/profile', tags: ['Talent'],
    summary: 'Get one talent profile',
    description: 'Get a public talent profile by repository path, permalink, or GitHub login.',
    input: talentIdInput, output: detailOutput, annotations,
    run: (env, {id}) => get(env, 'talent', id),
  },
];

const datasetEntrySchema = z.object({complete: z.boolean(), count: z.number().int().nonnegative(), schema_url: z.string().url(), shards: z.array(shardSchema)});
const manifestSchema = z.object({
  schema_version: z.string(), snapshot_id: z.string(), generated: z.string(), source: z.string().url(),
  indexed_notice: z.string(), owner_license: z.string(),
  datasets: z.object({jobs: datasetEntrySchema, talent: datasetEntrySchema}),
});
const healthSchema = z.object({snapshot_id: z.string(), generated: z.string()});

export const resources = {
  health: {path: '/api/health', operationId: 'get_health', output: healthSchema},
  manifest: {path: '/api/data/manifest.json', operationId: 'get_manifest', output: manifestSchema},
  shards: {path: '/api/data/snapshots/{snapshot}/{filename}', operationId: 'get_dataset_shard'},
};

export function parseInput(operation, value) {
  const parsed = operation.input.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => {
      const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
      return `${field}${issue.message}`;
    }).join('; ');
    throw new InputError(detail);
  }
  return parsed.data;
}

const registry = new OpenAPIRegistry();
for (const operation of operations) {
  registry.registerPath({
    method: /** @type {'get'} */ (operation.method),
    path: operation.path,
    operationId: operation.operationId,
    tags: operation.tags,
    summary: operation.summary,
    description: operation.description,
    request: {query: operation.input},
    responses: {
      200: {description: operation.summary, content: {'application/json': {schema: operation.output}}},
      400: {description: 'The request is invalid, the cursor is stale, or the requested record was not found.', content: {'application/json': {schema: errorOutput}}},
      405: {description: 'Only GET is supported for this operation.', content: {'text/plain': {schema: textErrorOutput}}},
      503: {description: 'The public dataset is temporarily unavailable.', content: {'application/json': {schema: errorOutput}}},
    },
  });
}

registry.registerPath({
  method: 'get', path: resources.health.path, operationId: resources.health.operationId,
  tags: ['Service status'], summary: 'Get dataset health and snapshot',
  responses: {
    200: {description: 'Current dataset snapshot.', content: {'application/json': {schema: resources.health.output}}},
    405: {description: 'Only GET is supported.', content: {'text/plain': {schema: textErrorOutput}}},
    503: {description: 'The public dataset is temporarily unavailable.', content: {'application/json': {schema: errorOutput}}},
  },
});
registry.registerPath({
  method: 'get', path: resources.manifest.path, operationId: resources.manifest.operationId,
  tags: ['Datasets'], summary: 'Download the complete dataset manifest',
  description: 'The manifest lists complete job and talent datasets, schema URLs, shard URLs, byte sizes, and checksums.',
  responses: {
    200: {description: 'Complete dataset manifest.', content: {'application/json': {schema: resources.manifest.output}}},
    404: {description: 'The dataset manifest was not found.', content: {'text/plain': {schema: textErrorOutput}}},
    405: {description: 'Only GET and HEAD are supported.', content: {'text/plain': {schema: textErrorOutput}}},
    503: {description: 'The public dataset is temporarily unavailable.', content: {'text/plain': {schema: textErrorOutput}}},
  },
});
registry.registerPath({
  method: 'get', path: resources.shards.path, operationId: resources.shards.operationId,
  tags: ['Datasets'], summary: 'Download a dataset shard',
  description: 'Use shard URLs from the manifest. JSON Lines shards are UTF-8; gzip variants are available at the advertised .gz URL.',
  request: {params: z.object({snapshot: z.string().regex(/^[0-9a-f]{64}$/), filename: z.string().min(1)})},
  responses: {
    200: {description: 'A UTF-8 JSON Lines shard or its gzip-compressed form.', content: {
      'application/x-ndjson': {schema: z.string()},
      'application/gzip': {schema: {type: 'string', format: 'binary'}},
    }},
    400: {description: 'The dataset path is invalid.', content: {'text/plain': {schema: textErrorOutput}}},
    404: {description: 'The advertised shard was not found.', content: {'text/plain': {schema: textErrorOutput}}},
    405: {description: 'Only GET and HEAD are supported.', content: {'text/plain': {schema: textErrorOutput}}},
    503: {description: 'The public dataset is temporarily unavailable.', content: {'text/plain': {schema: textErrorOutput}}},
  },
});

export const openApiDocument = new OpenApiGeneratorV31(registry.definitions).generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'OpenJob public data API',
    version: '1.0.0',
    description: 'Read-only public job and talent data. OpenJob returns facts and source links; clients choose their own matching method.',
  },
  servers: [{url: 'https://openjob.softprobe.ai'}],
  externalDocs: {description: 'OpenJob agent guide and API discovery', url: 'https://openjob.softprobe.ai/llms.txt'},
});

export async function getHealth(env) {
  const current = await manifest(env);
  return {snapshot_id: current.snapshot_id, generated: current.generated};
}
