#!/bin/sh
# Doremon POSIX scanner (macOS / Linux).
# Emits the same tab-separated stream as scanner.ps1 so the UI is identical:
#   BEGIN <tsMs> <cores>
#   P <pid> <name> <cpuSeconds> <memBytes> <threads> <title>
#   L <proto> <address> <port> <state> <pid>
#   END <tsMs>
#
# Usage: sh scanner.sh [intervalMs]

interval="${1:-2000}"
parent="${2:-0}"

case "$(uname -s)" in
  Darwin) os_name=mac ;;
  *) os_name=linux ;;
esac

cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)
[ -z "$cores" ] && cores=1

now_ms() { echo $(($(date +%s) * 1000)); }

scan_processes() {
  if [ "$os_name" = mac ]; then
    ps -axo pid=,time=,rss=,comm= 2>/dev/null | awk '
      function to_seconds(t,   parts, n, secs, i) {
        secs = 0
        if (t ~ /-/) { split(t, parts, "-"); secs = parts[1] * 86400; t = parts[2] }
        n = split(t, parts, ":")
        if (n == 3) secs += parts[1] * 3600 + parts[2] * 60 + parts[3]
        else if (n == 2) secs += parts[1] * 60 + parts[2]
        else secs += t
        return secs
      }
      {
        pid = $1
        cpu = to_seconds($2)
        rss = $3
        name = $4
        for (i = 5; i <= NF; i++) name = name " " $i
        printf "P\t%s\t%s\t%.2f\t%d\t0\t\n", pid, name, cpu, rss * 1024
      }'
  else
    ps -eo pid=,times=,rss=,nlwp=,comm= 2>/dev/null | awk '{
      pid = $1
      cpu = $2
      rss = $3
      thr = $4
      name = $5
      for (i = 6; i <= NF; i++) name = name " " $i
      printf "P\t%s\t%s\t%s\t%d\t%s\t\n", pid, name, cpu, rss * 1024, thr
    }'
  fi
}

scan_sockets() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP -iUDP -F pcnPT 2>/dev/null | awk '
      /^p/ { pid = substr($0, 2); state = "" }
      /^P/ { proto = tolower(substr($0, 2)); state = "" }
      /^T/ { t = substr($0, 2); sub(/^ST=/, "", t); state = t }
      /^n/ {
        name = substr($0, 2)
        idx = 0
        for (i = length(name); i > 0; i--) { if (substr(name, i, 1) == ":") { idx = i; break } }
        addr = (idx > 1) ? substr(name, 1, idx - 1) : "*"
        port = (idx > 0) ? substr(name, idx + 1) : name
        gsub(/^\[/, "", addr); gsub(/\]$/, "", addr)
        if (port !~ /^[0-9]+$/) next
        printf "L\t%s\t%s\t%s\t%s\t%s\n", proto, addr, port, (state == "" ? "Bound" : state), pid
      }'
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -tulnpH 2>/dev/null | awk '{
      netid = tolower($1)
      state = $2
      local = $5
      idx = 0
      for (i = length(local); i > 0; i--) { if (substr(local, i, 1) == ":") { idx = i; break } }
      addr = substr(local, 1, idx - 1)
      port = substr(local, idx + 1)
      gsub(/^\[/, "", addr); gsub(/\]$/, "", addr)
      pid = 0
      if (match($0, /pid=[0-9]+/)) pid = substr($0, RSTART + 4, RLENGTH - 4)
      if (state == "UNCONN") state = "Bound"
      printf "L\t%s\t%s\t%s\t%s\t%s\n", netid, addr, port, state, pid
    }'
    return
  fi

  # Last resort: netstat listeners only, without process attribution.
  netstat -an 2>/dev/null | awk '
    $1 ~ /^(tcp|udp)/ && ($6 == "LISTEN" || $6 == "LISTENING" || $1 == "udp") {
      proto = ($1 ~ /^udp/) ? "udp" : "tcp"
      local = $4
      idx = 0
      for (i = length(local); i > 0; i--) { if (substr(local, i, 1) == ":") { idx = i; break } }
      addr = substr(local, 1, idx - 1)
      port = substr(local, idx + 1)
      gsub(/^\[/, "", addr); gsub(/\]$/, "", addr)
      if (port !~ /^[0-9]+$/) next
      print "L\t" proto "\t" addr "\t" port "\t" ((proto == "udp") ? "Bound" : "Listen") "\t0"
    }'
}

while :; do
  # Exit when the app is gone, so a quit app cannot leave this scanner polling forever.
  if [ "$parent" -gt 0 ] 2>/dev/null && ! kill -0 "$parent" 2>/dev/null; then exit 0; fi

  started=$(now_ms)
  printf 'BEGIN\t%s\t%s\n' "$started" "$cores"
  scan_processes
  scan_sockets
  printf 'END\t%s\n' "$(now_ms)"

  elapsed=$(($(now_ms) - started))
  wait_ms=$((interval - elapsed))
  [ "$wait_ms" -lt 250 ] && wait_ms=250
  sleep "$(awk -v ms="$wait_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
done
