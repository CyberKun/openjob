import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'openjob-api',
    entrypoint: './src/index.js',
    compatibilityDate: '2026-11-15',
    compatibilityFlags: ['nodejs_compat'],
    env: { ASSETS: bindings.assets() },
    assets: { runWorkerFirst: ['/mcp', '/v1/*', '/health'] },
    domains: ['api.openjob.softprobe.ai'],
    observability: { enabled: true, redactQueryString: true, traces: { enabled: true } },
  },
});
