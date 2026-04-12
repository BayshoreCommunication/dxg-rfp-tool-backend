module.exports = {
  apps: [
    {
      name: "dxg-rfp-tool",
      script: "dist/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      // Load all env vars from .env file
      env_file: ".env",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
