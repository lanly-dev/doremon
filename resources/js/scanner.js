// Doremon scanner bridge.
//
// Neutralino has no process/port enumeration API, so Doremon runs one
// long-lived helper process (PowerShell on Windows, sh elsewhere) that emits a
// snapshot as tab-separated lines every interval. Spawning the helper once
// avoids paying interpreter start-up cost on every refresh.

const Scanner = (() => {
  const SCRIPTS = {
    Windows: 'native/scanner.ps1',
    Darwin: 'native/scanner.sh',
    Linux: 'native/scanner.sh',
  };

  const handlers = {
    snapshot: () => {},
    status: () => {},
    error: () => {},
  };

  let proc = null;
  let buffer = '';
  let partial = null;
  let interval = 2000;
  let restartTimer = null;
  let restartAttempts = 0;
  let stopRequested = false;
  let parentPid = 0;

  const platform = () => (typeof NL_OS === 'string' && NL_OS) || 'Windows';

  function fail(message) {
    handlers.error(message);
  }

  // Neutralino bundles resources, so the script is not necessarily on disk at
  // run time. Fetch it over the app's own resource server, then drop a copy in
  // the temp folder for the interpreter to execute.
  async function materializeScript() {
    const scriptUrl = '/' + (SCRIPTS[platform()] || SCRIPTS.Linux);
    const response = await fetch(scriptUrl);
    if (!response.ok) {
      throw new Error('Scanner script unavailable (' + scriptUrl + ' → HTTP ' + response.status + ')');
    }
    const source = await response.text();
    const tempDir = await Neutralino.os.getPath('temp');
    const sep = tempDir.includes('\\') ? '\\' : '/';
    const fileName = 'doremon-scanner' + (platform() === 'Windows' ? '.ps1' : '.sh');
    const scriptPath = tempDir.replace(/[\\/]+$/, '') + sep + fileName;
    await Neutralino.filesystem.writeFile(scriptPath, source);
    return scriptPath;
  }

  function buildCommand(scriptPath, intervalMs) {
    const quoted = '"' + scriptPath + '"';
    if (platform() === 'Windows') {
      return 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + quoted + ' -Interval ' + intervalMs + ' -Parent ' + parentPid;
    }
    return 'sh ' + quoted + ' ' + intervalMs + ' ' + parentPid;
  }

  // The helper exits on its own if this process disappears (e.g. the app is
  // force-killed), so it can never linger in the background.
  async function resolveParentPid() {
    if (parentPid) return parentPid;
    try {
      parentPid = Number(await Neutralino.app.getProcessId()) || 0;
    } catch (error) {
      parentPid = 0;
    }
    return parentPid;
  }

  function handleLine(line) {
    if (!line) return;
    const tab = line.indexOf('\t');
    const tag = tab === -1 ? line : line.slice(0, tab);

    if (tag === 'BEGIN') {
      const fields = line.split('\t');
      partial = {
        ts: Number(fields[1]) || Date.now(),
        cores: Number(fields[2]) || 1,
        processes: [],
        sockets: [],
      };
      return;
    }

    if (!partial) return;

    if (tag === 'P') {
      const f = line.split('\t');
      partial.processes.push({
        pid: Number(f[1]) || 0,
        name: f[2] || 'unknown',
        cpuSeconds: Number(f[3]) || 0,
        mem: Number(f[4]) || 0,
        threads: Number(f[5]) || 0,
        title: f[6] || '',
      });
      return;
    }

    if (tag === 'L') {
      const f = line.split('\t');
      partial.sockets.push({
        proto: (f[1] || 'tcp').toLowerCase(),
        addr: f[2] || '',
        port: Number(f[3]) || 0,
        state: f[4] || '',
        pid: Number(f[5]) || 0,
      });
      return;
    }

    if (tag === 'END') {
      const snapshot = partial;
      partial = null;
      snapshot.endedAt = Number(line.split('\t')[1]) || Date.now();
      restartAttempts = 0;
      handlers.snapshot(snapshot);
    }
  }

  function consume() {
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      handleLine(line);
    }
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    restartAttempts += 1;
    if (restartAttempts > 4) {
      handlers.status('error');
      fail('Scanner stopped unexpectedly and could not be restarted. Use Retry to start it again.');
      return;
    }
    fail('Scanner exited unexpectedly — restarting (attempt ' + restartAttempts + ' of 4)…');
    restartTimer = setTimeout(() => {
      start(interval);
    }, 1200 * restartAttempts);
  }

  async function start(intervalMs) {
    clearTimeout(restartTimer);
    if (proc) await stop({ silent: true });
    interval = intervalMs || interval;
    stopRequested = false;
    buffer = '';
    partial = null;
    handlers.status('starting');

    try {
      const scriptPath = await materializeScript();
      await resolveParentPid();
      const command = buildCommand(scriptPath, interval);
      proc = await Neutralino.os.spawnProcess(command);
      if (!proc) throw new Error('Could not start the scanner process');
      handlers.status('running', { command, pid: proc.pid });
    } catch (error) {
      proc = null;
      handlers.status('error');
      fail((error && error.message) || String(error));
    }
  }

  async function stop(options) {
    const silent = options && options.silent;
    const running = proc;
    proc = null;
    buffer = '';
    partial = null;
    stopRequested = true;
    clearTimeout(restartTimer);
    if (!silent) handlers.status('paused');
    if (!running) return;
    try {
      await Neutralino.os.updateSpawnedProcess(running.id, 'exit');
    } catch (error) {
      Neutralino.debug.log('Scanner stop failed: ' + ((error && error.message) || error), 'WARNING');
    }
  }

  function init(options) {
    Object.assign(handlers, options || {});

    Neutralino.events.on('spawnedProcess', (event) => {
      const detail = event.detail || {};
      if (!proc || detail.id !== proc.id) return;

      if (detail.action === 'stdOut') {
        buffer += detail.data || '';
        consume();
        return;
      }

      if (detail.action === 'stdErr') {
        const text = String(detail.data || '').trim();
        if (text) Neutralino.debug.log('Scanner stderr: ' + text, 'WARNING');
        return;
      }

      if (detail.action === 'exit') {
        if (stopRequested) return;
        proc = null;
        scheduleRestart();
      }
    });
  }

  return { init, start, stop };
})();
