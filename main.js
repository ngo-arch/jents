const { app, BrowserWindow, ipcMain, Notification, shell, dialog, nativeImage } = require('electron');
const { execSync, execFile } = require('child_process');
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

// Run tracking
const activeRuns = new Map(); // agentId -> { id, agentId, startedAt, trigger, logPath }

const USER_DATA_DIR = path.join(os.homedir(), process.env.JENTS_DATA_DIR || 'agent-desk');

// --- Workspaces ---

let workspacesCache = null;

function getWorkspacesConfig() {
  if (workspacesCache) return workspacesCache;
  const wsPath = path.join(USER_DATA_DIR, 'workspaces.json');
  if (fs.existsSync(wsPath)) {
    try {
      workspacesCache = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
      return workspacesCache;
    } catch {}
  }
  // Auto-migrate: create workspaces.json from existing team.json
  const defaultWs = {
    activeWorkspaceId: 'default',
    workspaces: [{ id: 'default', name: 'Default', color: '#5b8def', configFile: 'team.json', lastSelectedAgentId: null, order: 0 }],
  };
  ensureDir(USER_DATA_DIR);
  fs.writeFileSync(wsPath, JSON.stringify(defaultWs, null, 2));
  workspacesCache = defaultWs;
  return defaultWs;
}

function saveWorkspacesConfig(data) {
  ensureDir(USER_DATA_DIR);
  fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify(data, null, 2));
  workspacesCache = data;
}

function getActiveConfigPath() {
  const wConfig = getWorkspacesConfig();
  const ws = wConfig.workspaces.find(w => w.id === wConfig.activeWorkspaceId);
  return path.join(USER_DATA_DIR, ws ? ws.configFile : 'team.json');
}

function getConfig(workspaceId) {
  const wConfig = getWorkspacesConfig();
  const wsId = workspaceId || wConfig.activeWorkspaceId || 'default';
  const ws = wConfig.workspaces.find(w => w.id === wsId);
  const filename = ws ? ws.configFile : 'team.json';
  const configPath = path.join(USER_DATA_DIR, filename);
  // Fall back to bundled team.json for default workspace
  const bundlePath = path.join(__dirname, 'team.json');
  const finalPath = fs.existsSync(configPath) ? configPath : (wsId === 'default' && fs.existsSync(bundlePath) ? bundlePath : null);
  if (!finalPath) return { agents: [] };
  try {
    return JSON.parse(fs.readFileSync(finalPath, 'utf-8'));
  } catch {
    return { agents: [] };
  }
}

function findAgentAcrossWorkspaces(agentId) {
  const wConfig = getWorkspacesConfig();
  for (const ws of wConfig.workspaces) {
    const wsConfig = getConfig(ws.id);
    const agent = wsConfig.agents.find(a => a.id === agentId);
    if (agent) return agent;
  }
  return null;
}

function findWorkspaceForAgent(agentId) {
  const wConfig = getWorkspacesConfig();
  for (const ws of wConfig.workspaces) {
    const wsConfig = getConfig(ws.id);
    if (wsConfig.agents.some(a => a.id === agentId)) return ws.id;
  }
  return wConfig.activeWorkspaceId;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLogsDir(agentId) {
  return ensureDir(path.join(USER_DATA_DIR, 'logs', agentId));
}

// --- Data Helpers (todos, inbox, runs) ---

function loadJsonFile(filename, defaultValue) {
  const filePath = path.join(USER_DATA_DIR, filename);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return defaultValue; }
}

function saveJsonFile(filename, data) {
  ensureDir(USER_DATA_DIR);
  fs.writeFileSync(path.join(USER_DATA_DIR, filename), JSON.stringify(data, null, 2));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// --- Runs ---

function loadRuns() { return loadJsonFile('runs.json', []); }
function saveRuns(runs) { saveJsonFile('runs.json', runs); }

function createRunRecord(agentId, trigger, logPath) {
  const run = {
    id: generateId(),
    agentId,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    trigger,
    logPath,
    durationSec: null,
    summary: null,
  };
  activeRuns.set(agentId, run);
  return run;
}

function extractSummary(agentId) {
  const buffer = sessionBuffers.get(agentId) || '';
  if (!buffer) return null;
  // Get last 3KB, strip ANSI codes
  const tail = buffer.slice(-3000).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  const lines = tail.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return null;

  // Look for explicit summary markers
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(summary|result|done|completed|finished)/i.test(lines[i])) {
      const summaryLines = lines.slice(i, i + 3).join(' ');
      return summaryLines.slice(0, 200);
    }
  }
  // Fallback: last meaningful non-prompt line
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.length > 10 && !/^\$|^>|^%|Session ended|exit code/i.test(l)) {
      return l.slice(0, 200);
    }
  }
  return null;
}

function finalizeRun(agentId, exitCode) {
  const run = activeRuns.get(agentId);
  if (!run) return null;
  run.endedAt = Date.now();
  run.exitCode = exitCode;
  run.durationSec = Math.round((run.endedAt - run.startedAt) / 1000);
  run.summary = extractSummary(agentId);
  activeRuns.delete(agentId);

  // Persist - keep last 200 runs
  const runs = loadRuns();
  runs.unshift(run);
  if (runs.length > 200) runs.length = 200;
  saveRuns(runs);

  return run;
}

// --- Inbox ---

function loadInbox() {
  const items = loadJsonFile('inbox.json', []);
  // Auto-expire items older than 48h
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const filtered = items.filter(i => i.timestamp > cutoff);
  if (filtered.length !== items.length) saveJsonFile('inbox.json', filtered);
  return filtered;
}

function addInboxItem(item) {
  const inbox = loadInbox();
  inbox.unshift(item);
  if (inbox.length > 100) inbox.length = 100;
  saveJsonFile('inbox.json', inbox);
  mainWindow?.webContents.send('inbox:new', item);
}

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, 'window-state.json'), 'utf-8'));
  } catch { return {}; }
}

let windowStateTimeout = null;
function saveWindowState() {
  clearTimeout(windowStateTimeout);
  windowStateTimeout = setTimeout(() => {
    if (!mainWindow) return;
    ensureDir(USER_DATA_DIR);
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(path.join(USER_DATA_DIR, 'window-state.json'), JSON.stringify(bounds));
  }, 500);
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

  // macOS: hide on close (red X), keep sessions alive. Cmd+Q triggers actual quit.
  if (process.platform === 'darwin') {
    mainWindow.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Notifications ---

let notificationsMuted = false;
const activeNotifications = new Map(); // agentId -> Notification
const MAX_NOTIFICATIONS = 4;

function sendNotification(agentId, title, body) {
  if (notificationsMuted) return;
  if (!Notification.isSupported()) return;

  // Close previous notification for this agent
  const prev = activeNotifications.get(agentId);
  if (prev) {
    prev.close();
    activeNotifications.delete(agentId);
  }

  // If at max capacity, close the oldest notification
  if (activeNotifications.size >= MAX_NOTIFICATIONS) {
    const oldestKey = activeNotifications.keys().next().value;
    const oldest = activeNotifications.get(oldestKey);
    if (oldest) oldest.close();
    activeNotifications.delete(oldestKey);
    mainWindow?.webContents.send('agent:notification', oldestKey, false);
  }

  const n = new Notification({ title, body, silent: false });
  activeNotifications.set(agentId, n);
  mainWindow?.webContents.send('agent:notification', agentId, true);

  n.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
    const wsId = findWorkspaceForAgent(agentId);
    mainWindow?.webContents.send('agent:focus', agentId, wsId);
    n.close();
  });

  n.on('close', () => {
    if (activeNotifications.get(agentId) === n) {
      activeNotifications.delete(agentId);
      mainWindow?.webContents.send('agent:notification', agentId, false);
    }
  });

  n.show();
}

function resetIdleTimer(agentId, agent) {
  clearTimeout(idleTimers.get(agentId));

  idleTimers.set(agentId, setTimeout(() => {
    const totalBytes = outputSinceIdle.get(agentId) || 0;
    // Only notify if there was substantial output (agent did real work)
    if (totalBytes > 300) {
      if (!mainWindow?.isFocused()) {
        sendNotification(agentId, agent.shortName, 'Ready for input');
      }
      // Inbox item for idle
      addInboxItem({
        id: generateId(),
        type: 'idle',
        agentId,
        title: `${agent.shortName} - Ready for input`,
        detail: `Produced ${Math.round(totalBytes / 1024)}KB of output`,
        summary: null,
        timestamp: Date.now(),
        read: false,
        runId: null,
      });
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
  const agent = findAgentAcrossWorkspaces(agentId);
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

  // Create run record
  const trigger = opts.resume ? 'resume' : 'manual';
  createRunRecord(agentId, trigger, logPath);

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
    // Guard: if killAgent already cleaned up, skip redundant work
    // but still send the exit event to the renderer
    const run = finalizeRun(agentId, exitCode);

    const logInfo = logStreams.get(agentId);
    if (logInfo) {
      logInfo.stream.end();
      logStreams.delete(agentId);
    }
    sessions.delete(agentId);
    clearTimeout(idleTimers.get(agentId));
    idleTimers.delete(agentId);
    outputSinceIdle.delete(agentId);
    mainWindow?.webContents.send('agent:exit', agentId, exitCode);

    // Desktop notification on exit
    const label = exitCode === 0 ? 'Session ended normally' : `Exited with code ${exitCode}`;
    sendNotification(agentId, `${agent.shortName} — Stopped`, label);

    // Inbox item on exit
    const duration = run ? formatDuration(run.durationSec) : '';
    addInboxItem({
      id: generateId(),
      type: 'exit',
      agentId,
      title: `${agent.shortName} - Stopped`,
      detail: exitCode === 0
        ? `Completed${duration ? ' in ' + duration : ''}`
        : `Exited with code ${exitCode}${duration ? ' after ' + duration : ''}`,
      summary: run?.summary || null,
      timestamp: Date.now(),
      read: false,
      runId: run?.id || null,
    });
  });

  return { pid: ptyProcess.pid };
}

function killAgent(agentId) {
  const session = sessions.get(agentId);
  if (session) {
    // Remove from map first so the async onExit handler doesn't
    // accidentally clean up a re-spawned session with the same id
    sessions.delete(agentId);
    session.kill();
  }
  // Eagerly clean up log streams and timers to avoid double-end
  const logInfo = logStreams.get(agentId);
  if (logInfo) {
    logInfo.stream.end();
    logStreams.delete(agentId);
  }
  clearTimeout(idleTimers.get(agentId));
  idleTimers.delete(agentId);
  outputSinceIdle.delete(agentId);
  // Finalize any active run since the onExit handler
  // won't fire reliably after manual kill
  finalizeRun(agentId, null);
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
  fs.writeFileSync(getActiveConfigPath(), JSON.stringify(newConfig, null, 2));
  return true;
});

// Atomic config mutations - read-modify-write on main thread
ipcMain.handle('config:set-agent-field', (_, agentId, field, value) => {
  const config = getConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) return null;
  agent[field] = value;
  ensureDir(USER_DATA_DIR);
  fs.writeFileSync(getActiveConfigPath(), JSON.stringify(config, null, 2));
  return config;
});

ipcMain.handle('config:add-agent', (_, newAgent) => {
  const config = getConfig();
  config.agents.push(newAgent);
  ensureDir(USER_DATA_DIR);
  fs.writeFileSync(getActiveConfigPath(), JSON.stringify(config, null, 2));
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
  fs.writeFileSync(getActiveConfigPath(), JSON.stringify(config, null, 2));
  return config;
});

ipcMain.handle('config:reorder-agents', (_, fromId, toId) => {
  const config = getConfig();
  const fromIdx = config.agents.findIndex(a => a.id === fromId);
  const toIdx = config.agents.findIndex(a => a.id === toId);
  if (fromIdx < 0 || toIdx < 0) return config;
  const [moved] = config.agents.splice(fromIdx, 1);
  config.agents.splice(toIdx, 0, moved);
  ensureDir(USER_DATA_DIR);
  fs.writeFileSync(getActiveConfigPath(), JSON.stringify(config, null, 2));
  return config;
});

ipcMain.handle('config:update-agent', (_, agentId, updates) => {
  const config = getConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) return null;
  for (const [key, value] of Object.entries(updates)) {
    agent[key] = value;
  }
  ensureDir(USER_DATA_DIR);
  fs.writeFileSync(getActiveConfigPath(), JSON.stringify(config, null, 2));
  return config;
});

// --- Workspace IPC Handlers ---

ipcMain.handle('workspaces:get', () => getWorkspacesConfig());

ipcMain.handle('workspaces:set-active', (_, workspaceId) => {
  const wConfig = getWorkspacesConfig();
  wConfig.activeWorkspaceId = workspaceId;
  saveWorkspacesConfig(wConfig);
  return getConfig(workspaceId);
});

ipcMain.handle('workspaces:create', (_, { name, color }) => {
  const wConfig = getWorkspacesConfig();
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
            || 'workspace-' + Date.now().toString(36);
  let uniqueId = id;
  let counter = 2;
  while (wConfig.workspaces.some(w => w.id === uniqueId)) {
    uniqueId = `${id}-${counter++}`;
  }
  const configFile = `team-${uniqueId}.json`;
  ensureDir(USER_DATA_DIR);
  fs.writeFileSync(path.join(USER_DATA_DIR, configFile), JSON.stringify({ agents: [] }, null, 2));
  const newWs = {
    id: uniqueId, name, color, configFile,
    lastSelectedAgentId: null,
    order: wConfig.workspaces.length,
  };
  wConfig.workspaces.push(newWs);
  saveWorkspacesConfig(wConfig);
  return wConfig;
});

ipcMain.handle('workspaces:update', (_, workspaceId, updates) => {
  const wConfig = getWorkspacesConfig();
  const ws = wConfig.workspaces.find(w => w.id === workspaceId);
  if (!ws) return null;
  if (updates.name !== undefined) ws.name = updates.name;
  if (updates.color !== undefined) ws.color = updates.color;
  if (updates.icon !== undefined) ws.icon = updates.icon || null;
  if (updates.order !== undefined) ws.order = updates.order;
  if (updates.lastSelectedAgentId !== undefined) ws.lastSelectedAgentId = updates.lastSelectedAgentId;
  saveWorkspacesConfig(wConfig);
  return wConfig;
});

ipcMain.handle('workspaces:delete', (_, workspaceId) => {
  const wConfig = getWorkspacesConfig();
  const ws = wConfig.workspaces.find(w => w.id === workspaceId);
  if (!ws || wConfig.workspaces.length <= 1) return wConfig;
  // Kill all agents in this workspace
  const wsConfig = getConfig(workspaceId);
  for (const agent of wsConfig.agents) {
    killAgent(agent.id);
  }
  // Delete config file
  try { fs.unlinkSync(path.join(USER_DATA_DIR, ws.configFile)); } catch {}
  wConfig.workspaces = wConfig.workspaces.filter(w => w.id !== workspaceId);
  if (wConfig.activeWorkspaceId === workspaceId) {
    wConfig.activeWorkspaceId = wConfig.workspaces[0]?.id || 'default';
  }
  saveWorkspacesConfig(wConfig);
  return wConfig;
});

ipcMain.handle('workspaces:check-agent-id', (_, agentId) => {
  const wConfig = getWorkspacesConfig();
  for (const ws of wConfig.workspaces) {
    const wsConfig = getConfig(ws.id);
    if (wsConfig.agents.some(a => a.id === agentId)) {
      return { exists: true, workspaceName: ws.name };
    }
  }
  return { exists: false };
});

ipcMain.handle('files:recent', () => getRecentFiles());

ipcMain.handle('files:open', (_, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle('files:read', (_, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 1024 * 1024) return { error: 'File too large (>1MB)' };
    return { content: fs.readFileSync(filePath, 'utf-8'), name: path.basename(filePath) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('files:write', (_, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('files:reveal', (_, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('files:resolve-path', (_, agentId, filePath) => {
  // Absolute path
  if (filePath.startsWith('/')) {
    return fs.existsSync(filePath) ? filePath : null;
  }
  // Home-relative path
  if (filePath.startsWith('~/')) {
    const resolved = path.join(os.homedir(), filePath.slice(2));
    return fs.existsSync(resolved) ? resolved : null;
  }
  // Relative path - resolve against agent's cwd
  const agent = findAgentAcrossWorkspaces(agentId);
  if (!agent || !agent.cwd) return null;
  const cwd = agent.cwd.replace(/^~/, os.homedir());
  const resolved = path.join(cwd, filePath);
  return fs.existsSync(resolved) ? resolved : null;
});

ipcMain.handle('shell:open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('notifications:get-muted', () => notificationsMuted);
ipcMain.handle('notifications:set-muted', (_, muted) => { notificationsMuted = muted; return muted; });

ipcMain.handle('bugs:save', (_, bug) => {
  ensureDir(USER_DATA_DIR);
  const bugsPath = path.join(USER_DATA_DIR, 'bugs.json');
  let bugs = [];
  try { bugs = JSON.parse(fs.readFileSync(bugsPath, 'utf-8')); } catch {}
  bugs.push(bug);
  fs.writeFileSync(bugsPath, JSON.stringify(bugs, null, 2));
  return true;
});

ipcMain.handle('notes:load', () => {
  ensureDir(USER_DATA_DIR);
  const notesPath = path.join(USER_DATA_DIR, 'notes.json');
  try { return JSON.parse(fs.readFileSync(notesPath, 'utf-8')); }
  catch { return []; }
});

ipcMain.handle('notes:save', (_, notes) => {
  ensureDir(USER_DATA_DIR);
  const notesPath = path.join(USER_DATA_DIR, 'notes.json');
  fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2));
  return true;
});

ipcMain.handle('mcp:read', (_, agentId) => {
  const agent = findAgentAcrossWorkspaces(agentId);
  if (!agent || !agent.cwd) return null;
  const mcpPath = path.join(agent.cwd.replace(/^~/, os.homedir()), '.mcp.json');
  try { return JSON.parse(fs.readFileSync(mcpPath, 'utf-8')); }
  catch { return null; }
});

ipcMain.handle('mcp:write', (_, agentId, mcpConfig) => {
  const agent = findAgentAcrossWorkspaces(agentId);
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

ipcMain.handle('agent:clone-github', async (_, url) => {
  // Parse GitHub URL to extract owner/repo (and optional subpath)
  // Supports: https://github.com/user/repo, https://github.com/user/repo/tree/branch/path
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/tree\/([^\/]+)(?:\/(.+))?)?$/);
  if (!match) return { error: 'Invalid GitHub URL. Expected: https://github.com/owner/repo' };

  const [, owner, repo, branch, subpath] = match;
  const agentName = subpath ? path.basename(subpath) : repo;
  const targetDir = path.join(os.homedir(), 'agents', agentName);

  // Don't overwrite existing directory
  if (fs.existsSync(targetDir)) {
    return { error: `Directory already exists: ~/agents/${agentName}` };
  }

  const env = getShellEnvironment();
  const gitPath = resolveCommand('git');

  try {
    // Clone the repo (shallow)
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(`https://github.com/${owner}/${repo}.git`);

    if (subpath) {
      // Clone to temp dir first, then move the subpath
      const tmpDir = path.join(os.tmpdir(), `jents-clone-${Date.now()}`);
      cloneArgs.push(tmpDir);
      execSync(`"${gitPath}" ${cloneArgs.map(a => `"${a}"`).join(' ')}`, {
        env, timeout: 30000, stdio: 'pipe',
      });
      const srcDir = path.join(tmpDir, subpath);
      if (!fs.existsSync(srcDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { error: `Path not found in repo: ${subpath}` };
      }
      fs.cpSync(srcDir, targetDir, { recursive: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else {
      cloneArgs.push(targetDir);
      execSync(`"${gitPath}" ${cloneArgs.map(a => `"${a}"`).join(' ')}`, {
        env, timeout: 30000, stdio: 'pipe',
      });
    }

    // Detect CLAUDE.md
    const hasClaude = fs.existsSync(path.join(targetDir, 'CLAUDE.md'));
    // Detect team.json (might define multiple agents)
    const hasTeamJson = fs.existsSync(path.join(targetDir, 'team.json'));

    return {
      name: agentName,
      cwd: `~/agents/${agentName}`,
      hasClaude,
      hasTeamJson,
    };
  } catch (err) {
    // Clean up on failure
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    return { error: `Clone failed: ${msg}` };
  }
});

ipcMain.handle('agent:open-cwd', (_, agentId) => {
  const agent = findAgentAcrossWorkspaces(agentId);
  if (agent && agent.cwd) {
    const resolved = agent.cwd.replace(/^~/, os.homedir());
    shell.openPath(resolved);
  }
});

// --- iOS Simulator ---

const SIM_SCREENSHOT_PATH = path.join(os.tmpdir(), 'jents-sim-frame.png');

ipcMain.handle('simulator:list-devices', () => {
  try {
    const out = execSync('xcrun simctl list devices --json', { encoding: 'utf-8', timeout: 5000 });
    const data = JSON.parse(out);
    const devices = [];
    for (const [runtime, devs] of Object.entries(data.devices)) {
      for (const d of devs) {
        if (d.isAvailable) {
          devices.push({ udid: d.udid, name: d.name, state: d.state, runtime });
        }
      }
    }
    return devices;
  } catch {
    return [];
  }
});

ipcMain.handle('simulator:boot', async (_, udid) => {
  try {
    execSync(`xcrun simctl boot "${udid}"`, { timeout: 15000, stdio: 'pipe' });
    execSync('open -a Simulator', { timeout: 5000, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('simulator:shutdown', async (_, udid) => {
  try {
    execSync(`xcrun simctl shutdown "${udid}"`, { timeout: 10000, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Async screenshot: capture to temp file, resize with nativeImage, return JPEG data URI
ipcMain.handle('simulator:screenshot', (_, udid) => {
  const target = udid || 'booted';
  return new Promise((resolve) => {
    execFile('xcrun', ['simctl', 'io', target, 'screenshot', '--type=png', SIM_SCREENSHOT_PATH], {
      timeout: 3000,
    }, (err) => {
      if (err) { resolve(null); return; }
      try {
        const buf = fs.readFileSync(SIM_SCREENSHOT_PATH);
        const img = nativeImage.createFromBuffer(buf);
        const size = img.getSize();
        // Resize to 640px wide max - cuts data ~75% vs retina
        const resized = size.width > 640
          ? img.resize({ width: 640, height: Math.round(size.height * (640 / size.width)) })
          : img;
        // JPEG at 80% quality - much smaller than PNG
        const jpeg = resized.toJPEG(80);
        resolve('data:image/jpeg;base64,' + jpeg.toString('base64'));
      } catch {
        resolve(null);
      }
    });
  });
});

// Get Simulator window position/size for click mapping
ipcMain.handle('simulator:window-info', () => {
  try {
    const script = 'tell application "System Events" to tell process "Simulator" to return {position of window 1, size of window 1}';
    const out = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 3000 }).trim();
    const nums = out.split(',').map(s => parseInt(s.trim()));
    return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
  } catch {
    return null;
  }
});

// Click in Simulator at screen coordinates via CGEvents, then refocus Jents
ipcMain.handle('simulator:click', (_, screenX, screenY) => {
  const sx = Math.round(screenX);
  const sy = Math.round(screenY);
  const appName = app.getName();
  const script = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
var ws = $.NSWorkspace.sharedWorkspace;
var apps = ws.runningApplications;
for (var i = 0; i < apps.count; i++) {
  if (apps.objectAtIndex(i).localizedName.js === "Simulator") {
    apps.objectAtIndex(i).activateWithOptions(0);
    break;
  }
}
delay(0.12);
var pt = $.CGPointMake(${sx}, ${sy});
var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, 0);
$.CGEventPost($.kCGHIDEventTap, down);
delay(0.04);
var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, 0);
$.CGEventPost($.kCGHIDEventTap, up);
delay(0.08);
for (var i = 0; i < apps.count; i++) {
  var name = apps.objectAtIndex(i).localizedName.js;
  if (name === "${appName}" || name === "Jents" || name === "Jents Test") {
    apps.objectAtIndex(i).activateWithOptions(0);
    break;
  }
}
`;
  execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 }, () => {});
  return { ok: true };
});

// --- Crons / Scheduled Tasks ---

function isAgentRelatedPlist(plistPath) {
  try {
    const json = execSync(`plutil -convert json -o - "${plistPath}"`, { encoding: 'utf-8', timeout: 3000 });
    const data = JSON.parse(json);
    const label = data.Label || '';
    const args = (data.ProgramArguments || []).join(' ');
    const cwd = data.WorkingDirectory || '';
    const home = os.homedir();

    // Match by known prefixes or paths under ~/agents/
    if (label.startsWith('com.tmt.') || label.startsWith('com.telegram-bridge.')) return data;
    if (args.includes(path.join(home, 'agents'))) return data;
    if (cwd.startsWith(path.join(home, 'agents'))) return data;
    return null;
  } catch {
    return null;
  }
}

function humanLabel(label) {
  // com.tmt.daily-standup -> Daily Standup
  // com.telegram-bridge.tmt-cos -> Telegram: tmt-cos
  if (label.startsWith('com.telegram-bridge.')) {
    return 'Telegram: ' + label.replace('com.telegram-bridge.', '');
  }
  const short = label.replace(/^com\.tmt\./, '');
  return short.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function humanSchedule(data) {
  if (data.KeepAlive) return 'Always running';
  const interval = data.StartCalendarInterval;
  if (!interval) return 'Manual';

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmt = (entry) => {
    const h = entry.Hour != null ? entry.Hour : null;
    const m = entry.Minute != null ? entry.Minute : 0;
    const d = entry.Weekday != null ? days[entry.Weekday] : null;
    const timeStr = h != null ? `${h > 12 ? h - 12 : h || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}` : '';
    if (d && timeStr) return `${d} at ${timeStr}`;
    if (timeStr) return `Daily at ${timeStr}`;
    if (d) return `Every ${d}`;
    return 'Scheduled';
  };

  if (Array.isArray(interval)) {
    return interval.map(fmt).join(', ');
  }
  return fmt(interval);
}

ipcMain.handle('crons:list', () => {
  const launchDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const results = [];

  try {
    const files = fs.readdirSync(launchDir).filter(f => f.endsWith('.plist'));
    // Get all loaded jobs in one call
    let loadedJobs = {};
    try {
      const listOutput = execSync('launchctl list', { encoding: 'utf-8', timeout: 5000 });
      for (const line of listOutput.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const pid = parts[0].trim();
          const exitCode = parts[1].trim();
          const label = parts[2].trim();
          loadedJobs[label] = { pid: pid === '-' ? null : parseInt(pid), exitCode: exitCode === '-' ? null : parseInt(exitCode) };
        }
      }
    } catch {}

    for (const file of files) {
      const fullPath = path.join(launchDir, file);
      const data = isAgentRelatedPlist(fullPath);
      if (!data) continue;

      const label = data.Label;
      const loaded = loadedJobs[label] || null;
      const logPath = data.StandardOutPath || data.StandardErrorPath || null;

      results.push({
        label,
        name: humanLabel(label),
        plistPath: fullPath,
        schedule: humanSchedule(data),
        keepAlive: !!data.KeepAlive,
        command: (data.ProgramArguments || []).join(' '),
        cwd: data.WorkingDirectory || null,
        logPath,
        loaded: !!loaded,
        running: loaded ? loaded.pid != null : false,
        pid: loaded ? loaded.pid : null,
        lastExitCode: loaded ? loaded.exitCode : null,
      });
    }
  } catch {}

  return results;
});

ipcMain.handle('crons:toggle', (_, label, enable) => {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (!fs.existsSync(plistPath)) return { error: 'Plist not found' };

  try {
    const cmd = enable ? 'load' : 'unload';
    execSync(`launchctl ${cmd} "${plistPath}"`, { timeout: 5000, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString().trim() : err.message };
  }
});

ipcMain.handle('crons:logs', (_, logPath) => {
  try {
    if (!fs.existsSync(logPath)) return '';
    const stat = fs.statSync(logPath);
    // Only read last 100KB to avoid huge logs
    const size = Math.min(stat.size, 100 * 1024);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
});

ipcMain.handle('crons:history', () => {
  const historyPath = path.join(os.homedir(), 'agents', 'cron-logs', 'history.log');
  try {
    if (!fs.existsSync(historyPath)) return [];
    const content = fs.readFileSync(historyPath, 'utf-8');
    const lines = content.trim().split('\n').reverse().slice(0, 50);
    return lines.map(line => {
      const parts = line.split(' | ').map(s => s.trim());
      if (parts.length < 5) return null;
      return {
        timestamp: parts[0],
        status: parts[1],
        duration: parts[2],
        agent: parts[3],
        command: parts.slice(4).join(' | '),
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
});

// --- Todos IPC ---

ipcMain.handle('todos:load', () => loadJsonFile('todos.json', { goals: [], todos: [] }));
ipcMain.handle('todos:save', (_, data) => { saveJsonFile('todos.json', data); return true; });

// --- Inbox IPC ---

ipcMain.handle('inbox:load', () => loadInbox());
ipcMain.handle('inbox:save', (_, items) => { saveJsonFile('inbox.json', items); return true; });
ipcMain.handle('inbox:clear', () => { saveJsonFile('inbox.json', []); return true; });

// --- Runs IPC ---

ipcMain.handle('runs:list', (_, agentId) => {
  const runs = loadRuns();
  if (agentId) return runs.filter(r => r.agentId === agentId);
  return runs;
});

ipcMain.handle('runs:get', (_, runId) => {
  const runs = loadRuns();
  return runs.find(r => r.id === runId) || null;
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

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  for (const [id] of sessions) killAgent(id);
  app.quit();
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    createWindow();
  }
});
