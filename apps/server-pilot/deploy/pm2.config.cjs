const path = require('node:path');

/**
 * Luna analyse cache shared by http (pane read) and ai-worker (warmer write).
 * Resolves to the same apps/server-pilot/.private/luna-analyse-cache the route
 * computes from its own module URL, so warmed files are hits for the pane.
 */
const LUNA_ANALYSE_CACHE_DIR = path.resolve(__dirname, '..', '.private', 'luna-analyse-cache');

/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name: 'http',
      script: 'dist/main.js',
      cwd: '/home/ubuntu/repos/zero/apps/server-pilot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: 10_000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: '8788',
        NAVA_AUTH_SESSION_PROFILE: 'legacy',
        NAVA_BUILD_COMMIT: process.env.NAVA_BUILD_COMMIT ?? '',
        LUNA_ANALYSE_CACHE_DIR,
        LUNA_ANALYSE_WARMER: 'on',
      },
    },
    {
      // Started only by isolated remote env shells in deploy/restart/boot.
      name: 'remote-http',
      script: 'dist/main.js',
      cwd: '/home/ubuntu/repos/zero/apps/server-pilot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: 10_000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: '8789',
        NAVA_AUTH_SESSION_PROFILE: 'remote',
        NAVA_BUILD_COMMIT: process.env.NAVA_BUILD_COMMIT ?? '',
      },
    },
    {
      name: 'worker',
      script: 'dist/mail/ingest/worker.js',
      cwd: '/home/ubuntu/repos/zero/apps/server-pilot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: 10_000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        NAVA_BUILD_COMMIT: process.env.NAVA_BUILD_COMMIT ?? '',
      },
    },
    {
      name: 'ai-worker',
      script: 'dist/ai/worker.js',
      cwd: '/home/ubuntu/repos/zero/apps/server-pilot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: 10_000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        AI_WORKER_LANE: 'default',
        AI_ENABLED: process.env.AI_ENABLED ?? 'true',
        AI_WRITE_GATE_ENABLED: process.env.AI_WRITE_GATE_ENABLED ?? 'false',
        AI_DRAFTS_ENABLED: process.env.AI_DRAFTS_ENABLED ?? 'false',
        AI_MODEL_ID: process.env.AI_MODEL_ID ?? 'amazon.nova-lite-v1:0',
        BEDROCK_REGION: process.env.BEDROCK_REGION ?? 'us-east-1',
        NAVA_BUILD_COMMIT: process.env.NAVA_BUILD_COMMIT ?? '',
        LUNA_ANALYSE_CACHE_DIR,
        LUNA_ANALYSE_WARMER: 'on',
      },
    },
    {
      // Started ONLY by ops-hms-shadow.sh start — never by deploy/restart/boot.
      // Permanent failure must not loop: autorestart false.
      // Child-only HMS_EVIDENCE_HMAC_KEY via asm-exec resolve arg (never in env/config).
      name: 'hms-ai-worker',
      script: '/usr/local/bin/asm-exec',
      args: '-- /usr/bin/env HMS_EVIDENCE_HMAC_KEY={{resolve:secretsmanager:nava-zero/server-pilot/hms-evidence-hmac}} /usr/bin/node dist/ai/worker.js',
      interpreter: 'none',
      cwd: '/home/ubuntu/repos/zero/apps/server-pilot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      min_uptime: 10_000,
      max_restarts: 0,
      env: {
        NODE_ENV: 'production',
        AI_WORKER_LANE: 'hms',
        HMS_DRAFT_ENRICHMENT_MODE: process.env.HMS_DRAFT_ENRICHMENT_MODE ?? 'off',
        HMS_READ_SECRET_ARN: process.env.HMS_READ_SECRET_ARN ?? '',
        HMS_EVIDENCE_HMAC_SECRET_ARN:
          process.env.HMS_EVIDENCE_HMAC_SECRET_ARN ?? '',
        HMS_EVIDENCE_HMAC_KEY_VERSION:
          process.env.HMS_EVIDENCE_HMAC_KEY_VERSION ?? '',
        HMS_CHROMIUM_EXECUTABLE_PATH:
          process.env.HMS_CHROMIUM_EXECUTABLE_PATH ?? '/opt/nava/chromium/chrome',
        PLAYWRIGHT_BROWSERS_PATH:
          process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/nava/ms-playwright',
        HMS_READ_ROLE_PROOF_PATH:
          process.env.HMS_READ_ROLE_PROOF_PATH ??
          '/etc/nava/hms-read-role-proof.v1.json',
        HMS_ACTIVE_REGISTRY_PATH:
          process.env.HMS_ACTIVE_REGISTRY_PATH ??
          '/opt/nava/shared/hms-active-registry/active.json',
        HMS_RELEASE_ROOT:
          process.env.HMS_RELEASE_ROOT ?? '/opt/nava/shared/hms-releases',
        HMS_HEALTH_STATUS_PATH:
          process.env.HMS_HEALTH_STATUS_PATH ?? '/tmp/nava-zero-hms-health.json',
        HMS_EXPECTED_TENANT: process.env.HMS_EXPECTED_TENANT ?? 'THECENTURION_PRD',
        HMS_EXPECTED_PROPERTY_CODE:
          process.env.HMS_EXPECTED_PROPERTY_CODE ?? 'HRCEN',
        HMS_EXPECTED_TRANSPORT_ID:
          process.env.HMS_EXPECTED_TRANSPORT_ID ?? 'transport-centurion',
        HMS_RUN_DEADLINE_MS: process.env.HMS_RUN_DEADLINE_MS ?? '',
        HMS_CIRCUIT_COOLDOWN_MS: process.env.HMS_CIRCUIT_COOLDOWN_MS ?? '',
        AI_WORKER_IDEMPOTENCY_PREFIX:
          process.env.AI_WORKER_IDEMPOTENCY_PREFIX ?? '',
        AI_ENABLED: process.env.AI_ENABLED ?? 'true',
        AI_WRITE_GATE_ENABLED: process.env.AI_WRITE_GATE_ENABLED ?? 'false',
        AI_DRAFTS_ENABLED: process.env.AI_DRAFTS_ENABLED ?? 'false',
        AI_MODEL_ID: process.env.AI_MODEL_ID ?? 'amazon.nova-lite-v1:0',
        BEDROCK_REGION: process.env.BEDROCK_REGION ?? 'us-east-1',
        NAVA_BUILD_COMMIT: process.env.NAVA_BUILD_COMMIT ?? '',
      },
    },
  ],
};
