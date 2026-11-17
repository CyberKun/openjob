import { bindings, defineConfig, triggers } from 'cf/config';

export default defineConfig({
  accountId: 'fb4b299688885a31058d94ee11ee1129',
  worker: {
    name: 'openjob-api',
    entrypoint: './src/index.js',
    compatibilityDate: '2026-11-15',
    compatibilityFlags: ['nodejs_compat'],
    env: {
      DATASETS: bindings.r2({ name: 'openjob-datasets' }),
      PROFILE_WRITE_LIMITER: bindings.rateLimit({namespace: '2026111601', simple: {limit: 5, period: 60}}),
    },
    triggers: [
      triggers.fetch({ pattern: 'openjob.softprobe.ai/api/*', zone: 'softprobe.ai' }),
      triggers.fetch({ pattern: 'openjob.softprobe.ai/p/api-talent/*', zone: 'softprobe.ai' }),
      triggers.fetch({ pattern: 'openjob.softprobe.ai/.well-known/api-catalog', zone: 'softprobe.ai' }),
      triggers.scheduled({schedule: '17 3 * * *'}),
    ],
    observability: { enabled: true, redactQueryString: true, traces: { enabled: true } },
  },
});
