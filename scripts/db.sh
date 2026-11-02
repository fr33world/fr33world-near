#!/bin/sh
# Local PostgreSQL (native, no Docker). `brew services` is broken on this Mac (Homebrew bug),
# so this drives pg_ctl directly. LC_ALL avoids macOS's "postmaster became multithreaded"
# startup failure. PGDATA defaults to Homebrew's postgresql@18 cluster.
#   scripts/db.sh start | stop | status
set -e
PGDATA="${PGDATA:-$(brew --prefix 2>/dev/null || echo /usr/local)/var/postgresql@18}"
LOG="${PGLOG:-$(dirname "$PGDATA")/log/postgresql@18.log}"
case "$1" in
  start) LC_ALL="${LC_ALL:-en_US.UTF-8}" pg_ctl -D "$PGDATA" -l "$LOG" start ;;
  stop) pg_ctl -D "$PGDATA" stop ;;
  status) pg_ctl -D "$PGDATA" status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
