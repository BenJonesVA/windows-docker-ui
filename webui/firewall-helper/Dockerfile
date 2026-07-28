# Built and tagged locally at deploy time (see compose.yml) — never pushed to
# a registry, so it can't be pinned by a remote digest the way
# webui/src/docker/template.ts pins the sandbox image. Pin the FROM instead;
# re-verify this digest against `docker inspect alpine:3.20` when bumping.
FROM alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN apk add --no-cache iptables

ENTRYPOINT ["iptables"]
