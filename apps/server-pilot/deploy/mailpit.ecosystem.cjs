/** Mailpit sidecar — localhost only, for wire-gate pre-IT runs. */
module.exports = {
  apps: [
    {
      name: 'mailpit',
      script: '/usr/local/bin/mailpit',
      args: [
        '--smtp=127.0.0.1:11025',
        '--pop3=127.0.0.1:11110',
        '--listen=127.0.0.1:18025',
      ],
      env: {
        MP_POP3_AUTH: 'ingest@wire.test:wire-test-pass',
      },
      autorestart: true,
      max_restarts: 5,
    },
  ],
};
