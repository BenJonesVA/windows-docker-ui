# Plan item #26 — a SEPARATE privileged helper image from
# webui/firewall-helper, deliberately, rather than widening that image's own
# `ENTRYPOINT ["iptables"]` contract to dispatch between multiple binaries.
# Doing that would break any already-deployed host that hasn't rebuilt the
# firewall-helper image the next time docker/firewall.ts calls it — its
# Cmd-is-iptables-args shape would silently become wrong. This image only
# ever backs one best-effort feature (anti-spoofing rp_filter hardening,
# docker/firewall.ts ensureRpFilter) that fails safe if this image is never
# built at all — see compose.yml for the build step.
#
# Built and tagged locally at deploy time, same as firewall-helper — never
# pushed to a registry, so there's no digest to pin the way
# template.ts pins the sandbox image. Pin the FROM instead; re-verify this
# digest against `docker inspect alpine:3.20` when bumping (same digest
# firewall-helper/Dockerfile already pins, for consistency).
FROM alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

# Alpine's busybox includes a minimal `sysctl` applet already, but installing
# procps' real implementation explicitly is a one-word insurance policy
# against relying on undocumented busybox applet behavior for something that
# runs with NET_ADMIN on the host network namespace.
RUN apk add --no-cache procps

ENTRYPOINT ["sysctl"]
