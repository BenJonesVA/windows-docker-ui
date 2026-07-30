#!/usr/bin/env bash
# One-shot setup for a fresh Linux Docker host, per the prerequisites documented
# in compose.yml and README.md. Idempotent — safe to re-run after a partial
# failure or to pick up a newly-bumped pinned image digest.
#
# Usage: sudo ./install.sh [--yes] [--skip-daemon-config] [--seed-email=E --seed-password=P]
set -euo pipefail

ASSUME_YES=0
SKIP_DAEMON=0
SEED_EMAIL=""
SEED_PASSWORD=""

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --skip-daemon-config) SKIP_DAEMON=1 ;;
    --seed-email=*) SEED_EMAIL="${arg#*=}" ;;
    --seed-password=*) SEED_PASSWORD="${arg#*=}" ;;
    -h|--help)
      echo "Usage: sudo $0 [--yes] [--skip-daemon-config] [--seed-email=E --seed-password=P]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

info()  { echo -e "\033[1;34m[install]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[install]\033[0m $*"; }
fail()  { echo -e "\033[1;31m[install]\033[0m $*" >&2; exit 1; }

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

REPO_ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$REPO_ROOT"

[ "$(id -u)" = 0 ] || fail "Must run as root (sudo ./install.sh) — it writes /etc/docker/daemon.json, may restart docker, and needs docker socket access."
[ "$(uname -s)" = Linux ] || fail "This app requires a Linux host with KVM — Docker Desktop (Mac/Windows) can't expose /dev/kvm to containers."
command -v docker >/dev/null 2>&1 || fail "docker is not installed. Install Docker Engine + the Compose plugin first."
docker compose version >/dev/null 2>&1 || fail "docker compose (plugin) is not available. Install it, then re-run."

info "Repo root: $REPO_ROOT"

# --- 1. KVM ---------------------------------------------------------------
if [ -e /dev/kvm ]; then
  info "KVM device present (/dev/kvm) — good."
else
  warn "/dev/kvm not found. Every sandbox instance will fail to start without it."
  warn "Check virtualization is enabled in BIOS/hypervisor and 'kvm-ok' (apt install cpu-checker) passes."
  confirm "Continue anyway?" || fail "Aborted — fix KVM availability first."
fi

# --- 2. Docker daemon address-pool (deploy/daemon.json) --------------------
if [ "$SKIP_DAEMON" = 1 ]; then
  warn "Skipping daemon.json merge (--skip-daemon-config)."
else
  DAEMON_JSON=/etc/docker/daemon.json
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found — cannot safely merge $DAEMON_JSON without clobbering existing keys."
    warn "Merge deploy/daemon.json into $DAEMON_JSON by hand, then 'systemctl restart docker'."
  else
    MERGE_RESULT="$(python3 - "$DAEMON_JSON" "$REPO_ROOT/deploy/daemon.json" <<'PY'
import json, sys

target_path, source_path = sys.argv[1], sys.argv[2]
with open(source_path) as f:
    new_pools = json.load(f)["default-address-pools"]

try:
    with open(target_path) as f:
        current = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    current = {}

if "default-address-pools" in current:
    if current["default-address-pools"] == new_pools:
        print("unchanged")
    else:
        print("conflict")
else:
    current["default-address-pools"] = new_pools
    with open(target_path, "w") as f:
        json.dump(current, f, indent=2)
        f.write("\n")
    print("changed")
PY
)"
    case "$MERGE_RESULT" in
      unchanged)
        info "Docker daemon.json already has the required address-pool config — no change needed."
        ;;
      conflict)
        warn "Existing $DAEMON_JSON already sets 'default-address-pools' to something different."
        warn "Not overwriting it automatically — check by hand against deploy/daemon.json if you hit a network-pool-exhausted error later."
        ;;
      changed)
        info "Merged deploy/daemon.json into $DAEMON_JSON."
        warn "This requires restarting the Docker daemon, which restarts every container on this host."
        if confirm "Restart Docker now (systemctl restart docker)?"; then
          systemctl restart docker
          info "Docker daemon restarted."
        else
          warn "Skipped restart — 'default-address-pools' won't take effect until you run: systemctl restart docker"
        fi
        ;;
    esac
  fi
fi

# --- 3. Pre-pull the pinned Windows base image ------------------------------
IMAGE_REF="$(grep -oE "dockurr/windows@sha256:[0-9a-f]+" webui/src/docker/template.ts | head -n1 || true)"
[ -n "$IMAGE_REF" ] || fail "Could not read the pinned image digest out of webui/src/docker/template.ts — has it moved?"
info "Pulling pinned base image: $IMAGE_REF (this is large, may take a while)..."
docker pull "$IMAGE_REF"

# --- 4. Build the locally-only helper images --------------------------------
info "Building sandbox-firewall-helper:latest (required — egress rules, OEM/telemetry setup)..."
docker build -t sandbox-firewall-helper:latest ./webui/firewall-helper

info "Building sandbox-net-helper:latest (optional — anti-spoofing hardening only)..."
if ! docker build -t sandbox-net-helper:latest ./webui/net-helper; then
  warn "net-helper build failed — non-fatal, ensureRpFilter just silently skips that hardening step."
fi

# --- 5. .env ----------------------------------------------------------------
if [ -f .env ]; then
  info ".env already exists — leaving it as-is."
else
  cp .env.example .env
  SECRET="$(openssl rand -hex 32)"
  # Portable in-place edit (no -i suffix quirks between GNU/BSD sed).
  sed "s/^COOKIE_SECRET=.*/COOKIE_SECRET=${SECRET}/" .env > .env.tmp && mv .env.tmp .env
  info "Created .env with a freshly generated COOKIE_SECRET."
  warn "COOKIE_SECURE defaults to true — browsers silently drop the session cookie over plain http."
  warn "Set COOKIE_SECURE=false in .env only for ad-hoc testing without TLS in front; keep it true behind a real reverse proxy."
fi

# --- 6. Bring the manager up -------------------------------------------------
info "Starting the manager (docker compose up -d --build)..."
docker compose up -d --build

# --- 7. First admin account --------------------------------------------------
if [ -n "$SEED_EMAIL" ] && [ -n "$SEED_PASSWORD" ]; then
  info "Seeding first admin account for $SEED_EMAIL..."
  docker compose exec -T webui sh -c "SEED_EMAIL='${SEED_EMAIL}' SEED_PASSWORD='${SEED_PASSWORD}' npm run db:seed"
else
  warn "No --seed-email/--seed-password given — create the first admin account yourself:"
  echo "    docker compose exec webui sh -c \"SEED_EMAIL=you@example.com SEED_PASSWORD='pick-something' npm run db:seed\""
fi

info "Done. The manager is listening on 127.0.0.1:8080 on this host."
warn "Put a TLS-terminating reverse proxy (Caddy, nginx, etc.) in front on 443 before exposing this beyond localhost."
