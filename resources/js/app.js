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
  const ALERT_LIMIT = 100;
  const STATUS_HINT = 'Close the window to keep monitoring from the tray.';
  const isWindows = () => typeof NL_OS !== 'undefined' && NL_OS === 'Windows';

  // Windows will not let an unelevated process read the image path of protected
  // system processes, so those groups get a built-in description instead of the
  // publisher/file details the scanner reads from the executable. Keys are
  // lower-case process names, without .exe.
  const GROUP_HINTS = {
    svchost: 'Windows service host — many instances are normal',
    services: 'Windows Service Control Manager',
    lsass: 'Windows security and sign-in',
    csrss: 'Windows subsystem process',
    wininit: 'Windows start-up application',
    winlogon: 'Windows sign-in and lock screen',
    smss: 'Windows session manager',
    dwm: 'Desktop Window Manager',
    fontdrvhost: 'Windows font driver host',
    searchindexer: 'Windows Search indexer',
    msmpeng: 'Microsoft Defender antivirus engine',
    system: 'Windows kernel and drivers',
    idle: 'Windows idle process',
    registry: 'Windows registry process',
    memcompression: 'Windows memory compression',
    'secure system': 'Windows security process',
    msedgewebview2: 'Microsoft Edge WebView2 — embedded browser used by apps',
    chrome: 'Google Chrome browser',
    msedge: 'Microsoft Edge browser',
    node: 'Node.js runtime',
    explorer: 'Windows File Explorer and desktop',
    conhost: 'Console Window Host',
    applicationframehost: 'Windows app window host',
    runtimebroker: 'Windows app permissions broker',
    sihost: 'Windows shell infrastructure host',
    taskhostw: 'Windows task host',
    ctfmon: 'Windows text input service',
    textinputhost: 'Windows text input host',
    startmenuexperiencehost: 'Windows Start menu',
    shellexperiencehost: 'Windows shell experience host',
    powershell: 'Windows PowerShell',
    cmd: 'Windows Command Processor',
    code: 'Visual Studio Code editor',
    windowsterminal: 'Windows Terminal',
  };

  const state = {
    tab: 'ports',
    query: '',
    pidFilter: null,
    showAllSockets: false,
    pinOnly: false,
    unknownOnly: false,
    // Pinned ports: proto|port -> { proto, port, up }. `up` stays null until the
    // first snapshot, so launching the app never alerts about existing ports.
    pinned: new Map(),
    paused: false,
    interval: 2000,
    cores: 1,
    processes: [],
    sockets: [],
    listeners: new Map(),
    prevCpu: new Map(),
    prevTs: 0,
    events: [],
    eventSeq: 0,
    eventCount: 0,
    // Group and pinned-port alerts, newest first. `read` drives the tab count
    // and the red tray icon; opening the Alerts tab marks them all read.
    alerts: [],
    unreadAlerts: 0,
    lastSnapshotAt: 0,
    // Processes suspended from this app. Windows does not expose a reliable
    // "is suspended" flag, so the app remembers what it changed this session.
    suspended: new Set(),
    // Process-name groups the user expanded; every group starts collapsed.
    expandedGroups: new Set(),
    // A name with more than this many instances raises an alert once, then
    // stays quiet until it drops back under the limit. 0 turns the check off.
    groupLimit: 50,
    alertedGroups: new Set(),
    // Windows Run-key registration (tray toggle). Read back from the registry
    // at start-up, so an entry removed by hand also unticks the menu item.
    autostart: false,
    autostartBusy: false,
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
    recordAlert('port', title, body);
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

    checkGroupLimits(processGroups(processes, state.sort.processes));

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

  /* ----------------------------------------------------------------- render */

  function render() {
    renderStats();
    renderPorts();
    renderProcesses();
    renderActivity();
    renderAlerts();
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
    $('tabCountAlerts').textContent = state.unreadAlerts > 99 ? '99+' : String(state.unreadAlerts);
    $('tabCountAlerts').classList.toggle('is-new', state.unreadAlerts > 0);
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
    count: (a, b) => (a.count || 1) - (b.count || 1),
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
      rows = rows.filter((proc) =>
        matchesQuery(
          proc.name + ' ' + proc.pid + ' ' + (proc.title || '') + ' ' + (proc.description || '') + ' ' + (proc.company || '') + ' ' + (proc.path || '') + ' ' + (proc.portCount || '')
        )
      );
    }
    return sortRows(rows, state.sort.processes, 'cpuPct');
  }

  const GROUP_TOTALS = ['cpuPct', 'mem', 'threads', 'portCount', 'connCount'];

  // Processes sharing an executable name are one group: chrome.exe with 30 tabs
  // becomes a single line holding the group's totals. A name with one instance
  // has nothing to group, so it stays a plain row.
  function processGroups(rows, sort) {
    const byName = new Map();
    for (const proc of rows) {
      const name = proc.name || 'unknown';
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(proc);
    }

    // Sorting groups by size says nothing about their members, so those keep
    // the CPU order they had before.
    const memberSort = sort && sort.key === 'count' ? { key: 'cpuPct', dir: -1 } : sort;
    const groups = [];
    for (const [name, members] of byName) {
      const group = { name, count: members.length, members: sortRows(members, memberSort, 'cpuPct') };
      for (const field of GROUP_TOTALS) {
        group[field] = members.reduce((sum, proc) => sum + (proc[field] || 0), 0);
      }
      // A group has no PID of its own; sorting by PID uses its lowest member.
      group.pid = members.reduce((low, proc) => Math.min(low, proc.pid || 0), members[0].pid || 0);
      // Executable details are shared by every instance of a name; use the
      // first member that exposed them (protected members expose none).
      const described = members.find((proc) => proc.description || proc.company || proc.path) || {};
      group.description = described.description || '';
      group.company = described.company || '';
      group.path = described.path || '';
      groups.push(group);
    }
    return sortRows(groups, sort, 'cpuPct');
  }

  const groupKey = (name) => String(name || 'unknown').toLowerCase();

  function groupHint(name) {
    return GROUP_HINTS[String(name || '').toLowerCase().replace(/\.exe$/, '')] || '';
  }

  // A group is unknown when the executable exposed no publisher/description and
  // there is no built-in hint for its name. These are the rows the Unknown
  // toggle keeps; a known name without readable metadata is not "unknown".
  function isUnknownGroup(group) {
    return !group.description && !group.company && !groupHint(group.name);
  }

  // A group's subtitle combines the publisher and the executable's own
  // description. Protected processes fall back to a name-based hint; an unknown
  // name says so rather than pretending the details were verified.
  function groupMeta(group) {
    const hint = groupHint(group.name);
    const label = [group.company, group.description].filter(Boolean).join(' · ') || hint || 'No executable details available';
    const details = [];
    if (group.description) details.push(group.description);
    if (group.company) details.push('Publisher: ' + group.company);
    if (group.path) details.push('Path: ' + group.path);
    if (!group.description && !group.company) details.push(hint || 'No executable details available.');
    if (!group.path) details.push('Executable path unavailable — protected process or access denied.');
    else details.push('Read from the executable file details; not a signature check.');
    return { label, title: details.join('\n') };
  }

  // One notification per group each time it crosses the limit; falling back to
  // the allowed count re-arms it. A limit of 0 turns the check off.
  function checkGroupLimits(groups) {
    if (!state.groupLimit) return;
    for (const group of groups) {
      const key = groupKey(group.name);
      if (group.count <= state.groupLimit) {
        state.alertedGroups.delete(key);
        continue;
      }
      if (state.alertedGroups.has(key)) continue;
      state.alertedGroups.add(key);
      const limit = state.groupLimit;
      const title = 'Many ' + group.name + ' processes';
      const body = group.count + ' instances are running — more than the ' + limit + ' allowed for one process name.';
      flashStatus(group.name + ': ' + group.count + ' instances (limit ' + limit + ')');
      Neutralino.os.showNotification(title, body).catch(() => {});
      recordAlert('group', title, body);
    }
  }

  function procRowHtml(proc, child) {
    const selected = state.pidFilter != null && proc.pid === state.pidFilter ? ' is-selected' : '';
    const hot = (proc.cpuPct || 0) >= 25 ? ' cpu-hot' : '';
    const suspended = state.suspended.has(proc.pid);
    return (
      '<tr class="' + (selected + (child ? ' is-child' : '')).trim() + '" data-pid="' + proc.pid + '">' +
      '<td><div class="proc-cell"><span class="proc-name">' + escapeHtml(proc.name) + '</span>' +
      (suspended ? '<span class="badge suspended">suspended</span>' : '') + '</div></td>' +
      '<td class="num pid-cell">' + escapeHtml(proc.pid) + '</td>' +
      '<td class="num mono' + hot + '">' + fmtPct(proc.cpuPct) + '</td>' +
      '<td class="num mono">' + fmtBytes(proc.mem) + '</td>' +
      '<td class="num mono">' + (proc.threads || 0) + '</td>' +
      '<td class="num mono">' + (proc.portCount ? proc.portCount : '·') + '</td>' +
      '<td class="num mono">' + (proc.connCount ? proc.connCount : '·') + '</td>' +
      '<td class="num mono count-cell">·</td>' +
      '<td title="' + escapeHtml(proc.title || '') + '">' + escapeHtml(proc.title || '') + '</td>' +
      '<td class="actions-col">' +
      '<button type="button" class="btn tiny ghost" data-action="' + (suspended ? 'resume' : 'suspend') + '" data-pid="' + proc.pid + '">' +
      (suspended ? 'Resume' : 'Suspend') + '</button>' +
      '<button type="button" class="btn tiny danger" data-action="kill" data-pid="' + proc.pid + '">Kill</button>' +
      '</td>' +
      '</tr>'
    );
  }

  function groupRowHtml(group) {
    const key = groupKey(group.name);
    const collapsed = !state.expandedGroups.has(key);
    const hot = group.cpuPct >= 25 ? ' cpu-hot' : '';
    const over = state.groupLimit > 0 && group.count > state.groupLimit;
    const meta = groupMeta(group);
    return (
      '<tr class="group-row" data-group="' + escapeHtml(key) + '" title="' +
      (collapsed ? 'Show' : 'Hide') + ' the ' + group.count + ' processes in this group">' +
      '<td><div class="proc-cell group-cell">' +
      '<div class="group-head">' +
      '<span class="group-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
      '<span class="proc-name">' + escapeHtml(group.name) + '</span>' +
      '<span class="badge group-count' + (over ? ' is-alert' : '') + '" title="' +
      (over ? 'Over the limit of ' + state.groupLimit + ' instances' : 'Processes in this group') + '">' +
      group.count + '</span>' +
      '</div>' +
      '<span class="group-desc" title="' + escapeHtml(meta.title) + '">' + escapeHtml(meta.label) + '</span>' +
      '</div></td>' +
      '<td class="num pid-cell">—</td>' +
      '<td class="num mono' + hot + '">' + fmtPct(group.cpuPct) + '</td>' +
      '<td class="num mono">' + fmtBytes(group.mem) + '</td>' +
      '<td class="num mono">' + group.threads + '</td>' +
      '<td class="num mono">' + (group.portCount ? group.portCount : '·') + '</td>' +
      '<td class="num mono">' + (group.connCount ? group.connCount : '·') + '</td>' +
      '<td class="num mono count-cell">' + group.count + '</td>' +
      '<td></td>' +
      '<td class="actions-col"></td>' +
      '</tr>' +
      (collapsed ? '' : group.members.map((proc) => procRowHtml(proc, true)).join(''))
    );
  }

  function renderProcesses() {
    const rows = processRows();
    let groups = processGroups(rows, state.sort.processes);
    if (state.unknownOnly) groups = groups.filter(isUnknownGroup);

    $('procsEmpty').classList.toggle('hidden', groups.length > 0);
    $('procsBody').innerHTML = groups.map((group) => groupRowHtml(group)).join('');

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

  function recountUnread() {
    state.unreadAlerts = state.alerts.reduce((count, alert) => count + (alert.read ? 0 : 1), 0);
  }

  function recordAlert(kind, title, body) {
    const alert = {
      ts: Date.now(),
      kind,
      title,
      body,
      // An alert that lands while the Alerts tab is on screen is already read.
      read: state.tab === 'alerts' && document.visibilityState === 'visible',
    };
    state.alerts.unshift(alert);
    if (state.alerts.length > ALERT_LIMIT) state.alerts.length = ALERT_LIMIT;
    recountUnread();
    savePrefs();
    renderAlerts();
    renderStats();
    updateTray();
  }

  function markAlertsRead() {
    let changed = false;
    for (const alert of state.alerts) {
      if (alert.read) continue;
      alert.read = true;
      changed = true;
    }
    if (!changed) return;
    recountUnread();
    savePrefs();
    renderAlerts();
    renderStats();
    updateTray();
  }

  function renderAlerts() {
    const list = $('alertsList');
    const alerts = state.alerts.slice(0, ALERT_LIMIT);
    $('alertsEmpty').classList.toggle('hidden', alerts.length > 0);
    const unread = state.unreadAlerts ? ' · ' + state.unreadAlerts + ' new' : '';
    $('alertsSummary').textContent = alerts.length
      ? alerts.length + ' alert' + (alerts.length === 1 ? '' : 's') + unread
      : 'Group and pinned-port alerts show up here.';

    list.innerHTML = alerts
      .map(
        (alert) =>
          '<li class="alert-item">' +
          '<span class="ts">' + fmtClock(alert.ts) + '</span>' +
          '<span class="badge alert">' + escapeHtml(alert.kind) + '</span>' +
          '<span class="alert-text">' +
          '<span class="alert-title">' + escapeHtml(alert.title) + '</span>' +
          '<span class="alert-body">' + escapeHtml(alert.body) + '</span>' +
          '</span>' +
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
    const icon = state.unreadAlerts > 0 ? '/resources/icons/trayIconAlert.png' : '/resources/icons/trayIcon.png';
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
      ...(isWindows() ? [{ id: 'autostart', text: 'Start with Windows', isChecked: state.autostart }] : []),
      { text: '-' },
      { id: 'quit', text: 'Quit Doremon' },
    ];

    const signature = JSON.stringify({ icon, menu });
    if (signature === state.traySignature) return;
    try {
      await Neutralino.os.setTray({ icon, menuItems: menu });
      state.traySignature = signature;
    } catch (error) {
      Neutralino.debug.log('setTray failed: ' + ((error && error.message) || error), 'WARNING');
    }
  }

  /* ------------------------------------------------------------------- ui */

  function setActiveTab(tab) {
    state.tab = tab;
    // Each toolbar control is shown only on the table it affects: the port
    // filters on Ports, the group alert limit and unknown filter on Processes.
    $('groupLimitWrap').classList.toggle('hidden', tab !== 'processes');
    $('unknownWrap').classList.toggle('hidden', tab !== 'processes');
    $('pinOnlyWrap').classList.toggle('hidden', tab !== 'ports');
    $('allSocketsWrap').classList.toggle('hidden', tab !== 'ports');
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === 'panel-' + tab));
    if (tab === 'alerts') markAlertsRead();
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

  async function toggleAutostart() {
    if (state.autostartBusy) return;
    if (typeof NL_RESMODE !== 'undefined' && NL_RESMODE === 'directory') {
      showError('Start with Windows works in the packaged app, not under `neu run`.');
      return;
    }
    state.autostartBusy = true;
    const next = !state.autostart;
    try {
      await AutoStart.set(next);
      state.autostart = next;
      hideError();
      flashStatus(next ? 'Doremon will start with Windows' : 'Doremon will no longer start with Windows');
    } catch (error) {
      showError('Could not change Start with Windows: ' + ((error && error.message) || error));
    } finally {
      state.autostartBusy = false;
      updateTray();
    }
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
        if (typeof prefs.showAllSockets === 'boolean') state.showAllSockets = prefs.showAllSockets;
        if (['ports', 'processes', 'activity', 'alerts'].includes(prefs.tab)) state.tab = prefs.tab;
        if (typeof prefs.pinOnly === 'boolean') state.pinOnly = prefs.pinOnly;
        if (typeof prefs.unknownOnly === 'boolean') state.unknownOnly = prefs.unknownOnly;
        if (Number.isFinite(prefs.groupLimit)) state.groupLimit = Math.max(0, Math.min(9999, Math.round(prefs.groupLimit)));
        if (Array.isArray(prefs.expandedGroups)) {
          state.expandedGroups = new Set(prefs.expandedGroups.filter((name) => typeof name === 'string'));
        }
        if (Array.isArray(prefs.pinned)) {
          state.pinned = new Map();
          for (const item of prefs.pinned) {
            if (!item || typeof item.port !== 'number') continue;
            const proto = String(item.proto || 'tcp').toLowerCase();
            state.pinned.set(pinKey(proto, item.port), { proto, port: item.port, up: null });
          }
        }
        if (Array.isArray(prefs.alerts)) {
          state.alerts = prefs.alerts
            .filter((alert) => alert && Number.isFinite(alert.ts) && typeof alert.title === 'string' && typeof alert.body === 'string')
            .slice(0, ALERT_LIMIT)
            .map((alert) => ({
              ts: alert.ts,
              kind: alert.kind === 'port' ? 'port' : 'group',
              title: alert.title.slice(0, 200),
              body: alert.body.slice(0, 500),
              read: Boolean(alert.read),
            }));
          recountUnread();
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
          showAllSockets: state.showAllSockets,
          tab: state.tab,
          pinOnly: state.pinOnly,
          unknownOnly: state.unknownOnly,
          expandedGroups: Array.from(state.expandedGroups),
          groupLimit: state.groupLimit,
          alerts: state.alerts.slice(0, ALERT_LIMIT).map((alert) => ({
            ts: alert.ts,
            kind: alert.kind,
            title: alert.title,
            body: alert.body,
            read: alert.read,
          })),
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

    $('groupLimit').addEventListener('change', (event) => {
      const parsed = Number(event.target.value);
      const value = Number.isFinite(parsed) ? Math.max(0, Math.min(9999, Math.round(parsed))) : state.groupLimit;
      state.groupLimit = value;
      event.target.value = String(value);
      savePrefs();
      // A lowered limit can flag groups that are already running.
      checkGroupLimits(processGroups(state.processes, state.sort.processes));
      renderProcesses();
    });

    $('unknownOnly').addEventListener('change', (event) => {
      state.unknownOnly = event.target.checked;
      savePrefs();
      renderProcesses();
    });

    $('clearEvents').addEventListener('click', () => {
      state.events = [];
      state.eventCount = 0;
      renderStats();
      renderActivity();
    });

    $('clearAlerts').addEventListener('click', () => {
      state.alerts = [];
      state.unreadAlerts = 0;
      savePrefs();
      renderAlerts();
      renderStats();
      updateTray();
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
      const groupRow = event.target.closest('tr[data-group]');
      if (groupRow) {
        const key = groupRow.dataset.group;
        if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
        else state.expandedGroups.add(key);
        savePrefs();
        renderProcesses();
        return;
      }
      const row = event.target.closest('tr');
      if (!row || !row.dataset.pid) return;
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
      } else if (id === 'autostart') {
        toggleAutostart();
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
    $('unknownOnly').checked = state.unknownOnly;
    $('groupLimit').value = String(state.groupLimit);
    setActiveTab(state.tab);
    renderAlerts();
    renderStats();

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

    // The registry is the source of truth for the tray tick.
    AutoStart.status()
      .then((enabled) => {
        state.autostart = enabled;
        updateTray();
      })
      .catch(() => {});

    Scanner.start(state.interval);
    setInterval(tick, 1000);
    await showBuildLabel();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
