# LocalPilot relay

Links LocalPilot machines in the same group so they can use each other's models from anywhere.
Every app keeps one outgoing connection here (WebSocket over HTTPS, port 443), so nobody needs port
forwarding or router changes.

- **No accounts.** Each app has a device key; it signs in by signing a challenge.
- **What it stores** (`/data/relay.json`): groups, their members' public keys and device names, and
  unused invite codes. Nothing else.
- **What it can't see.** Apps encrypt end to end inside the pipes; the relay forwards sealed frames.
  It is trusted for group membership: whoever runs it could add a machine to a group.
- **Limits.** Invite codes are single use and expire after 24 hours; joining needs a member's approval;
  joins, invites and commands are rate limited; each device may move `MAX_MB_PER_MIN` (default 300)
  through pipes a minute. Groups hold at most 20 machines.

## Run it on the droplet

1. Point a subdomain at the droplet, e.g. `relay.example.com` → the droplet's IP address (an A record).
2. Copy this folder to the droplet and start it next to the site:

   ```bash
   docker build -t localpilot-relay .
   docker run -d --name localpilot-relay --restart unless-stopped -v localpilot-relay:/data -p 127.0.0.1:8080:8080 localpilot-relay
   ```

   It listens only on the droplet itself (`127.0.0.1:8080`); the site's reverse proxy puts it on 443
   with a certificate. Don't open port 8080 to the internet.

3. Add the subdomain to the reverse proxy that already serves the site.

   **Caddy**

   ```
   relay.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   **nginx** (with a certificate from certbot)

   ```
   server {
       listen 443 ssl;
       server_name relay.example.com;
       ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;
       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header X-Forwarded-For $remote_addr;
           proxy_read_timeout 1h;
       }
   }
   ```

   **Traefik** (as labels on the relay container, if the site's Traefik watches Docker)

   ```
   traefik.enable=true
   traefik.http.routers.relay.rule=Host(`relay.example.com`)
   traefik.http.routers.relay.tls.certresolver=letsencrypt
   traefik.http.services.relay.loadbalancer.server.port=8080
   ```

   If the proxy itself runs in Docker, put the relay on the proxy's network instead of publishing a
   port, and point the proxy at `localpilot-relay:8080`.

4. Check it: `curl https://relay.example.com/health` prints `ok`.
5. In LocalPilot, open **Connect → Remote groups** and enter `wss://relay.example.com/ws`.

## Settings

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | Port it listens on |
| `DATA_DIR` | `/data` in Docker | Where `relay.json` is kept |
| `MAX_MB_PER_MIN` | `300` | Pipe traffic per device per minute. Chat is tiny; pooled models move gigabytes when they load |
