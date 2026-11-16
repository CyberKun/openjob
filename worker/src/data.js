const fields = ['location', 'remote', 'language', 'tag', 'employment_type', 'open_to', 'origin'];

export class InputError extends Error {}

async function asset(env, path) {
  if (!path.startsWith('/data/') || path.includes('..')) throw new InputError('Invalid dataset path');
  const response = await env.ASSETS.fetch(new Request(new URL(path, env.origin || 'https://openjob.softprobe.ai')));
  if (!response.ok) throw new Error('Dataset asset unavailable');
  return response;
}

export async function manifest(env) {
  return (await asset(env, '/data/manifest.json')).json();
}

function dataset(m, kind) {
  if (!['jobs', 'talent'].includes(kind)) throw new InputError('kind must be jobs or talent');
  return m.datasets[kind];
}

export async function getDataset(env, kind) {
  const m = await manifest(env);
  return {schema_version: m.schema_version, snapshot_id: m.snapshot_id, generated: m.generated,
    indexed_notice: m.indexed_notice, owner_license: m.owner_license, kind, ...dataset(m, kind)};
}

async function* records(env, shard) {
  const path = new URL(shard.url).pathname;
  const response = await asset(env, path);
  if (!response.body) throw new Error('Dataset shard is empty');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      pending += value;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line) yield JSON.parse(line);
      }
    }
    if (pending) yield JSON.parse(pending);
  } finally { await reader.cancel(); }
}

function match(record, options) {
  const q = (options.text || '').toLowerCase();
  const haystack = ['title', 'headline', 'org', 'location', 'department', 'tags', 'excerpt']
    .flatMap(key => record[key] || []).join(' ').toLowerCase();
  if (q && !haystack.includes(q)) return false;
  for (const key of fields) {
    const value = options[key];
    if (!value) continue;
    if (key === 'location') { if (!(record.location || '').toLowerCase().includes(value.toLowerCase())) return false; }
    else if (key === 'language') { if (!(record.languages || []).includes(value)) return false; }
    else if (key === 'tag') { if (!(record.tags || []).includes(value)) return false; }
    else if (Array.isArray(record[key])) { if (!record[key].includes(value)) return false; }
    else if ((record[key] || '') !== value) return false;
  }
  return true;
}

function filters(options) {
  return Object.fromEntries(['text', ...fields].filter(k => options[k]).map(k => [k, options[k]]));
}
function encode(value) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function decode(value) {
  try { return JSON.parse(decodeURIComponent(escape(atob(value.replaceAll('-', '+').replaceAll('_', '/'))))); }
  catch { throw new InputError('Invalid cursor; restart the listing'); }
}
export async function list(env, kind, options = {}) {
  const m = await manifest(env), ds = dataset(m, kind);
  const limit = Number(options.limit ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InputError('limit must be between 1 and 100');
  const rules = filters(options);
  let after = '';
  if (options.cursor) {
    const cursor = decode(options.cursor);
    if (cursor.snapshot !== m.snapshot_id) throw new InputError('Snapshot changed; restart listing without a cursor');
    if (cursor.kind !== kind || JSON.stringify(cursor.filters) !== JSON.stringify(rules) || typeof cursor.after !== 'string') throw new InputError('Cursor does not match filters; restart listing');
    after = cursor.after;
  }
  const items = [];
  for (const shard of ds.shards) {
    if (after && shard.last_id <= after) continue;
    for await (const record of records(env, shard)) {
      if (record.path <= after || !match(record, rules)) continue;
      if (items.length === limit) {
        return {snapshot_id: m.snapshot_id, items, next_cursor: encode({snapshot: m.snapshot_id, kind, filters: rules, after: items.at(-1).path})};
      }
      const {body_markdown, ...summary} = record;
      items.push(summary);
    }
  }
  return {snapshot_id: m.snapshot_id, items, next_cursor: null};
}

export async function get(env, kind, id) {
  if (!id || typeof id !== 'string') throw new InputError('id is required');
  if (id.includes('/p/')) id = id.split('/p/')[1].split(/[?#]/)[0].replace(/\/$/, '') + '.md';
  const login = kind === 'talent' && !id.includes('/');
  if (login) id = `talents/${id}.md`;
  const m = await manifest(env), ds = dataset(m, kind);
  const shards = login ? ds.shards : ds.shards.filter(s => s.first_id <= id && s.last_id >= id);
  for (const shard of shards) for await (const record of records(env, shard)) {
    if (login ? record.path.toLowerCase() === id.toLowerCase() : record.path === id) return {snapshot_id: m.snapshot_id, record};
  }
  throw new InputError('Record not found');
}
