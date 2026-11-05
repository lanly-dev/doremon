# Doremon

A tray app that watches running processes and the ports they open, built with
[Neutralino.js](https://neutralino.js.org). Think of it as a small task manager
that also answers "who is listening on this port, and when did that change?".

The window is optional: close it and Doremon keeps monitoring from the system
tray, where the menu shows a live port/process count.

![Doremon icon](resources/icons/appIcon.png)

The interface borrows the character's palette: a blue body for the header, a thin
red collar line under it, white surfaces for the tables, and bell yellow for
pinned ports and alerts. The app and tray icons are the same mark in miniature.

## What it does

- **Processes** — every process with PID, CPU %, memory, thread count and window
  title, sortable and filterable. CPU is computed from the delta of cumulative
  CPU time between snapshots, normalised by core count.
- **Ports** — every listening TCP socket and bound UDP endpoint with the process
  that owns it, PID, bind address and how long it has been listening.
- **Open/close tracking** — each snapshot is diffed against the previous one, so a
  port that appears or disappears becomes an event with a timestamp, the port, the
  protocol and the owning process. This is the part a plain `netstat` run cannot
  show you.
- **Tray menu** — status line (including how many pinned ports are down), open
  window, pause/resume monitoring, toggle desktop notifications for all port
  changes, quit. Closing the window hides it to the tray instead of quitting.
- **Link between the two views** — click a process to see only the ports it owns;
  click a port to isolate its owner. An "All sockets" toggle adds established
  connections on top of listeners.
- **Process actions** — suspend, resume or kill a process straight from the table.
  Killing and suspending both ask for confirmation in a native dialog first, and
  Doremon refuses to act on itself or on `System`/`Idle` (PID 4/0).
- **Pinned ports** — star a port in the Ports table and Doremon raises a desktop
  notification whenever that port starts or stops listening, whether or not the
  window is open. The `Pinned` filter shows only pinned ports and keeps
  pinned-but-down ports visible, and pins are remembered across restarts.

Notifications for every port are off by default; enable them from the tray menu.
Pinned ports always notify, because pinning is an explicit request.

## Requirements

- Node.js (only to run the Neutralino CLI).
- **Windows**: built-in Windows PowerShell 5.1 or newer. This is the fully
  supported target.
- **macOS / Linux**: `lsof`, or `ss` as a fallback on Linux. The POSIX scanner is
  best-effort and has not been exercised on a real macOS/Linux machine yet.

## Run

```bash
npm run update   # fetch the Neutralino binaries + client library (neu update)
npm start        # launch the app (neu run)
```

Or with the CLI directly:

```bash
npm i -g @neutralinojs/neu
neu update
neu run
```

DevTools are off by default (`modes.window.enableInspector` in
`neutralino.config.json`), so a packaged build never opens them. To inspect while
developing, pass the internal flag through the CLI:

```bash
npx --yes @neutralinojs/neu@latest run -- --window-enable-inspector
```

## Build a distributable

```bash
npm run build          # scripts/build.mjs -> dist/
npm run build:single   # one self-contained executable
```

`scripts/build.mjs` fetches the Neutralino binaries with `neu update` when they
are missing, runs `neu build --release`, then lists what actually landed in
`dist/`: the platform executable plus `resources.neu`. Flags: `--single` (alias
`--embed`) packs the resources into the executable with `--embed-resources`,
`--clean` wipes `dist/` first, `--no-update` never touches `bin/`.

Without `--single`, keep `resources.neu` beside the executable when you move it.

## Using it

| Action | Result |
| --- | --- |
| Click a column header | Sort by that column (click again to reverse) |
| Type in the filter box | Filter the current table by name, PID, port, address or state |
| Click a process row | Show only that process's ports |
| Click a port row | Filter to the owning PID (click again to clear) |
| `☆` / `★` in the Ports table | Pin or unpin a port for open/close alerts |
| `Pinned` toggle | Show only pinned ports, including ones that are currently down |
| `Suspend` / `Resume` | Freeze all threads of a process, or continue them |
| `Kill` | Terminate the process (confirmed first, then `SIGKILL`/`Stop-Process -Force`) |
| `All sockets` | Include established TCP connections, not just listeners |
| `Pause` | Stop the scanner (no polling while paused) |
| `Hide to tray` | Hide the window; monitoring continues |
| Close the window | Same as hide — the app keeps running in the tray |
| Tray → Quit | Stop the scanner and exit |

Refresh interval, notification preference, tab, the "All sockets" toggle and the
pinned ports are persisted through `Neutralino.storage`.

## How monitoring works

Neutralino has no process or port enumeration API, so Doremon runs **one**
long-lived helper process that streams snapshots, instead of spawning a tool on
every refresh (a PowerShell start-up alone costs ~1 second):

```
resources/native/scanner.ps1   # Windows: Get-Process + Get-NetTCPConnection + Get-NetUDPEndpoint
resources/native/scanner.sh    # macOS/Linux: ps + lsof (ss fallback)
```

At launch the script is fetched from the app's resource server, written to the
temp directory (resources may live inside a bundle rather than on disk) and
started through `Neutralino.os.spawnProcess`. Its stdout is read incrementally
via the `spawnedProcess` event. If the helper dies, the app restarts it with
backoff and shows the error in the UI.

A port's identity is `proto|port|pid`, and multiple bind addresses for the same
socket (for example `127.0.0.1` and `0.0.0.0`) are merged into one row. A process
restart therefore shows up as one close event and one open event.

### Scanner stream protocol

The helper emits tab-separated lines, one snapshot at a time:

```
BEGIN <tsMs> <cores>
P <pid> <name> <cpuSeconds> <memBytes> <threads> <windowTitle>
L <proto> <address> <port> <state> <pid>
END <tsMs>
```

`state` is `Listen`, `Bound` (UDP) or a TCP state such as `Established`.
`cpuSeconds` is cumulative CPU time, which the UI converts to a percentage.

You can run the scanner directly to see what the app sees:

```bash
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File resources/native/scanner.ps1 -Interval 2000

# macOS / Linux
sh resources/native/scanner.sh 2000
```

## Project layout

```
neutralino.config.json     # app id, window/tray-friendly window settings, permissions
resources/index.html       # UI shell
resources/styles.css       # Doraemon palette: blue body, red collar, bell yellow
resources/js/app.js        # snapshot diffing, tables, tray menu, preferences, actions UI
resources/js/scanner.js    # spawns the helper process and parses its output
resources/js/actions.js    # runs kill/suspend/resume through the action helper
resources/native/          # per-platform scanner + action scripts
resources/icons/           # app + tray icons
```

Native API access is limited in `neutralino.config.json` to
`app.*`, `os.*`, `window.*`, `storage.*`, `filesystem.*` and `debug.log`.

## Limitations

- Processes owned by another user, and protected system processes, need Doremon
  to run elevated. The failure is reported in the UI rather than hidden.
- Suspended state is only known for processes this app touched, for the current
  session: a process suspended elsewhere is not flagged, and badges reset on
  restart.
- A pin matches protocol + port and alerts on net state changes, so a service
  restarting under a new PID stays quiet while a real stop or start alerts. Pins
  are stored, but the alert history is not.
- The event log lives in memory, so it starts empty on every launch.
- Linux tray icons depend on an appindicator library being present.
- The POSIX scanners are syntactically checked and follow documented `ps`,
  `lsof` and `ss` output formats, but have not been run on macOS/Linux.

## Ideas for later

Persisted port history, start-at-login, a per-process socket detail view, a tray
submenu listing pinned ports with their state, and a tray shortcut to suspend the
current top CPU consumer.
