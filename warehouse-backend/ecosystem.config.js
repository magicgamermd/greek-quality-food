// PM2 ecosystem file — used when warehouse-backend runs on a Railway worker / VPS
// without Docker. Enables cluster mode for better throughput, automatic restart
// on crashes, and daily log rotation.
//
// Usage:
//   pm2 start ecosystem.config.js --env production
//   pm2 save
//   pm2 startup   # to auto-start on boot

module.exports = {
  apps: [
    {
      name: "greekquality-backend",
      script: "./dist/index.js",
      // Cluster mode: one instance per CPU core
      instances: "max",
      exec_mode: "cluster",

      // Auto-restart on crash, but not more than 10 times in 60s
      autorestart: true,
      max_restarts: 10,
      min_uptime: "60s",

      // Memory guard — restart if process exceeds 1GB
      max_memory_restart: "1G",

      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 10000,
      wait_ready: false,

      // Env (runtime values should come from Railway / systemd env, not here)
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
        HOST: "0.0.0.0",
      },

      // Logging — rotated daily via pm2-logrotate module
      // Install once: pm2 install pm2-logrotate
      // Configure:    pm2 set pm2-logrotate:max_size 50M
      //               pm2 set pm2-logrotate:retain 14
      //               pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Migrations run once before the workers start. Run migrate.js via pm2
      // pre-deploy hook or a separate one-off step — do NOT run migrations from
      // every worker in cluster mode (race conditions).
    },
  ],
};
