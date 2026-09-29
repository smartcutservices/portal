#!/bin/sh
set -eu

# Do not start the HTTP endpoint until ClamAV has usable signatures.
freshclam --stdout >/dev/null 2>&1
freshclam --daemon --checks=24 >/dev/null 2>&1 &
clamd --foreground >/dev/null 2>&1 &
clamd_pid=$!
attempt=0
until clamdscan --ping=1:1 >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ] || ! kill -0 "$clamd_pid" 2>/dev/null; then
    exit 1
  fi
  sleep 1
done
exec node /app/server.js
