# Deployment assets

`systemd/telegram-batch-forwarding-bot.service` runs the bot and HTTP server.
`nginx/telegram-batch-forwarding-bot.conf` is the host virtual-host template;
Nginx owns the public ports and TLS. `start-app.mjs` supervises both Node.js
processes as one failure domain.

The complete source deployment procedure is in `../docs/DEPLOYMENT.md`.
