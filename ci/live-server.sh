#!/usr/bin/env bash
# Runs this machine's Autocode install (~/.autocode) as a process in tmux until
# it is installed as the systemd service (`autocode install`); the live checks
# start and restart the server with it. A development tool: a host keeps its
# copy in ~/.autocode-dev/, not in the install's bin/.
#   live-server.sh start|stop|restart|status
# Env: AUTOCODE_HOME (default ~/.autocode: bin/autocode, the data and tokens,
# logs/serve.log), LIVE_LISTEN (default 127.0.0.1:4848), LIVE_ID (default the
# host name).
set -euo pipefail

home="${AUTOCODE_HOME:-$HOME/.autocode}"
binary="$home/bin/autocode"
logfile="$home/logs/serve.log"
listen="${LIVE_LISTEN:-127.0.0.1:4848}"
id="${LIVE_ID:-$(hostname -s)}"
session=autocode

running() { tmux has-session -t "$session" 2>/dev/null; }

start() {
  if running; then
    echo "already running"
    return 0
  fi
  # Folders made here are private (0700), like the rest of the Autocode home.
  (umask 077 && mkdir -p "$home/logs")
  tmux new-session -d -s "$session" \
    "exec '$binary' serve --listen '$listen' --id '$id' --data '$home' \
>> '$logfile' 2>&1"
  local first="${listen%%,*}"
  for _ in $(seq 60); do
    if curl -fsS --max-time 2 "http://$first/v1/info" >/dev/null 2>&1; then
      echo "started: $(curl -fsS --max-time 2 "http://$first/v1/info")"
      return 0
    fi
    sleep 0.5
  done
  echo "did not answer; see $logfile" >&2
  return 1
}

stop() {
  if running; then
    tmux send-keys -t "$session" C-c
    for _ in $(seq 20); do
      running || break
      sleep 0.5
    done
    running && tmux kill-session -t "$session"
  fi
  echo "stopped"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status) running && echo "running" || echo "stopped" ;;
  *)
    echo "usage: live-server.sh start|stop|restart|status" >&2
    exit 2
    ;;
esac
