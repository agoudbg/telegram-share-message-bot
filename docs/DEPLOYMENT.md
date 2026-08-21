# Deployment

The recommended production layout runs the application from source under
systemd and lets the host's existing reverse proxy own public ports and TLS.
The HTTP server listens on `127.0.0.1:3000` by default.

## Source deployment

### Prerequisites

- A Linux host with systemd and Nginx
- Node.js 24.11 or newer (satisfies both the backend and WebA requirements)
- pnpm 10 and npm 11
- Git, a C/C++ compiler toolchain, Python 3, and `make` for native modules
- A public HTTPS hostname and Telegram credentials described in the README

The commands below assume the checkout lives at
`/opt/telegram-batch-forwarding-bot/current`, persistent state lives at
`/var/lib/telegram-batch-forwarding-bot`, and the service account is `tbfb`.
Use a versioned release directory plus a `current` symlink if atomic rollback
is required.

### Build

```bash
sudo useradd --system --home /var/lib/telegram-batch-forwarding-bot \
  --shell /usr/sbin/nologin tbfb
sudo install -d -o tbfb -g tbfb /var/lib/telegram-batch-forwarding-bot
sudo install -d /opt/telegram-batch-forwarding-bot

sudo git clone --recurse-submodules <repository-url> \
  /opt/telegram-batch-forwarding-bot/current
sudo chown -R tbfb:tbfb /opt/telegram-batch-forwarding-bot/current

sudo -u tbfb pnpm --dir /opt/telegram-batch-forwarding-bot/current \
  install --frozen-lockfile
sudo -u tbfb pnpm --dir /opt/telegram-batch-forwarding-bot/current build

cd /opt/telegram-batch-forwarding-bot/current/apps/web
sudo -u tbfb npm ci
sudo -u tbfb env BASE_URL=https://shares.example.com npm run build:share
```

Native dependencies are compiled during installation. Do not copy an existing
`node_modules` directory from another operating system or Node.js version.

### Configure the application

Create `/etc/telegram-batch-forwarding-bot.env`, readable only by root and the
service group:

```dotenv
API_ID=123456
API_HASH=replace-me
BOT_TOKEN=replace-me
PUBLIC_ORIGIN=https://shares.example.com
HOST=127.0.0.1
PORT=3000
SANITIZE_SECRET=replace-with-a-stable-random-secret
BOT_USERNAME=example_bot
MINIAPP_SHORT_NAME=share
DATA_DIR=/var/lib/telegram-batch-forwarding-bot
SESSION_FILE=/var/lib/telegram-batch-forwarding-bot/session.txt
INTERNAL_MEDIA_PORT=3001
INTERNAL_MEDIA_SECRET=replace-with-an-independent-random-secret
TRUST_PROXY=1
```

Generate both secrets independently, for example with
`openssl rand -base64 48`. Keep `SANITIZE_SECRET` stable across restores:
changing it changes the public fake ids derived for every share. `SESSION`
may be left unset when `SESSION_FILE` is configured.

```bash
sudo chown root:tbfb /etc/telegram-batch-forwarding-bot.env
sudo chmod 0640 /etc/telegram-batch-forwarding-bot.env
sudo install -m 0644 deploy/systemd/telegram-batch-forwarding-bot.service \
  /etc/systemd/system/telegram-batch-forwarding-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-batch-forwarding-bot
curl --fail http://127.0.0.1:3000/healthz
```

The supplied unit starts `deploy/start-app.mjs`, which supervises the bot and
HTTP server as one failure domain. If either child exits unexpectedly, systemd
restarts both so the loopback media origin and API cannot drift apart.

### Configure the host reverse proxy

Copy `deploy/nginx/telegram-batch-forwarding-bot.conf` into the host Nginx
configuration, replace `shares.example.com`, test it, and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

The example intentionally owns only the virtual host; use the host's existing
TLS automation to add its certificate and HTTPS listener. It serves the WebA
build directly and proxies only `/api/` and `/media/` to the loopback server.
It overwrites client-IP headers, which is required before enabling
`TRUST_PROXY=1`. Never expose port 3000 publicly while that flag is enabled.
The virtual host also sends `X-Robots-Tag: noindex, nofollow` for share pages
and public resources. Verify the deployed header after reloading Nginx:

```bash
curl --head https://shares.example.com/s/<shareId>
```

### Logs and lifecycle

```bash
systemctl status telegram-batch-forwarding-bot
journalctl -u telegram-batch-forwarding-bot -f
sudo systemctl restart telegram-batch-forwarding-bot
sudo systemctl stop telegram-batch-forwarding-bot
```

### Upgrade and rollback

Build and verify a new version before restarting the service. For a simple
in-place checkout:

```bash
cd /opt/telegram-batch-forwarding-bot/current
sudo -u tbfb git pull --ff-only
sudo -u tbfb git submodule update --init --recursive
sudo -u tbfb pnpm install --frozen-lockfile
sudo -u tbfb pnpm build
cd apps/web
sudo -u tbfb npm ci
sudo -u tbfb env BASE_URL=https://shares.example.com npm run build:share
sudo systemctl restart telegram-batch-forwarding-bot
curl --fail http://127.0.0.1:3000/healthz
```

For safer releases, build into `/opt/telegram-batch-forwarding-bot/releases/<id>`
and point `current` at the verified release. Rollback then consists of
restoring the previous symlink and restarting the unit. The persistent data
directory must remain outside every release directory.

## Backup and restore

Stop the service while copying SQLite so the database and WAL are captured
consistently:

```bash
sudo systemctl stop telegram-batch-forwarding-bot
sudo rsync -a --exclude cache/ /var/lib/telegram-batch-forwarding-bot/ \
  /srv/backups/telegram-batch-forwarding-bot/data-YYYY-MM-DD/
sudo systemctl start telegram-batch-forwarding-bot
```

Back up `/etc/telegram-batch-forwarding-bot.env` in the same encrypted backup
set. The media cache is disposable and intentionally excluded; Telegram
repopulates it from the source locators stored in `tbfb.db`. To restore, stop
the service, restore the complete data directory and environment file, repair
ownership to `tbfb:tbfb`, then start the service and check `/healthz`.
