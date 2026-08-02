# Sandbox Console

![Status: WIP](https://img.shields.io/badge/status-work--in--progress-orange)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](webui/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](webui)
[![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)](webui/package.json)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](compose.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

### This is a work in progress and in no way should be used in any sort of production environment.  I'll let you know when it gets to that point!

A self-hosted manager for disposable Windows VMs running in Docker. Sign in, click
"Create instance," and get an isolated Windows desktop in your browser a few
minutes later — no local hypervisor, no manual QEMU flags.

Under the hood, each instance is a [dockur/windows](https://github.com/dockur/windows)
container, created and torn down on demand by this project's own manager
(`webui/`). The manager handles auth, per-tenant isolation, idle/lifetime
reaping, and proxies the browser-based viewer — dockur/windows itself is
used as-is, unmodified, pulled from its published image.

## How it works

- **webui** (Fastify + React, in `webui/`) is the only thing you deploy. It
  talks to the Docker Engine API to create/start/stop/remove instances.
- Each instance gets its own Docker bridge network and storage volume — no
  instance can ever reach another, or the host's other containers.
- The browser viewer is reached through an authenticated reverse proxy
  (`/api/proxy/:id/`) — no instance ports are ever published to the host.
- A background reconciler stops idle instances (30 min) and enforces a max
  lifetime (8 h) per instance, and cleans up anything left behind by a
  crashed create/delete.

The `windows/` directory in this repo is a vendored copy of dockur/windows,
kept for reference (env vars it accepts, etc.) — it is not built or deployed;
the manager pulls the published `dockurr/windows` image by pinned digest.

## Requirements

- A Linux host with KVM (`/dev/kvm`) — Docker Desktop (Mac/Windows) cannot
  expose this to containers and cannot run instances at all. Verify with:
  ```
  ls -l /dev/kvm
  kvm-ok            # after: sudo apt install cpu-checker
  ```
- Docker Engine + Compose plugin.

## Deploying

Fastest path on a fresh Linux Docker host — `install.sh` runs every step below
(idempotent, safe to re-run), then starts the manager:

```
sudo ./install.sh
# or, for a fully non-interactive run that also seeds the first admin:
sudo ./install.sh --yes --seed-email=you@example.com --seed-password='pick-something'
```

It stops short of putting a reverse proxy in front (step 5 below) — do that
yourself. The manual steps it automates, spelled out here for anyone who wants
to do them by hand or understand what it's doing:

1. Widen the Docker daemon's address-pool so it can hand out one bridge
   network per instance (the built-in pool only supports ~30). Merge
   [`deploy/daemon.json`](deploy/daemon.json) into `/etc/docker/daemon.json`
   (don't blindly overwrite existing keys), then:
   ```
   sudo systemctl restart docker
   ```
   This restarts every container on the host — treat it as a maintenance
   window if anything else is running there.

2. Pre-pull the pinned image (the manager calls the Docker API directly,
   which doesn't auto-pull the way `docker run` does):
   ```
   docker pull dockurr/windows@sha256:743847e75b776790c059f33ac6654f84727ba36a6d458a61e37cb2b2f043d168
   ```

3. Build the helper images the manager spawns via the Docker socket at
   runtime — neither is fetched automatically, and there's no registry to
   pull them from since both are built locally:
   ```
   docker build -t sandbox-firewall-helper:latest ./webui/firewall-helper
   docker build -t sandbox-net-helper:latest ./webui/net-helper   # optional — anti-spoofing hardening only, skips silently if missing
   ```
   Skipping `sandbox-firewall-helper` is **not** optional — every instance
   create/telemetry-ingest call needs it and fails (502 / silent ingest
   errors in the logs) without it.

4. Configure and start the manager:
   ```
   cp .env.example .env   # fill in COOKIE_SECRET, set COOKIE_SECURE=true once TLS is in front
   docker compose up -d --build
   ```

5. Put a TLS-terminating reverse proxy (Caddy, nginx, etc.) in front of
   `127.0.0.1:8080` and expose only 443 — `COOKIE_SECURE=true` means the
   login cookie is silently dropped by the browser over plain HTTP.

6. Create the first admin account (there is no default one — see below):
   ```
   docker compose exec webui sh -c "SEED_EMAIL=you@example.com SEED_PASSWORD='pick-something' npm run db:seed"
   ```

## Default credentials

There aren't any fixed ones — both credentials in this system are generated
per-deployment / per-instance, not baked in:

- **Manager login (webui):** no default account exists. `db/seed.ts` refuses
  to run without `SEED_EMAIL` and `SEED_PASSWORD` set explicitly (step 5
  above). Nothing is seeded automatically on first boot.
- **Windows account, inside each instance:** username is always `Docker`
  (dockur/windows' own default, unchanged). The password is a random string
  generated fresh per instance — it is **not** dockur/windows' own upstream
  default (`admin`); this project overrides it for exactly that reason.
  It's shown once in the instance's **Access** panel in the UI after
  creation (owner-only), and via `GET /api/instances/:id`.

## Security notes

- The manager container needs `/var/run/docker.sock` mounted to create and
  manage instance containers — that's root-equivalent control over the
  Docker host, by design, not an oversight. The actual access boundary is
  who can authenticate to the manager itself.
- Instance containers run with `cap-drop: ALL` plus only the capabilities
  dockur/windows' own viewer stack needs, a memory-equal swap cap, and no
  published ports — the authenticated proxy is the only path in.

## License

This project (`webui/` and everything else in this repo except `windows/`)
is licensed under the [MIT License](LICENSE).

See [`windows/license.md`](windows/license.md) for dockur/windows' license.
This project does not distribute Windows itself; you are responsible for
your own Windows license, per Microsoft's terms.
