const { app, BrowserWindow, ipcMain, Notification, shell, dialog } = require('electron');
const { execSync } = require('child_process');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow = null;
let shellEnv = null;

// Capture the full login shell environment (matches iTerm2)
// Electron apps launched from Dock get a minimal env; this sources ~/.zprofile + ~/.zshrc
function getShellEnvironment() {
  if (shellEnv) return shellEnv;
  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    const output = execSync(`${userShell} -ilc 'env -0' 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const env = {};
    for (const entry of output.split('\0')) {
      const idx = entry.indexOf('=');
      if (idx > 0) {
        env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    }
    // Sanity check: must have HOME and a reasonable PATH
    if (env.HOME && env.PATH && env.PATH.length > 20) {
      shellEnv = env;
      return env;
    }
  } catch {}
  // Fallback: use process.env (minimal but functional)
  shellEnv = process.env;
  return process.env;
}
const sessions = new Map();
const logStreams = new Map();
const sessionBuffers = new Map();

// Idle detection for notifications
const idleTimers = new Map();
const outputSinceIdle = new Map();

const USER_DATA_DIR = path.join(os.homedir(), process.env.JENTS_DATA_DIR || 'agent-desk');

function getConfig() {
  const userPath = path.join(USER_DATA_DIR, 'team.json');
  const bundlePath = path.join(__dirname, 'team.json');
  // Prefer user data dir (persists across repackages), fall back to bundle
  const configPath = fs.existsSync(userPath) ? userPath : (fs.existsSync(bundlePath) ? bundlePath : null);
  if (!configPath) return { agents: [] };
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return { agents: [] };
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLogsDir(agentId) {
  return ensureDir(path.join(USER_DATA_DIR, 'logs', agentId));
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, 'window-state.json'), 'utf-8'));
  } catch { return {}; }
}

function saveWindowState() {
  if (!mainWindow) return;
  ensureDir(USER_DATA_DIR);
  const bounds = mainWindow.getBounds();
  fs.writeFileSync(path.join(USER_DATA_DIR, 'window-state.json'), JSON.stringify(bounds));
}

function createWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 820,
    x: saved.x,
    y: saved.y,
    minWidth: 900,
    minHeight: 500,
    title: '',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0e0918',
    vibrancy: 'under-window',
    icon: path.join(__dirname, 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Notifications ---

function sendNotification(agentId, title, body) {
  if (!Notification.isSupported()) return;

  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.webContents.send('agent:focus', agentId);
  });
  n.show();
}

function resetIdleTimer(agentId, agent) {
  clearTimeout(idleTimers.get(agentId));

  const bytes = outputSinceIdle.get(agentId) || 0;
  outputSinceIdle.set(agentId, bytes);

  idleTimers.set(agentId, setTimeout(() => {
    const totalBytes = outputSinceIdle.get(agentId) || 0;
    // Only notify if there was substantial output (agent did real work)
    if (totalBytes > 300 && !mainWindow?.isFocused()) {
      sendNotification(agentId, agent.shortName, 'Ready for input');
    }
    outputSinceIdle.set(agentId, 0);
  }, 8000));
}

// --- PTY Management ---

// Resolve a command name to its absolute path
// Electron apps launched from Dock have a minimal PATH that misses user-installed CLIs
function resolveCommand(cmd) {
  if (cmd.startsWith('/')) return cmd;
  const dirs = [
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.npm-global/bin'),
    path.join(os.homedir(), '.bun/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    if (fs.existsSync(full)) return full;
  }
  return cmd;
}

function spawnAgent(agentId, opts = {}) {
  const config = getConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) return null;

  killAgent(agentId);

  const cwd = agent.cwd.replace(/^~/, os.homedir());
  ensureDir(cwd);

  // Create log file
  const logsDir = getLogsDir(agentId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `${timestamp}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStreams.set(agentId, { stream: logStream, path: logPath });

  // Build args array
  const cmdParts = agent.command.split(' ');
  const baseCmd = cmdParts[0];
  const args = cmdParts.slice(1);
  if (agent.channels && agent.channels.length > 0) {
    args.push('--channels', ...agent.channels);
  }

  // Apply permission mode
  if (agent.mode && agent.mode !== 'default') {
    args.push('--permission-mode', agent.mode);
  }

  // Resume last session
  if (opts.resume) {
    args.push('--continue');
  }

  // Resolve command to absolute path (safety net in case PATH capture failed)
  const resolvedCmd = resolveCommand(baseCmd);

  // Use the full shell environment (captured at startup, matches iTerm2)
  const baseEnv = getShellEnvironment();

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(resolvedCmd, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: {
        ...baseEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });
  } catch (err) {
    logStream.end();
    logStreams.delete(agentId);
    return { error: `Failed to spawn: ${err.message}` };
  }

  sessions.set(agentId, ptyProcess);
  sessionBuffers.set(agentId, '');
  outputSinceIdle.set(agentId, 0);

  ptyProcess.onData((data) => {
    logStream.write(data);
    let buffer = sessionBuffers.get(agentId) || '';
    buffer += data;
    if (buffer.length > 200000) buffer = buffer.slice(-200000);
    sessionBuffers.set(agentId, buffer);
    mainWindow?.webContents.send('agent:data', agentId, data);

    // Track output for idle detection
    outputSinceIdle.set(agentId, (outputSinceIdle.get(agentId) || 0) + data.length);
    resetIdleTimer(agentId, agent);
  });

  ptyProcess.onExit(({ exitCode }) => {
    logStream.end();
    logStreams.delete(agentId);
    sessions.delete(agentId);
    clearTimeout(idleTimers.get(agentId));
    outputSinceIdle.delete(agentId);
    mainWindow?.webContents.send('agent:exit', agentId, exitCode);

    // Desktop notification on exit
    const label = exitCode === 0 ? 'Session ended normally' : `Exited with code ${exitCode}`;
    sendNotification(agentId, `${agent.shortName} — Stopped`, label);
  });

  return { pid: ptyProcess.pid };
}

function killAgent(agentId) {
  const session = sessions.get(agentId);
  if (session) {
    session.kill();
    sessions.delete(agentId);
  }
  const logInfo = logStreams.get(agentId);
  if (logInfo) {
    logInfo.stream.end();
    logStreams.delete(agentId);
  }
  clearTimeout(idleTimers.get(agentId));
  outputSinceIdle.delete(agentId);
}

// --- Log Management ---

function getLogsList(agentId) {
  const logsDir = getLogsDir(agentId);
  try {
    return fs.readdirSync(logsDir)
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 20)
      .map(f => {
        const filePath = path.join(logsDir, f);
        const stat = fs.statSync(filePath);
        return {
          name: f,
          path: filePath,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      });
  } catch {
    return [];
  }
}

// --- File Manager ---

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.DS_Store', 'venv', '.venv',
  '.mypy_cache', '.pytest_cache', '.next', 'dist', 'build', '.cache',
  'logs', 'cron-logs',
]);

const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.gitignore', 'package-lock.json',
]);

function scanDir(dir, rootDir, agentId, agentName, agentColor, results, depth) {
  if (depth <= 0) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          scanDir(fullPath, rootDir, agentId, agentName, agentColor, results, depth - 1);
        }
      } else {
        if (IGNORE_FILES.has(entry.name)) continue;
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            name: entry.name,
            path: fullPath,
            relativePath: path.relative(rootDir, fullPath),
            agentId,
            agentName,
            agentColor,
            size: stat.size,
            mtime: stat.mtime.getTime(),
          });
        } catch {}
      }
    }
  } catch {}
}

function getRecentFiles() {
  const config = getConfig();
  const allFiles = [];

  for (const agent of config.agents) {
    // Skip agents without a working directory
    if (agent.type === 'ssh' || agent.type === 'webview' || !agent.cwd) continue;

    const cwd = agent.cwd.replace(/^~/, os.homedir());
    try {
      if (fs.existsSync(cwd)) {
        scanDir(cwd, cwd, agent.id, agent.shortName, agent.color, allFiles, 4);
      }
    } catch {}
  }

  // Sort by most recently modified
  allFiles.sort((a, b) => b.mtime - a.mtime);
  return allFiles.slice(0, 60);
}

// --- IPC Handlers ---

ipcMain.handle('get-config', () => getConfig());

ipcMain.handle('agent:spawn', (_, agentId, opts) => spawnAgent(agentId, opts));

ipcMain.handle('agent:kill', (_, agentId) => {
  killAgent(agentId);
  return true;
});

ipcMain.handle('agent:restart', (_, agentId, opts) => spawnAgent(agentId, opts));

ipcMain.handle('agent:write', (_, agentId, data) => {
  const session = sessions.get(agentId);
  if (session) {
    session.write(data);
    return true;
  }
  return false;
});

ipcMain.handle('agent:resize', (_, agentId, cols, rows) => {
  const session = sessions.get(agentId);
  if (session) {
    try { session.resize(cols, rows); } catch {}
    return true;
  }
  return false;
});

ipcMain.handle('agent:get-buffer', (_, agentId) => sessionBuffers.get(agentId) || '');

ipcMain.handle('agent:is-running', (_, agentId) => sessions.has(agentId));

ipcMain.handle('logs:list', (_, agentId) => getLogsList(agentId));

ipcMain.handle('logs:read', (_, logPath) => {
  try { return fs.readFileSync(logPath, 'utf-8'); }
  catch { return ''; }
});

ipcMain.handle('config:save', (_, newConfig) => {
  ensureDir(USER_DATA_DIR);
  const configPath = path.join(USER_DATA_DIR, 'team.json');
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
  return true;
});

// Atomic config mutations - read-modify-write on main thread
ipcMain.handle('config:set-agent-field', (_, agentId, field, value) => {
  const config = getConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) return null;
  agent[field] = value;
  ensureDir(USER_DATA_DIR);
  const configPath = path.join(USER_DATA_DIR, 'team.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return config;
});

ipcMain.handle('config:add-agent', (_, newAgent) => {
  const config = getConfig();
  config.agents.push(newAgent);
  ensureDir(USER_DATA_DIR);
  const configPath = path.join(USER_DATA_DIR, 'team.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  // Auto-create the working directory so it's ready
  if (newAgent.cwd) {
    const cwd = newAgent.cwd.replace(/^~/, os.homedir());
    ensureDir(cwd);
  }
  return config;
});

ipcMain.handle('config:remove-agent', (_, agentId) => {
  const config = getConfig();
  config.agents = config.agents.filter(a => a.id !== agentId);
  const configPath = path.join(USER_DATA_DIR, 'team.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return config;
});

ipcMain.handle('files:recent', () => getRecentFiles());

ipcMain.handle('files:open', (_, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle('files:reveal', (_, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('bugs:save', (_, bug) => {
  // Save to user's home agent-desk dir (not __dirname which may be inside .app bundle)
  const bugsDir = path.join(os.homedir(), 'agent-desk');
  ensureDir(bugsDir);
  const bugsPath = path.join(bugsDir, 'bugs.json');
  let bugs = [];
  try { bugs = JSON.parse(fs.readFileSync(bugsPath, 'utf-8')); } catch {}
  bugs.push(bug);
  fs.writeFileSync(bugsPath, JSON.stringify(bugs, null, 2));
  return true;
});

ipcMain.handle('notes:load', () => {
  const notesDir = path.join(os.homedir(), 'agent-desk');
  ensureDir(notesDir);
  const notesPath = path.join(notesDir, 'notes.json');
  try { return JSON.parse(fs.readFileSync(notesPath, 'utf-8')); }
  catch { return []; }
});

ipcMain.handle('notes:save', (_, notes) => {
  const notesDir = path.join(os.homedir(), 'agent-desk');
  ensureDir(notesDir);
  const notesPath = path.join(notesDir, 'notes.json');
  fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2));
  return true;
});

ipcMain.handle('mcp:read', (_, agentId) => {
  const config = getConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent || !agent.cwd) return null;
  const mcpPath = path.join(agent.cwd.replace(/^~/, os.homedir()), '.mcp.json');
  try { return JSON.parse(fs.readFileSync(mcpPath, 'utf-8')); }
  catch { return null; }
});

ipcMain.handle('mcp:write', (_, agentId, mcpConfig) => {
  const config = getConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent || !agent.cwd) return false;
  const mcpPath = path.join(agent.cwd.replace(/^~/, os.homedir()), '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
  return true;
});

ipcMain.handle('dialog:open-folder', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: 'Select Working Directory',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: path.join(os.homedir(), 'agents'),
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('check-command', (_, cmd) => {
  const resolved = resolveCommand(cmd);
  return { found: resolved !== cmd || cmd.startsWith('/'), path: resolved };
});

ipcMain.handle('agent:write-starter-files', (_, cwd, files) => {
  const resolved = cwd.replace(/^~/, os.homedir());
  ensureDir(resolved);
  for (const file of files) {
    const filePath = path.join(resolved, file.name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, file.content);
    }
  }
  return true;
});

ipcMain.handle('agent:open-cwd', (_, agentId) => {
  const config = getConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (agent && agent.cwd) {
    const resolved = agent.cwd.replace(/^~/, os.homedir());
    shell.openPath(resolved);
  }
});

// --- Log Rotation ---

function rotateOldLogs() {
  const logsRoot = path.join(USER_DATA_DIR, 'logs');
  try {
    const agentDirs = fs.readdirSync(logsRoot, { withFileTypes: true });
    for (const dir of agentDirs) {
      if (!dir.isDirectory()) continue;
      const agentLogsDir = path.join(logsRoot, dir.name);
      const files = fs.readdirSync(agentLogsDir)
        .filter(f => f.endsWith('.log'))
        .sort()
        .reverse();
      // Keep 20 most recent, delete the rest
      for (const file of files.slice(20)) {
        try { fs.unlinkSync(path.join(agentLogsDir, file)); } catch {}
      }
    }
  } catch {}
}

// --- App Lifecycle ---

app.whenReady().then(() => {
  // Set dock icon and name on macOS
  if (process.platform === 'darwin') {
    const { nativeImage } = require('electron');
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.icns'));
    app.dock.setIcon(icon);
  }
  app.setName('Jents');
  rotateOldLogs();
  createWindow();
});

app.on('window-all-closed', () => {
  for (const [id] of sessions) killAgent(id);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
