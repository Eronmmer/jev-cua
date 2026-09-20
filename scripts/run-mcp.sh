#!/bin/sh
set -eu

node_bin=""
for candidate in \
  /opt/homebrew/opt/node@24/bin/node \
  /usr/local/opt/node@24/bin/node
do
  if [ -x "$candidate" ]; then
    node_bin="$candidate"
    break
  fi
done

if [ -z "$node_bin" ]; then
  node_bin="$(command -v node || true)"
fi

if [ -z "$node_bin" ]; then
  echo "jev-cua requires Node.js 24.21 or newer" >&2
  exit 78
fi

node_version="$("$node_bin" -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_remainder="${node_version#*.}"
node_minor="${node_remainder%%.*}"

if [ "$node_major" -lt 24 ] || { [ "$node_major" -eq 24 ] && [ "$node_minor" -lt 21 ]; }; then
  echo "jev-cua requires Node.js 24.21 or newer; found $node_version" >&2
  exit 78
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$node_bin" "$script_dir/../mcp/server.cjs"
