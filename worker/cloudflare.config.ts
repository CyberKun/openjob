import { bindings, defineConfig, triggers } from 'cf/config';

export default defineConfig({
  accountId: 'fb4b299688885a31058d94ee11ee1129',
  worker: {
    name: 'openjob-api',
    entrypoint: './src/index.js',
    compatibilityDate: '2026-11-15',
    compatibilityFlags: ['nodejs_compat'],
    env: { DATASETS: bindings.r2({ name: 'openjob-datasets' }) },
    triggers: [
      triggers.fetch({ pattern: 'openjob.softprobe.ai/mcp*', zone: 'softprobe.ai' }),
      triggers.fetch({ pattern: 'openjob.softprobe.ai/v1/*', zone: 'softprobe.ai' }),
      triggers.fetch({ pattern: 'openjob.softprobe.ai/health', zone: 'softprobe.ai' }),
      triggers.fetch({ pattern: 'openjob.softprobe.ai/data/*', zone: 'softprobe.ai' }),
    ],
    observability: { enabled: true, redactQueryString: true, traces: { enabled: true } },
  },
});
