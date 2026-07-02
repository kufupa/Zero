/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name: 'http',
      script: 'dist/main.js',
      cwd: '/home/ubuntu/repos/zero/apps/server-pilot',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'worker',
      script: 'dist/mail/ingest/worker.js',
      cwd: '/home/ubuntu/repos/zero/apps/server-pilot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
