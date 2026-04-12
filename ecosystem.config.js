module.exports = {
  apps: [
    {
      name: "dxg-rfp-tool-backend",
      script: "dist/server.js",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env_production: {
        NODE_ENV: "production",
        PORT: 8000,
      },
    },
  ],
};
