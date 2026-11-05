// Doremon UI and monitoring logic.
//
// Everything here runs in the app window (the Neutralino webview). Snapshots
// arrive from scanner.js; this file diffs them to detect ports opening and
// closing, works out per-process CPU, and paints the three views.

(() => {
  const $ = (id) => document.getElementById(id);

  const PREFS_KEY = 'doremon.prefs';
  const EVENT_LIMIT = 500;
  const EVENT_RENDER_LIMIT = 300;
  const STATUS_HINT = 'Close the window to keep monitoring from the tray.';

  const state = {
    tab: 'ports',
    query: '',
    pidFilter: null,
    showAllSockets: false,
    pinOnly: false,
    // Pinned ports: proto|port -> { proto, port, up }. `up` stays null until the
    // first snapshot, so launching the app never alerts about existing ports.
    pinned: new Map(),
    paused: false,
    interval: 2000,
    notify: false,
    cores: 1,
    processes: [],
    sockets: [],
    listeners: new Map(),
    prevCpu: new Map(),
    prevTs: 0,
    events: [],
    eventSeq: 0,
    eventCount: 0,
    lastSnapshotAt: 0,
    // Processes suspended from this app. Windows does not expose a reliable
    // "is suspended" flag, so the app remembers what it changed this session.
    suspended: new Set(),
    sort: {
      ports: { key: 'port', dir: 1 },
      processes: { key: 'cpuPct', dir: -1 },
    },
    traySignature: '',
    hintTimer: null,
    scanner: { state: 'starting', detail: '' },
  };

  /* ---------------------------------------------------------------- helpers */

  const escapeHtml = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function fmtBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  function fmtPct(value) {
    const n = Number(value) || 0;
    if (n >= 100) return n.toFixed(0) + '%';
    if (n >= 10) return n.toFixed(1) + '%';
    return n.toFixed(2) + '%';
  }

  function fmtAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    const d = Math.floor(h / 24);
    return d + 'd ' + String(h % 24).padStart(2, '0') + 'h';
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  const normalState = (socket) => String(socket.state || '').toLowerCase();

  // A socket counts as a "port" when something is listening / bound to it.
  // Established connections churn constantly, so they never raise port events.
  const isMonitored = (socket) => socket.proto === 'udp' || normalState(socket) === 'listen' || normalState(socket) === 'bound';

  const matchesQuery = (haystack) => !state.query || String(haystack).toLowerCase().includes(state.query);

  const pinKey = (proto, port) => String(proto).toLowerCase() + '|' + port;

  const isPinned = (proto, port) => state.pinned.has(pinKey(proto, port));

  function togglePin(proto, port) {
    const key = pinKey(proto, port);
    const label = String(proto).toUpperCase() + ' :' + port;
    if (state.pinned.has(key)) {
      state.pinned.delete(key);
      flashStatus('Unpinned ' + label);
    } else {
      state.pinned.set(key, { proto: String(proto).toLowerCase(), port, up: null });
      flashStatus('Pinned ' + label);
    }
    savePrefs();
    render();
  }

  // Alerts compare the port's net state between snapshots rather than individual
  // sockets, so a process restart (close + open in one tick) stays quiet.
  function evaluatePinned(listeners) {
    for (const entry of state.pinned.values()) {
      let owner = null;
      for (const record of listeners.values()) {
        if (record.proto !== entry.proto || record.port !== entry.port) continue;
        if (!owner) owner = record;
      }
      const up = Boolean(owner);
      if (entry.up !== null && entry.up !== up) notifyPinned(entry, up, owner);
      entry.up = up;
    }
  }

  function notifyPinned(entry, up, owner) {
    const label = 'Port ' + entry.port + ' (' + entry.proto.toUpperCase() + ')';
    const who = owner && owner.name && owner.name !== 'unknown' ? ' — ' + owner.name + ' (' + owner.pid + ')' : '';
    const title = up ? 'Pinned port opened' : 'Pinned port closed';
    const body = up ? label + ' is listening' + who : label + ' is no longer listening';
    flashStatus(title.replace('Pinned port', 'Pinned') + ': ' + body);
    Neutralino.os.showNotification(title, body).catch(() => {});
  }

  /* -------------------------------------------------------------- snapshots */

  function buildSnapshot(snapshot) {
    const ts = snapshot.endedAt || snapshot.ts || Date.now();
    const cores = snapshot.cores || state.cores || 1;
    state.cores = cores;

    const dt = state.prevTs ? (ts - state.prevTs) / 1000 : 0;
    const nameByPid = new Map();
    for (const proc of snapshot.processes) nameByPid.set(proc.pid, proc.name);

    // Per-process CPU comes from the cumulative CPU seconds reported by the
    // scanner: the delta over wall-clock time, normalised by core count.
    const processes = snapshot.processes.map((proc) => {
      const previous = state.prevCpu.get(proc.pid);
      let cpuPct = 0;
      if (dt > 0.05 && typeof previous === 'number') {
        const delta = proc.cpuSeconds - previous;
        if (delta > 0) cpuPct = Math.min((delta / dt) / cores * 100, 100 * cores);
      }
      return Object.assign({}, proc, { cpuPct });
    });

    const prevCpu = new Map();
    for (const proc of snapshot.processes) prevCpu.set(proc.pid, proc.cpuSeconds);
    state.prevCpu = prevCpu;
    state.prevTs = ts;

    // Diff the listener set to learn which ports opened and closed.
    const nextListeners = new Map();
    const opened = [];
    for (const socket of snapshot.sockets) {
      if (!isMonitored(socket)) continue;
      const key = socket.proto + '|' + socket.port + '|' + socket.pid;
      let record = nextListeners.get(key);
      if (!record) {
        const previous = state.listeners.get(key);
        record = {
          key,
          proto: socket.proto,
          port: socket.port,
          pid: socket.pid,
          state: normalState(socket) === 'listen' ? 'Listen' : socket.state,
          name: nameByPid.get(socket.pid) || (previous && previous.name) || 'unknown',
          addrs: [],
          openedAt: previous ? previous.openedAt : ts,
        };
        nextListeners.set(key, record);
        if (!previous) opened.push(record);
      }
      if (socket.addr && record.addrs.indexOf(socket.addr) === -1) record.addrs.push(socket.addr);
    }

    const closed = [];
    for (const [key, record] of state.listeners) {
      if (!nextListeners.has(key)) closed.push(record);
    }

    const portsByPid = new Map();
    for (const record of nextListeners.values()) portsByPid.set(record.pid, (portsByPid.get(record.pid) || 0) + 1);

    const connsByPid = new Map();
    let connTotal = 0;
    for (const socket of snapshot.sockets) {
      if (normalState(socket) !== 'established') continue;
      connTotal += 1;
      connsByPid.set(socket.pid, (connsByPid.get(socket.pid) || 0) + 1);
    }

    for (const proc of processes) {
      proc.portCount = portsByPid.get(proc.pid) || 0;
      proc.connCount = connsByPid.get(proc.pid) || 0;
    }

    for (const pid of state.suspended) {
      if (!nameByPid.has(pid)) state.suspended.delete(pid);
    }

    state.listeners = nextListeners;
    state.sockets = snapshot.sockets;
    state.processes = processes;
    state.connTotal = connTotal;
    state.lastSnapshotAt = Date.now();

    evaluatePinned(nextListeners);

    recordEvents(closed, 'closed', ts);
    recordEvents(opened, 'opened', ts);
    if (state.notify) notifyChanges(opened, closed);

    if (!state.loggedFirstSnapshot) {
      state.loggedFirstSnapshot = true;
      Neutralino.debug.log(
        'First snapshot: ' + processes.length + ' processes, ' + snapshot.sockets.length + ' sockets, ' + nextListeners.size + ' listeners, ' + cores + ' cores',
        'INFO'
      );
    }

    render();
  }

  function recordEvents(records, kind, ts) {
    if (!records.length) return;
    const entries = records.map((record) => ({
      id: ++state.eventSeq,
      ts,
      kind,
      proto: record.proto,
      port: record.port,
      pid: record.pid,
      name: record.name,
      addr: record.addrs.join(', '),
    }));
    state.events = entries.reverse().concat(state.events);
    if (state.events.length > EVENT_LIMIT) state.events.length = EVENT_LIMIT;
    state.eventCount += entries.length;
  }

  function notifyChanges(opened, closed) {
    const tell = (title, items) => {
      if (!items.length) return;
      if (items.length <= 2) {
        for (const item of items) {
          const verb = title === 'Port opened' ? 'is now listening' : 'stopped listening';
          Neutralino.os.showNotification(title, item.proto.toUpperCase() + ' :' + item.port + ' ' + verb + ' — ' + item.name + ' (' + item.pid + ')').catch(() => {});
        }
      } else {
        Neutralino.os.showNotification(title === 'Port opened' ? 'Ports opened' : 'Ports closed', items.length + ' listening ports ' + (title === 'Port opened' ? 'opened' : 'closed') + ' at once').catch(() => {});
      }
    };
    tell('Port opened', opened);
    tell('Port closed', closed);
  }

  /* ----------------------------------------------------------------- render */

  function render() {
    renderStats();
    renderPorts();
    renderProcesses();
    renderActivity();
    updateTray();
  }

  function renderStats() {
    $('statProcs').textContent = state.processes.length ? String(state.processes.length) : '—';
    $('statPorts').textContent = state.listeners.size ? String(state.listeners.size) : '0';
    $('statConns').textContent = state.sockets.length ? String(state.connTotal) : '—';

    const cpu = state.processes.reduce((sum, proc) => sum + (proc.cpuPct || 0), 0);
    $('statCpu').textContent = state.processes.length ? fmtPct(cpu) : '—';

    const mem = state.processes.reduce((sum, proc) => sum + (proc.mem || 0), 0);
    $('statMem').textContent = state.processes.length ? fmtBytes(mem) : '—';

    $('statEvents').textContent = String(state.eventCount);

    const pinnedDown = Array.from(state.pinned.values()).filter((entry) => entry.up === false).length;
    $('pinOnlyLabel').textContent = state.pinned.size
      ? 'Pinned (' + state.pinned.size + (pinnedDown ? ' · ' + pinnedDown + ' down' : '') + ')'
      : 'Pinned';

    $('tabCountPorts').textContent = String(state.listeners.size);
    $('tabCountProcs').textContent = String(state.processes.length);
    $('tabCountEvents').textContent = String(state.events.length);
  }

  function portRows() {
    const now = Date.now();
    let rows;
    if (state.showAllSockets) {
      const nameByPid = new Map(state.processes.map((proc) => [proc.pid, proc.name]));
      rows = state.sockets.map((socket) => ({
        key: socket.proto + '|' + socket.port + '|' + socket.pid + '|' + socket.addr,
        proto: socket.proto,
        port: socket.port,
        state: socket.state || '—',
        addr: socket.addr || '—',
        pid: socket.pid,
        name: nameByPid.get(socket.pid) || 'unknown',
        monitored: isMonitored(socket),
        openAt: null,
        age: '',
      }));
    } else {
      rows = Array.from(state.listeners.values()).map((record) => ({
        key: record.key,
        proto: record.proto,
        port: record.port,
        state: record.state || '—',
        addr: record.addrs.join(', ') || '—',
        pid: record.pid,
        name: record.name,
        monitored: true,
        openAt: record.openedAt,
        age: fmtAge(now - record.openedAt),
      }));
    }
    if (state.pinOnly) {
      rows = rows.filter((row) => isPinned(row.proto, row.port));
      // A pinned port that is down has no listener row, so synthesise one: that
      // is the whole point of pinning a service you are waiting on.
      if (!state.showAllSockets) {
        for (const entry of state.pinned.values()) {
          const listening = rows.some((row) => row.proto === entry.proto && row.port === entry.port);
          if (listening) continue;
          rows.push({
            key: entry.proto + '|' + entry.port + '|down',
            proto: entry.proto,
            port: entry.port,
            state: 'Down',
            addr: '—',
            pid: 0,
            name: 'not listening',
            monitored: false,
            openAt: null,
            age: '',
            down: true,
          });
        }
      }
    }

    if (state.pidFilter != null) rows = rows.filter((row) => row.pid === state.pidFilter);
    if (state.query) rows = rows.filter((row) => matchesQuery(row.name + ' ' + row.pid + ' ' + row.port + ' ' + row.proto + ' ' + row.addr + ' ' + row.state));
    return sortRows(rows, state.sort.ports, 'port');
  }

  const SORTERS = {
    port: (a, b) => a.port - b.port,
    proto: (a, b) => String(a.proto).localeCompare(String(b.proto)),
    state: (a, b) => String(a.state).localeCompare(String(b.state)),
    addr: (a, b) => String(a.addr || a.addrs || '').localeCompare(String(b.addr || b.addrs || '')),
    name: (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }),
    pid: (a, b) => (a.pid || 0) - (b.pid || 0),
    openAt: (a, b) => (a.openAt || 0) - (b.openAt || 0),
    cpuPct: (a, b) => (a.cpuPct || 0) - (b.cpuPct || 0),
    mem: (a, b) => (a.mem || 0) - (b.mem || 0),
    threads: (a, b) => (a.threads || 0) - (b.threads || 0),
    portCount: (a, b) => (a.portCount || 0) - (b.portCount || 0),
    connCount: (a, b) => (a.connCount || 0) - (b.connCount || 0),
  };

  function sortRows(rows, sort, fallbackKey) {
    const key = sort.key || fallbackKey;
    const compare = SORTERS[key] || SORTERS[fallbackKey] || (() => 0);
    return rows.slice().sort((a, b) => compare(a, b) * (sort.dir || 1));
  }

  function renderPorts() {
    const rows = portRows();
    const body = $('portsBody');
    $('portsEmpty').classList.toggle('hidden', rows.length > 0);

    body.innerHTML = rows
      .map((row) => {
        const selected = state.pidFilter != null && row.pid === state.pidFilter ? ' is-selected' : '';
        const dim = row.monitored ? '' : ' style="opacity:.62"';
        const pinned = isPinned(row.proto, row.port);
        return (
          '<tr class="' + (selected + (row.down ? ' is-down' : '')).trim() + '" data-pid="' + row.pid + '"' + dim + '>' +
          '<td class="pin-col">' +
          '<button type="button" class="pin-btn' + (pinned ? ' is-pinned' : '') + '" data-pin-proto="' + escapeHtml(row.proto) + '" data-pin-port="' + escapeHtml(row.port) + '" ' +
          'title="' + (pinned ? 'Unpin and stop alerts' : 'Pin: alert me when this port opens or closes') + '">' +
          (pinned ? '★' : '☆') +
          '</button>' +
          '</td>' +
          '<td class="port-cell">' + escapeHtml(row.port) + '</td>' +
          '<td class="mono">' + escapeHtml(row.proto) + '</td>' +
          '<td><span class="badge state-' + escapeHtml(normalState(row)) + '">' + escapeHtml(row.state) + '</span></td>' +
          '<td class="mono" title="' + escapeHtml(row.addr) + '">' + escapeHtml(row.addr) + '</td>' +
          '<td><div class="proc-cell"><span class="proc-name">' + escapeHtml(row.name) + '</span></div></td>' +
          '<td class="num pid-cell">' + escapeHtml(row.pid) + '</td>' +
          '<td class="num mono">' + escapeHtml(row.age || '—') + '</td>' +
          '</tr>'
        );
      })
      .join('');

    markSortedHeaders('ports');
  }

  function processRows() {
    let rows = state.processes;
    if (state.pidFilter != null) {
      rows = rows.filter((proc) => proc.pid === state.pidFilter);
    }
    if (state.query) {
      rows = rows.filter((proc) => matchesQuery(proc.name + ' ' + proc.pid + ' ' + (proc.title || '') + ' ' + (proc.portCount || '')));
    }
    return sortRows(rows, state.sort.processes, 'cpuPct');
  }

  function renderProcesses() {
    const rows = processRows();
    $('procsEmpty').classList.toggle('hidden', rows.length > 0);

    $('procsBody').innerHTML = rows
      .map((proc) => {
        const selected = state.pidFilter != null && proc.pid === state.pidFilter ? ' is-selected' : '';
        const hot = (proc.cpuPct || 0) >= 25 ? ' cpu-hot' : '';
        const suspended = state.suspended.has(proc.pid);
        return (
          '<tr class="' + selected.trim() + '" data-pid="' + proc.pid + '">' +
          '<td><div class="proc-cell"><span class="proc-name">' + escapeHtml(proc.name) + '</span>' +
          (suspended ? '<span class="badge suspended">suspended</span>' : '') + '</div></td>' +
          '<td class="num pid-cell">' + escapeHtml(proc.pid) + '</td>' +
          '<td class="num mono' + hot + '">' + fmtPct(proc.cpuPct) + '</td>' +
          '<td class="num mono">' + fmtBytes(proc.mem) + '</td>' +
          '<td class="num mono">' + (proc.threads || 0) + '</td>' +
          '<td class="num mono">' + (proc.portCount ? proc.portCount : '·') + '</td>' +
          '<td class="num mono">' + (proc.connCount ? proc.connCount : '·') + '</td>' +
          '<td title="' + escapeHtml(proc.title || '') + '">' + escapeHtml(proc.title || '') + '</td>' +
          '<td class="actions-col">' +
          '<button type="button" class="btn tiny ghost" data-action="' + (suspended ? 'resume' : 'suspend') + '" data-pid="' + proc.pid + '">' +
          (suspended ? 'Resume' : 'Suspend') + '</button>' +
          '<button type="button" class="btn tiny danger" data-action="kill" data-pid="' + proc.pid + '">Kill</button>' +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    markSortedHeaders('processes');
  }

  function renderActivity() {
    const list = $('eventsList');
    const events = state.events.slice(0, EVENT_RENDER_LIMIT);
    $('eventsEmpty').classList.toggle('hidden', events.length > 0);
    $('activitySummary').textContent = events.length
      ? state.events.length + ' events · ports are tracked while Doremon runs'
      : 'Ports that open and close while Doremon is running show up here.';

    list.innerHTML = events
      .map(
        (event) =>
          '<li>' +
          '<span class="ts">' + fmtClock(event.ts) + '</span>' +
          '<span class="badge ' + (event.kind === 'opened' ? 'open' : 'close') + '">' + (event.kind === 'opened' ? 'open' : 'close') + '</span>' +
          '<span class="ev-port">:' + escapeHtml(event.port) + '</span>' +
          '<span class="ev-proto">' + escapeHtml(event.proto) + '</span>' +
          '<span class="ev-proc">' + escapeHtml(event.name) + ' · ' + escapeHtml(event.pid) + '</span>' +
          '<span class="ev-addr">' + escapeHtml(event.addr || '') + '</span>' +
          '</li>'
      )
      .join('');
  }

  function markSortedHeaders(panel) {
    const table = $(panel === 'ports' ? 'panel-ports' : 'panel-processes');
    const sort = state.sort[panel];
    table.querySelectorAll('th.sortable').forEach((th) => {
      const active = th.dataset.sort === sort.key;
      th.classList.toggle('is-sorted', active);
      th.classList.toggle('desc', active && sort.dir === -1);
    });
  }

  /* ---------------------------------------------------------------- version */

  // scripts/build.mjs stamps each build with its git commit; a `neu run`
  // development session has no stamp and shows "dev" instead.
  async function showBuildLabel() {
    const label = $('buildLabel');
    const version = 'v' + (typeof NL_APPVERSION !== 'undefined' ? NL_APPVERSION : '');

    let info = null;
    try {
      const response = await fetch('js/build-info.json', { cache: 'no-store' });
      if (response.ok) info = await response.json();
    } catch (error) {
      info = null;
    }

    // `neu run` loads resources/ from disk, so the stamp lying there belongs to
    // the last build and cannot describe the code that is actually running.
    const devRun = typeof NL_RESMODE !== 'undefined' && NL_RESMODE === 'directory';
    label.textContent = version + ' · ' + (!devRun && info && info.commit ? info.commit.slice(0, 7) : 'dev');

    const details = [];
    if (devRun) details.push('Development run: resources/ is loaded from disk, so this is not a built version');
    if (info && info.notes) details.push(info.notes);
    if (info && info.builtAt) details.push('built ' + new Date(info.builtAt).toLocaleString());
    if (info && info.dirty) details.push('built from a tree with uncommitted changes');
    label.title = details.length ? details.join('\n') : 'Development build: no stamped commit';
  }

  /* ------------------------------------------------------------------- tray */

  const countOf = (value, word) => value + ' ' + word + (value === 1 ? '' : 's');

  function pinnedStatusSuffix() {
    if (!state.pinned.size) return '';
    const down = Array.from(state.pinned.values()).filter((entry) => entry.up === false).length;
    return ' · ' + state.pinned.size + ' pinned' + (down ? ' (' + down + ' down)' : '');
  }

  async function updateTray() {
    const menu = [
      {
        id: 'status',
        text:
          state.scanner.state === 'error'
            ? 'Scanner error'
            : (state.paused ? 'Paused · ' : '') +
              countOf(state.listeners.size, 'port') +
              ' · ' +
              countOf(state.processes.length, 'process') +
              pinnedStatusSuffix(),
        isDisabled: true,
      },
      { text: '-' },
      { id: 'show', text: 'Open Doremon' },
      { id: 'pause', text: state.paused ? 'Resume monitoring' : 'Pause monitoring', isChecked: state.paused },
      { id: 'notify', text: 'Notify on all port changes', isChecked: state.notify },
      { text: '-' },
      { id: 'quit', text: 'Quit Doremon' },
    ];

    const signature = JSON.stringify(menu);
    if (signature === state.traySignature) return;
    try {
      await Neutralino.os.setTray({ icon: '/resources/icons/trayIcon.png', menuItems: menu });
      state.traySignature = signature;
    } catch (error) {
      Neutralino.debug.log('setTray failed: ' + ((error && error.message) || error), 'WARNING');
    }
  }

  /* ------------------------------------------------------------------- ui */

  function setActiveTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === 'panel-' + tab));
    savePrefs();
  }

  function setPidFilter(pid) {
    state.pidFilter = state.pidFilter === pid ? null : pid;
    renderPidChip();
    render();
  }

  function renderPidChip() {
    const chip = $('pidChip');
    if (state.pidFilter == null) {
      chip.classList.add('hidden');
      chip.innerHTML = '';
      return;
    }
    chip.classList.remove('hidden');
    const proc = state.processes.find((item) => item.pid === state.pidFilter);
    chip.innerHTML =
      'PID ' + escapeHtml(state.pidFilter) + (proc ? ' · ' + escapeHtml(proc.name) : '') +
      '<button type="button" data-clear-pid="1" title="Clear filter">×</button>';
  }

  function setScannerStatus(kind, detail) {
    state.scanner = { state: kind, detail: detail || '' };
    const dot = $('liveDot');
    dot.classList.toggle('is-live', kind === 'running');
    dot.classList.toggle('is-paused', kind === 'paused');
    dot.classList.toggle('is-error', kind === 'error');

    if (kind === 'starting') $('statusScanner').textContent = 'Starting scanner…';
    else if (kind === 'running') $('statusScanner').textContent = 'Monitoring · every ' + state.interval / 1000 + 's' + (detail ? ' · ' + detail : '');
    else if (kind === 'paused') $('statusScanner').textContent = 'Paused';
    else if (kind === 'error') $('statusScanner').textContent = 'Scanner not running';
  }

  function showError(message) {
    $('errorText').textContent = message;
    $('errorBar').classList.remove('hidden');
  }

  function hideError() {
    $('errorBar').classList.add('hidden');
  }

  function togglePause() {
    state.paused = !state.paused;
    const button = $('pauseBtn');
    button.textContent = state.paused ? 'Resume' : 'Pause';
    button.classList.toggle('is-paused', state.paused);
    if (state.paused) {
      Scanner.stop();
      setScannerStatus('paused');
      $('statusUpdated').textContent = '';
    } else {
      Scanner.start(state.interval);
    }
    updateTray();
  }

  function startScanner() {
    state.paused = false;
    $('pauseBtn').textContent = 'Pause';
    $('pauseBtn').classList.remove('is-paused');
    Scanner.start(state.interval);
  }

  function flashStatus(text) {
    const hint = $('statusHint');
    hint.textContent = text;
    clearTimeout(state.hintTimer);
    state.hintTimer = setTimeout(() => {
      hint.textContent = STATUS_HINT;
    }, 6000);
  }

  async function handleAction(action, pid) {
    if (!pid) return;
    const proc = state.processes.find((item) => item.pid === pid);
    const label = (proc ? proc.name : 'PID ' + pid) + ' (' + pid + ')';

    if (pid <= 4) {
      showError('PID ' + pid + ' is a protected system process.');
      return;
    }
    if (pid === Number(NL_PID)) {
      showError('Doremon will not act on its own process.');
      return;
    }

    // Every state-changing action is confirmed first.
    if (action === 'kill' || action === 'suspend') {
      const kill = action === 'kill';
      const choice = await Neutralino.os.showMessageBox(
        kill ? 'Kill process?' : 'Suspend process?',
        label + (kill ? '\n\nUnsaved work in this process will be lost.' : '\n\nIts threads will be frozen until you resume it.'),
        'YES_NO',
        kill ? 'WARNING' : 'QUESTION'
      );
      if (String(choice || '').toUpperCase() !== 'YES') return;
    }

    try {
      await ProcActions.run(action, pid);
    } catch (error) {
      showError('Could not ' + action + ' ' + label + ': ' + ((error && error.message) || error));
      return;
    }

    if (action === 'suspend') state.suspended.add(pid);
    else if (action === 'resume') state.suspended.delete(pid);
    if (action === 'kill') state.processes = state.processes.filter((item) => item.pid !== pid);

    hideError();
    flashStatus({ kill: 'Killed', suspend: 'Suspended', resume: 'Resumed' }[action] + ' ' + label);
    render();
  }

  async function quit() {
    try {
      await Scanner.stop();
    } catch (error) {
      /* ignore */
    }
    await Neutralino.app.exit();
  }

  function tick() {
    if (!state.lastSnapshotAt) return;
    const age = Date.now() - state.lastSnapshotAt;
    $('statusUpdated').textContent = state.paused ? '' : age < 10000 ? 'Updated just now' : 'Updated ' + fmtAge(age) + ' ago';
    if (state.scanner.state === 'running') {
      $('statusScanner').textContent = 'Monitoring · every ' + state.interval / 1000 + 's';
    }
  }

  /* ---------------------------------------------------------------- prefs */

  async function loadPrefs() {
    try {
      const raw = await Neutralino.storage.getData(PREFS_KEY);
      const prefs = JSON.parse(raw);
      if (prefs && typeof prefs === 'object') {
        if ([1000, 2000, 5000].includes(prefs.interval)) state.interval = prefs.interval;
        if (typeof prefs.notify === 'boolean') state.notify = prefs.notify;
        if (typeof prefs.showAllSockets === 'boolean') state.showAllSockets = prefs.showAllSockets;
        if (['ports', 'processes', 'activity'].includes(prefs.tab)) state.tab = prefs.tab;
        if (typeof prefs.pinOnly === 'boolean') state.pinOnly = prefs.pinOnly;
        if (Array.isArray(prefs.pinned)) {
          state.pinned = new Map();
          for (const item of prefs.pinned) {
            if (!item || typeof item.port !== 'number') continue;
            const proto = String(item.proto || 'tcp').toLowerCase();
            state.pinned.set(pinKey(proto, item.port), { proto, port: item.port, up: null });
          }
        }
      }
    } catch (error) {
      /* first run: no saved preferences */
    }
  }

  function savePrefs() {
    Neutralino.storage
      .setData(
        PREFS_KEY,
        JSON.stringify({
          interval: state.interval,
          notify: state.notify,
          showAllSockets: state.showAllSockets,
          tab: state.tab,
          pinOnly: state.pinOnly,
          pinned: Array.from(state.pinned.values()).map((entry) => ({ proto: entry.proto, port: entry.port })),
        })
      )
      .catch(() => {});
  }

  /* ------------------------------------------------------------------ wire */

  function wireUi() {
    $('search').addEventListener('input', (event) => {
      state.query = event.target.value.trim().toLowerCase();
      render();
    });

    $('interval').addEventListener('change', (event) => {
      state.interval = Number(event.target.value) || 2000;
      savePrefs();
      setScannerStatus(state.paused ? 'paused' : 'starting');
      if (state.paused) {
        $('statusScanner').textContent = 'Paused';
      } else {
        Scanner.start(state.interval);
      }
    });

    $('pauseBtn').addEventListener('click', togglePause);
    $('hideBtn').addEventListener('click', () => Neutralino.window.hide());

    $('retryBtn').addEventListener('click', () => {
      hideError();
      startScanner();
    });
    $('dismissBtn').addEventListener('click', hideError);

    $('allSockets').addEventListener('change', (event) => {
      state.showAllSockets = event.target.checked;
      savePrefs();
      render();
    });

    $('pinOnly').addEventListener('change', (event) => {
      state.pinOnly = event.target.checked;
      savePrefs();
      render();
    });

    $('clearEvents').addEventListener('click', () => {
      state.events = [];
      state.eventCount = 0;
      renderStats();
      renderActivity();
    });

    document.querySelectorAll('.tab').forEach((button) => {
      button.addEventListener('click', () => setActiveTab(button.dataset.tab));
    });

    document.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const panel = th.closest('.panel').id === 'panel-ports' ? 'ports' : 'processes';
        const sort = state.sort[panel];
        if (sort.key === th.dataset.sort) sort.dir = -sort.dir;
        else {
          sort.key = th.dataset.sort;
          sort.dir = ['name', 'proto', 'state', 'addr'].includes(sort.key) ? 1 : -1;
        }
        render();
      });
    });

    $('portsBody').addEventListener('click', (event) => {
      const pinButton = event.target.closest('button[data-pin-port]');
      if (pinButton) {
        event.stopPropagation();
        togglePin(pinButton.dataset.pinProto, Number(pinButton.dataset.pinPort));
        return;
      }
      const row = event.target.closest('tr');
      if (!row) return;
      const pid = Number(row.dataset.pid);
      if (pid > 0) setPidFilter(pid);
    });

    $('procsBody').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (button) {
        event.stopPropagation();
        handleAction(button.dataset.action, Number(button.dataset.pid));
        return;
      }
      const row = event.target.closest('tr');
      if (!row) return;
      state.pidFilter = Number(row.dataset.pid);
      renderPidChip();
      setActiveTab('ports');
      render();
    });

    $('pidChip').addEventListener('click', (event) => {
      if (event.target.dataset.clearPid) {
        state.pidFilter = null;
        renderPidChip();
        render();
      }
    });

    Neutralino.events.on('trayMenuItemClicked', async (event) => {
      const id = (event.detail && event.detail.id) || '';
      if (id === 'show') {
        await Neutralino.window.show();
        try {
          await Neutralino.window.focus();
        } catch (error) {
          /* focus is best-effort */
        }
      } else if (id === 'pause') {
        togglePause();
      } else if (id === 'notify') {
        state.notify = !state.notify;
        savePrefs();
        updateTray();
      } else if (id === 'quit') {
        quit();
      }
    });

    Neutralino.events.on('windowClose', () => {
      Neutralino.window.hide();
    });

    Neutralino.events.on('windowShow', () => {
      render();
    });
  }

  /* ------------------------------------------------------------------ init */

  async function init() {
    Neutralino.init();
    wireUi();
    await loadPrefs();

    $('interval').value = String(state.interval);
    $('allSockets').checked = state.showAllSockets;
    $('pinOnly').checked = state.pinOnly;
    setActiveTab(state.tab);

    Scanner.init({
      snapshot: buildSnapshot,
      status: (kind, detail) => {
        // A (re)started scanner has no previous counters to diff against, so
        // clear them to avoid a bogus CPU spike on the first new snapshot.
        if (kind === 'starting') {
          state.prevTs = 0;
          state.prevCpu = new Map();
        }
        setScannerStatus(kind, kind === 'running' && detail && detail.pid ? 'pid ' + detail.pid : '');
        if (kind === 'running') hideError();
        updateTray();
      },
      error: (message) => {
        Neutralino.debug.log('Scanner error: ' + message, 'ERROR');
        showError(message);
        setScannerStatus('error');
        updateTray();
      },
    });

    setScannerStatus('starting');
    updateTray();
    Scanner.start(state.interval);
    setInterval(tick, 1000);
    await showBuildLabel();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
