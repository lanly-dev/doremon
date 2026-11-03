#!/bin/sh
# Doremon process actions (macOS / Linux): kill / suspend / resume one process.
# Prints "OK" on success, or "ERR:<message>" and exits 1 on failure.
#
# Usage: sh actions.sh <kill|suspend|resume> <pid>

action="$1"
pid="$2"

if [ -z "$pid" ] || [ "$pid" = "0" ]; then
  printf 'ERR:no process id given\n'
  exit 1
fi

send_signal() {
  kill "-$1" "$pid" 2>/dev/null && return 0
  # Already exited: treat as done.
  kill -0 "$pid" 2>/dev/null || return 0
  return 1
}

case "$action" in
  kill)
    if send_signal 9; then printf 'OK\n'; exit 0; fi
    printf 'ERR:could not kill PID %s (permission denied?)\n' "$pid"
    exit 1
    ;;
  suspend)
    if send_signal STOP; then printf 'OK\n'; exit 0; fi
    printf 'ERR:could not suspend PID %s (permission denied?)\n' "$pid"
    exit 1
    ;;
  resume)
    if send_signal CONT; then printf 'OK\n'; exit 0; fi
    printf 'ERR:could not resume PID %s (permission denied?)\n' "$pid"
    exit 1
    ;;
  *)
    printf 'ERR:unknown action %s\n' "$action"
    exit 1
    ;;
esac
