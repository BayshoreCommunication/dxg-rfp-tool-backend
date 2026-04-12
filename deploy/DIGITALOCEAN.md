# Deploy DXG RFP Tool Backend on a DigitalOcean Droplet (2nd project)

This guide assumes:

- You already have Nginx running on the droplet (because another project is hosted there).
- You want this backend to run as a separate service on a different local port and be exposed via a **new domain/subdomain**.
- Your droplet IP is `68.183.227.9`.

## Recommended setup (Docker Compose + Nginx)

### 1) DNS

Create an A record pointing to the droplet IP:

- `api.dxg-agency.com` → `68.183.227.9`

Example: `api.dxg-agency.com`.

### 2) Install prerequisites on the droplet

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y git nginx
```

Install Docker + Docker Compose plugin (if not already installed):

```bash
docker --version || curl -fsSL https://get.docker.com | sudo sh
docker compose version || sudo apt install -y docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out/in once after adding yourself to the `docker` group.

### 3) Clone the repo to the droplet

```bash
cd /var/www
sudo mkdir -p dxg-rfp-tool-backend
sudo chown -R $USER:$USER dxg-rfp-tool-backend

git clone https://github.com/BayshoreCommunication/dxg-rfp-tool-backend.git dxg-rfp-tool-backend
cd dxg-rfp-tool-backend
```

### 4) Create `.env` on the droplet

Create `/var/www/dxg-rfp-tool-backend/.env` with production values.
You can start from `./.env.example` in this repo.

At minimum:

```env
NODE_ENV=production
PORT=8000
MONGODB_URL=...
JWT_SECRET=...
FRONTEND_URL=https://<your-frontend-domain>
BACKEND_URL=https://api.dxg-agency.com
```

If you use OpenAI extraction + email + Spaces uploads, also set:

- `OPENAI_API_KEY`
- SMTP vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_MAIL`, `SMTP_PASSWORD`)
- DigitalOcean Spaces vars (`DO_SPACES_*`)

### 5) Start the backend container (binds to localhost:8001)

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

Verify locally on the droplet:

```bash
curl -sS http://127.0.0.1:8001/health
```

If DNS is already pointing, also verify from your laptop:

```bash
nslookup api.dxg-agency.com
```

### 6) Add Nginx config for the new backend domain

Create:

```bash
sudo nano /etc/nginx/sites-available/dxg-rfp-tool-backend.conf
```

Use the template in `deploy/nginx/dxg-rfp-tool-backend.conf` (replace the `server_name`):

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 80;
  server_name api.dxg-agency.com;

  client_max_body_size 60m;

  location / {
    proxy_pass http://127.0.0.1:8001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/dxg-rfp-tool-backend.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 7) Enable HTTPS (Let’s Encrypt)

If you’re already using Certbot for your first project, reuse it; otherwise:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.dxg-agency.com
```

### 8) Updates / redeploy

```bash
cd /var/www/dxg-rfp-tool-backend
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

## Notes for “2nd project on the same droplet”

- Keep this backend on `127.0.0.1:8001` so it does not conflict with your existing project ports.
- Nginx decides which project to serve by **domain name** (`server_name`).
- If you rely on local `/uploads`, the `./uploads:/app/uploads` volume keeps files persistent.
