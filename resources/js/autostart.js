// Doremon "Start with Windows" bridge (Windows only).
//
// The Run key cannot be written from the webview, so this follows the same
// pattern as actions.js: fetch the helper script over the app's resource
// server, leave a copy in temp, run it, and read "ON"/"OFF" or "OK"/"ERR:...".

const AutoStart = (() => {
  const SCRIPT = 'native/autostart.ps1';
  let scriptPath = null;

  const platform = () => (typeof NL_OS === 'string' && NL_OS) || 'Windows';

  async function ensureScript() {
    if (scriptPath) return scriptPath;
    const scriptUrl = '/' + SCRIPT;
    const response = await fetch(scriptUrl);
    if (!response.ok) {
      throw new Error('Autostart script unavailable (' + scriptUrl + ' → HTTP ' + response.status + ')');
    }
    const source = await response.text();
    const tempDir = await Neutralino.os.getPath('temp');
    const sep = tempDir.includes('\\') ? '\\' : '/';
    scriptPath = tempDir.replace(/[\\/]+$/, '') + sep + 'doremon-autostart.ps1';
    await Neutralino.filesystem.writeFile(scriptPath, source);
    return scriptPath;
  }

  async function run(args) {
    if (platform() !== 'Windows') throw new Error('Start with Windows is only supported on Windows.');
    const path = await ensureScript();
    const command = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + path + '" ' + args;
    const result = await Neutralino.os.execCommand(command);
    const stdout = String(result.stdOut || '').trim();
    if (result.exitCode !== 0 || stdout.indexOf('ERR:') === 0) {
      const message = stdout.replace(/^ERR:/, '').trim() || String(result.stdErr || '').trim() || 'exit code ' + result.exitCode;
      throw new Error(message);
    }
    return stdout;
  }

  // The registry is the source of truth; a missing key or a non-Windows host
  // simply reports false instead of surfacing a startup error.
  async function status() {
    if (platform() !== 'Windows') return false;
    const stdout = await run('-Action status');
    return stdout.indexOf('ON') !== -1;
  }

  async function set(enabled) {
    if (enabled) {
      const pid = await Neutralino.app.getProcessId();
      await run('-Action enable -ParentPid ' + pid);
    } else {
      await run('-Action disable');
    }
    return enabled;
  }

  return { status, set };
})();
