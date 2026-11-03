// Doremon process actions (kill / suspend / resume).
//
// Actions are rare, so each one runs the platform helper as a short-lived
// command and reads back "OK" or "ERR:<message>".

const ProcActions = (() => {
  const SCRIPTS = {
    Windows: 'native/actions.ps1',
    Darwin: 'native/actions.sh',
    Linux: 'native/actions.sh',
  };

  let scriptPath = null;

  const platform = () => (typeof NL_OS === 'string' && NL_OS) || 'Windows';

  // Resources may be bundled rather than on disk, so fetch the helper over the
  // app's own resource server and leave a copy in temp for the interpreter.
  async function ensureScript() {
    if (scriptPath) return scriptPath;
    const scriptUrl = '/' + (SCRIPTS[platform()] || SCRIPTS.Linux);
    const response = await fetch(scriptUrl);
    if (!response.ok) {
      throw new Error('Action script unavailable (' + scriptUrl + ' → HTTP ' + response.status + ')');
    }
    const source = await response.text();
    const tempDir = await Neutralino.os.getPath('temp');
    const sep = tempDir.includes('\\') ? '\\' : '/';
    const fileName = 'doremon-actions' + (platform() === 'Windows' ? '.ps1' : '.sh');
    scriptPath = tempDir.replace(/[\\/]+$/, '') + sep + fileName;
    await Neutralino.filesystem.writeFile(scriptPath, source);
    return scriptPath;
  }

  async function run(action, pid) {
    const path = await ensureScript();
    const quoted = '"' + path + '"';
    const command =
      platform() === 'Windows'
        ? 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + quoted + ' -Action ' + action + ' -TargetPid ' + pid
        : 'sh ' + quoted + ' ' + action + ' ' + pid;

    const result = await Neutralino.os.execCommand(command);
    const stdout = String(result.stdOut || '').trim();
    if (result.exitCode !== 0 || stdout.indexOf('ERR:') === 0) {
      const message = stdout.replace(/^ERR:/, '').trim() || String(result.stdErr || '').trim() || 'exit code ' + result.exitCode;
      throw new Error(message);
    }
    return true;
  }

  return { run };
})();
