#!/bin/sh
# Start as root so a mounted data volume can be handed to the node user, then drop privileges.
set -eu
data_file="${DATA_FILE:-/data/state.json}"
mkdir -p "$(dirname "$data_file")"
chown -R node:node "$(dirname "$data_file")"
exec su node -c "exec node src/server.js"
