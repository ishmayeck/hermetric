#!/bin/sh
# One-time (or re-)login for hermetric.
# Builds the image if needed, runs the interactive PKCE login, and writes the
# token pair to the hermetric-data volume. Honors DOCKER_CONTEXT, so
#   DOCKER_CONTEXT=truenas ./login.sh
# logs in the deployed instance instead of a local one.
set -e
cd "$(dirname "$0")"

docker compose build --quiet hermetric
docker compose run --rm hermetric node server.mjs login

# If the service is already running, restart it so it picks up the new token
# immediately instead of after its next refresh attempt.
if [ -n "$(docker compose ps -q hermetric 2>/dev/null)" ]; then
  docker compose restart hermetric
fi
