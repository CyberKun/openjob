import { bindings, defineConfig, triggers } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'openjob-api',
    entrypoint: './src/index.js',
    compatibilityDate: '2026-11-15',
    compatibilityFlags: ['nodejs_compat'],
    env: { ASSETS: bindings.assets() },
    assets: { runWorkerFirst: ['/mcp', '/v1/*', '/health', '/data/*'] },
    triggers: [triggers.fetch({ pattern: 'openjob.softprobe.ai/*', zone: 'softprobe.ai' })],
    observability: { enabled: true, redactQueryString: true, traces: { enabled: true } },
  },
});
