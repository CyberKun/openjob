# Complete datasets

OpenJob builds complete job and public talent datasets from the same catalog snapshot as its board. The repository is the source of truth: daily employer-feed results are checked into the `index-data` branch, and jobs or talent submitted through pull requests or MCP tools become part of the repository after they are merged. The Pages workflow exports that combined catalog and stores immutable snapshot shards in the `openjob-datasets` Cloudflare R2 bucket. Fetch the current pointer at `https://openjob.softprobe.ai/api/data/manifest.json`. It lists each dataset's schema, count, snapshot, shard URLs, sizes, and SHA-256 checksums. Each shard is available as JSON Lines and gzip. A JSON Lines file has one record per line, ordered by the record's stable `path`.

R2 stores the compressed shard objects. The Worker streams the `.jsonl.gz` download as-is and decompresses the same object when an agent requests the plain `.jsonl` URL. The manifest and checksums describe the bytes returned at each URL.

Snapshots are retained indefinitely. The bucket's only current R2 lifecycle action aborts incomplete multipart uploads after seven days; no object expiration is configured. Old manifests or clients may still reference an earlier immutable snapshot. Add cleanup only when it can reliably preserve every snapshot that remains reachable from a published or cached manifest.

Agents can download every shard and apply their own search and matching code. The dependency-free example prints records as JSON Lines:

```sh
python3 examples/download_dataset.py jobs > jobs.jsonl
python3 examples/download_dataset.py talent > talent.jsonl
```

The example verifies compressed and uncompressed checksums. It does not choose a ranking. Avoid sending an entire resume to the public retrieval endpoint when a few search terms are sufficient.

The index contains employer-linked facts for indexed jobs. Read each promising employer source for its description. The indexed notice in the manifest covers these records; CC BY 4.0 applies to repository posts. `jobs.json` and `talents.json` are capped feeds, not complete datasets. The talent dataset includes both published profiles and references; a reference links to its owner's profile.

The public API catalog is `https://openjob.softprobe.ai/.well-known/api-catalog`; it links to the [OpenAPI 3.1 document](https://openjob.softprobe.ai/api/openapi.json), human and agent documentation, MCP, and health. Public reads are anonymous and require no API key. The remote MCP endpoint is `https://openjob.softprobe.ai/api/mcp`. `get_dataset` returns `complete: true`, freshness, schema, counts, and download information. `list_jobs` and `list_talent` provide literal filters and paginated records ordered by identifier. They do not rank matches. `get_job` and `get_talent` return full available records. The same read operations are available at `/api/v1/datasets`, `/api/v1/jobs`, `/api/v1/talent`, `/api/v1/job`, and `/api/v1/profile`; use `kind` for datasets and `id` for details. List pages default to 25 results, with a maximum of 100. A cursor belongs to its snapshot and filters. Restart when the snapshot changes. Dataset schema and shard URLs in the manifest can be fetched directly under `/api/data/`.

## Connect an agent

Agents that support ordinary web GET requests can discover the API through its catalog, read the OpenAPI description, and call bounded HTTP endpoints without installing anything. MCP clients use the Streamable HTTP URL `https://openjob.softprobe.ai/api/mcp`; a host may still require its own connection approval. The endpoint is available only after the API deployment is activated.

An agent can offer to prepare a public profile after returning useful matches. The person reviews the profile and explicitly approves publication. The existing GitHub profile rules and write tools still apply; the remote endpoint is read-only. Never publish a resume PDF, personal email, or phone number as a profile.

## API deployment

The Pages workflow builds the datasets from the catalog it publishes, uploads all immutable snapshot objects to R2, publishes `manifest.json` last, then deploys the Worker. The Worker reads R2 through a bucket binding; other site paths pass through to the existing site origin. Set repository variable `OPENJOB_API_DEPLOY` to `true`. Store the Worker deploy token in `CLOUDFLARE_API_TOKEN`; store the bucket-scoped R2 write token in `CLOUDFLARE_R2_API_TOKEN`. The Softprobe account ID is configured once in `worker/cloudflare.config.ts`. The Worker handles `/api/*` and the exact `/.well-known/api-catalog` path. When the zone uses Flexible SSL, add a hostname-scoped Configuration Rule for `openjob.softprobe.ai` with SSL set to Full (strict), so the site continues to receive HTTPS without changing SSL settings for other hostnames. If Browser Integrity Check is enabled, disable it only for `/api/*` and `/.well-known/api-catalog` so non-browser agent clients can access the public endpoints. The Worker uses `cloudflare.config.ts`, pinned npm dependencies, and Node 26.12.0. To build locally, first generate datasets with `python -m validator build-index --root . --out /tmp/openjob-index.json --datasets-out build/datasets`, then run `npm ci` and `npx cf build` in `worker/`. To publish a snapshot, run `bash scripts/upload-datasets-to-r2.sh build/datasets` from the repository root with Cloudflare credentials set.
