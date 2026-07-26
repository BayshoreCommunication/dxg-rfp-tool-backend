module.exports = {
  apps: [
    {
      name: "dxg-rfp-tool",
      script: "dist/server.js",
      cwd: "/var/www/dxg-rfp-tool-backend",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
    // The AI pipeline requires long-lived processes: the durable worker
    // executes queued jobs (scans, parsing, extraction, drafting, vendor
    // analysis) and the dispatcher publishes the transactional outbox to
    // Redis. Neither can run on serverless.
    {
      name: "dxg-rfp-worker",
      script: "npm",
      args: "run worker:source-security",
      cwd: "/var/www/dxg-rfp-tool-backend",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "dxg-rfp-dispatcher",
      script: "npm",
      args: "run worker:dispatcher",
      cwd: "/var/www/dxg-rfp-tool-backend",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
