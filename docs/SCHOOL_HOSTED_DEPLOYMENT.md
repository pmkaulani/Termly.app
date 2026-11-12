# Termly Phase 2 — School-hosted installation

## What this phase delivers

This phase makes the current Termly web application configurable at runtime and packages it as a static web container that can run on a school's own Linux server. It also lets the existing Electron desktop client open a school-hosted Termly URL from a per-user configuration file.

The school-hosted runtime is deliberately separated into two independently maintained pieces:

1. **Termly web application** — the existing React/Vite application, served by Nginx.
2. **Supabase backend** — the official Supabase self-hosted Docker Compose stack, containing PostgreSQL, Auth, API gateway, Storage, Realtime, Studio and Edge Functions as configured by the chosen official release.

The Termly web container does not embed or reimplement Supabase. This keeps the deployment aligned with the upstream Supabase release and avoids copying a large, fast-moving third-party Compose stack into Termly.

## Hosting requirements

Supabase's current self-hosting guide (updated 5 November 2026) lists **4 GB RAM, 2 CPU cores and 40 GB SSD as minimum requirements**, and **8 GB+ RAM, 4+ cores and 80 GB+ SSD as recommended** for the full component stack. These figures are for Supabase itself, not a performance guarantee for Termly or a school with many concurrent users. Allow extra capacity for the OS, backups, storage growth and the Termly web app.

Recommended starting configuration for a small/medium school:

- Dedicated Ubuntu/Debian Linux server (or a properly administered Linux VM).
- 4 CPU cores or more.
- 8–16 GB RAM as a practical starting point.
- 128–256 GB SSD, preferably mirrored or protected by the school's storage strategy.
- Reliable UPS power and network equipment.
- A second backup destination that is not the same physical disk as the database.

Do not use a teacher's ordinary laptop as the permanent production database host. A Windows 11 PC with Docker Desktop/WSL2 can be used for evaluation, but this kit's server scripts target Linux and the production guidance assumes a maintained Linux host.

Official requirement reference: https://supabase.com/docs/guides/self-hosting/docker

## The deployment topology

```text
Staff computers / school tablets / school Wi-Fi
                       |
                       v
        HTTPS school hostname / reverse proxy
                       |
            +----------+----------+
            |                     |
            v                     v
      Termly web app        Supabase API gateway
       Nginx :8080              :8000
            |                     |
            |              Auth / REST / Storage /
            |               Realtime / Functions
            |                     |
            +----------+----------+
                       |
                       v
                PostgreSQL
           school-owned data volume
```

The official Supabase stack and Termly web container are prepared separately. This avoids assuming that the internal Docker network names or gateway service names will remain unchanged between Supabase releases.

## Prepare the Supabase backend

1. Install Docker Engine and the Docker Compose plugin on the Linux server. Also install Git, OpenSSL and `jq` if missing.
2. Review the official Supabase self-hosting guide and its release notes.
3. From the Termly repository root, run:

   ```bash
   sudo SUPABASE_REF=self-hosted/v0.8.4 bash scripts/prepare-supabase-stack.sh /opt/termly/supabase
   ```

   The script follows the official manual-install layout and pins the self-hosted release ref. The default ref is the release documented by Supabase on 5 November 2026. Review the release notes before changing it.
4. Edit `/opt/termly/supabase/.env`. Replace any remaining example values. The official key-generation helpers should create the cryptographic secrets and API keys, but you must review the final file.
5. Configure URLs for your actual LAN DNS names. For the example Caddy setup:

   - `SUPABASE_PUBLIC_URL=https://api.termly.school.example`
   - `API_EXTERNAL_URL=https://api.termly.school.example/auth/v1` (confirm the exact value against the pinned release's `.env.example` and configuration reference)
   - `SITE_URL=https://termly.school.example`
   - `DASHBOARD_PASSWORD` must be a strong, non-default password.
   - Set `API_GW_HTTP_PORT=127.0.0.1:8000` so the gateway is only reachable by the local reverse proxy, not directly from the LAN. Confirm the rendered binding using `docker compose config` before starting.
6. Do not expose PostgreSQL, Supavisor, Supabase Studio, or the API gateway directly to the public internet. Use a host firewall and verify Docker-published ports; Docker port publishing can interact differently with host firewall rules.
7. Start only after checking all settings:

   ```bash
   cd /opt/termly/supabase
   docker compose config
   sh run.sh start
   docker compose ps
   ```

Supabase docs: https://supabase.com/docs/guides/self-hosting/docker

## Configure HTTPS and school DNS

Use DNS records that resolve only on the school's network, or an organisation-controlled internal DNS zone. The included `deployment/school-hosted/caddy/Caddyfile.example` is a starting example for Caddy's internal certificate authority:

- `termly.school.example` reverse proxies to `127.0.0.1:8080`.
- `api.termly.school.example` reverse proxies to `127.0.0.1:8000`.

Before enabling Caddy, make sure the published Supabase API gateway port is actually bound to loopback as intended. Install and trust the Caddy internal root certificate on every staff device. Do not ask staff to bypass browser certificate warnings.

For parent access from outside the school, use a properly secured public HTTPS domain or an approved VPN. Do not expose the database or an unprotected Studio dashboard. A local-only hostname and internal certificate will not work for parents outside the LAN unless they join the school's VPN or equivalent private network.

## Configure Termly's runtime connection

The Termly build now loads `termly-runtime-config.js` before the application bundle. This lets the same built release connect to different Supabase installations without rebuilding the JavaScript bundle.

From the Termly repository root, run:

```bash
node scripts/configure-runtime.mjs
```

Enter:

- Supabase API base URL: `https://api.termly.school.example`
- Supabase publishable key: the `SUPABASE_PUBLISHABLE_KEY` from the self-hosted Supabase `.env` file (or the compatible anon key if the release uses legacy keys).

The output is written to `deployment/school-hosted/runtime/termly-runtime-config.js` and is mounted into the Nginx container. It is intentionally public. **Only a publishable/anon key belongs here.** Never copy `SUPABASE_SECRET_KEY`, `SERVICE_ROLE_KEY`, `POSTGRES_PASSWORD`, `JWT_SECRET`, M-PESA credentials or SMS credentials into this file.

For an isolated LAN test with no TLS yet, the configuration tool permits an explicit HTTP opt-in only for a private LAN hostname/IP. This is a temporary test mode, not recommended production security. Use HTTPS before the school's staff or parent devices submit real passwords or student information.

## Deploy Termly web application

```bash
cp deployment/school-hosted/.env.example deployment/school-hosted/.env
# Review TERMLY_WEB_BIND and TERMLY_WEB_PORT.
bash scripts/install-school-hosted-web.sh
```

By default, the Termly web container listens on port 8080 on the LAN. If using the included host Caddy reverse proxy, set `TERMLY_WEB_BIND=127.0.0.1` in `deployment/school-hosted/.env` and let Caddy expose only ports 80/443.

Open `https://termly.school.example` from a staff device. Verify login, student listing, photos, reports, realtime updates and Storage access.

## Configure Electron desktop clients

The Windows Electron build can now be pointed to a school-hosted web instance without rebuilding the desktop installer.

On each Windows user's profile, create:

`%APPDATA%\Termly\termly-desktop.json`

Example:

```json
{
  "serverUrl": "https://termly.school.example",
  "allowInsecureLan": false
}
```

Restart Termly. The Electron shell loads the configured school-hosted URL. Its renderer still has `nodeIntegration: false`, `contextIsolation: true` and `sandbox: true`. The existing bundled client remains the fallback when no school server is configured.

Do not put API keys, passwords or service secrets in this desktop file. It only identifies the Termly server address.

## Edge Functions and third-party integrations

The existing `mpesa-stk-push` Edge Function had a fixed CORS origin allowlist for the hosted Termly site and local development. This Phase 2 patch adds a server-side `TERMLY_ALLOWED_ORIGINS` variable so a school can explicitly allow its own HTTPS Termly hostname. It does not use wildcard CORS and does not grant the hosted Termly origin to unknown callers.

Copy the Termly function directories into the pinned Supabase stack's `volumes/functions/` directory (preserve the default `hello` function and any other functions):

```bash
cp -a /path/to/Termly/supabase/functions/mpesa-stk-push /opt/termly/supabase/volumes/functions/
cp -a /path/to/Termly/supabase/functions/mpesa-callback /opt/termly/supabase/volumes/functions/
```

In `/opt/termly/supabase/`, create a private `.env.functions` file and add the exact browser origin and the server-side M-PESA secrets required by the current function code:

```env
TERMLY_ALLOWED_ORIGINS=https://termly.school.example
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_PASSKEY=...
MPESA_SHORTCODE=...
MPESA_CALLBACK_URL=https://api.termly.school.example/functions/v1/mpesa-callback?token=...
MPESA_CALLBACK_TOKEN=...
MPESA_ENVIRONMENT=production
```

Protect `.env.functions` with restrictive filesystem permissions and add `env_file: .env.functions` to the `functions` service in the pinned Supabase `docker-compose.yml`, as described in Supabase's self-hosted Functions guide. Then run `sh run.sh recreate functions`. Do not commit this file.

**M-PESA callback reachability is a special case:** Safaricom must be able to reach the callback URL over HTTPS from outside the school's LAN. A private IP or internal-only DNS name will not work. If the school does not have a suitable public HTTPS hostname, use a narrowly scoped authenticated callback relay/tunnel that exposes only the callback route, or plan to reconcile using an approved alternative. Do not expose PostgreSQL, Studio or the whole internal API gateway just to receive the callback.

The actual M-PESA Daraja credentials, callback token and any SMS provider credentials must remain server-side Edge Function secrets. They must never be placed in `termly-runtime-config.js`. For schools with their own Daraja shortcode/provider account, a later secure per-school credential vault and routing design is required; do not assume the current shared-function configuration automatically supports independent school accounts.

Supabase self-hosted Functions reference: https://supabase.com/docs/guides/self-hosting/self-hosted-functions

## Database schema and data migrations

This phase does **not** automatically apply Termly database migrations. First start the Supabase stack, then apply the full, ordered Termly migration history to that school's new database using the supported Supabase migration workflow or a controlled SQL administration session. Check the migration order, inspect any historical migrations that assume managed-project extensions or hosted secrets, and test against a disposable database before using real student records.

Do not simply copy SQL files into an already-running PostgreSQL data directory and assume they will execute. Do not skip earlier migrations because a later one appears to create the same table.

Run Termly's complete smoke tests on the school-hosted instance before importing real student data. In particular verify Auth redirect URLs, RLS isolation, Storage buckets/policies, Realtime subscriptions, parent/staff portal RPCs, Edge Functions and M-PESA callback reachability.

## Current boundaries — not yet production-complete

- This phase supplies runtime API configuration, the static web container, a pinned Supabase preparation script and Electron server selection.
- It does not automate all Termly SQL migrations, Edge Function deployment/secrets, database backups, point-in-time recovery, disaster restore or monitored upgrades.
- Supabase self-hosting does not include the managed platform's backups/PITR, branching, Management API and several managed observability/analytics services. The school/operator must own those responsibilities.
- The Termly page still loads Chart.js and fonts from external CDNs in `index.html`; some visual resources therefore still need internet access. Fully offline asset bundling is a separate follow-up.
- Dexie/offline sync remains selective. A school server being local does not magically make every Termly operation offline-first.
- Remote parent access requires a reachable HTTPS endpoint or VPN. A school LAN-only server cannot serve parents at home by itself.
- Termly's school-hosted installation is one Supabase project/database per school, not a central Termly multi-school dashboard. Platform-wide reporting across isolated installations needs an explicit, consented telemetry/licensing design.

Do not describe this phase as a validated production installer until database migrations, backups/restoration, security review and end-to-end school acceptance tests have passed.
