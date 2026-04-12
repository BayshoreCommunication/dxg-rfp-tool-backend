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
  ],
};
