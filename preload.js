const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig:  () => ipcRenderer.invoke('get-config'),
  saveConfig: (c) => ipcRenderer.invoke('config:save', c),
  setAgentField: (id, field, value) => ipcRenderer.invoke('config:set-agent-field', id, field, value),
  addAgent: (agent) => ipcRenderer.invoke('config:add-agent', agent),
  removeAgentConfig: (id) => ipcRenderer.invoke('config:remove-agent', id),
  reorderAgents: (fromId, toId) => ipcRenderer.invoke('config:reorder-agents', fromId, toId),
  updateAgent: (id, updates) => ipcRenderer.invoke('config:update-agent', id, updates),

  spawn:     (id, opts) => ipcRenderer.invoke('agent:spawn', id, opts),
  kill:      (id) => ipcRenderer.invoke('agent:kill', id),
  restart:   (id, opts) => ipcRenderer.invoke('agent:restart', id, opts),
  write:     (id, data) => ipcRenderer.invoke('agent:write', id, data),
  resize:    (id, cols, rows) => ipcRenderer.invoke('agent:resize', id, cols, rows),
  getBuffer: (id) => ipcRenderer.invoke('agent:get-buffer', id),
  isRunning: (id) => ipcRenderer.invoke('agent:is-running', id),

  getLogs:  (id) => ipcRenderer.invoke('logs:list', id),
  readLog:  (p)  => ipcRenderer.invoke('logs:read', p),

  getRecentFiles: () => ipcRenderer.invoke('files:recent'),
  openFile:       (p) => ipcRenderer.invoke('files:open', p),
  readFile:       (p) => ipcRenderer.invoke('files:read', p),
  writeFile:      (p, c) => ipcRenderer.invoke('files:write', p, c),
  revealFile:     (p) => ipcRenderer.invoke('files:reveal', p),
  resolveFilePath: (id, p) => ipcRenderer.invoke('files:resolve-path', id, p),

  getPathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  browseFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  checkCommand: (cmd) => ipcRenderer.invoke('check-command', cmd),
  writeStarterFiles: (cwd, files) => ipcRenderer.invoke('agent:write-starter-files', cwd, files),
  loadNotes: () => ipcRenderer.invoke('notes:load'),
  saveNotes: (notes) => ipcRenderer.invoke('notes:save', notes),
  readMcp:  (id) => ipcRenderer.invoke('mcp:read', id),
  writeMcp: (id, config) => ipcRenderer.invoke('mcp:write', id, config),
  saveBug: (bug) => ipcRenderer.invoke('bugs:save', bug),
  openAgentCwd: (id) => ipcRenderer.invoke('agent:open-cwd', id),
  cloneGithub: (url) => ipcRenderer.invoke('agent:clone-github', url),
  getMuted: () => ipcRenderer.invoke('notifications:get-muted'),
  setMuted: (muted) => ipcRenderer.invoke('notifications:set-muted', muted),

  // Workspaces
  getWorkspaces:      () => ipcRenderer.invoke('workspaces:get'),
  setActiveWorkspace: (id) => ipcRenderer.invoke('workspaces:set-active', id),
  createWorkspace:    (opts) => ipcRenderer.invoke('workspaces:create', opts),
  updateWorkspace:    (id, updates) => ipcRenderer.invoke('workspaces:update', id, updates),
  deleteWorkspace:    (id) => ipcRenderer.invoke('workspaces:delete', id),
  checkAgentId:       (id) => ipcRenderer.invoke('workspaces:check-agent-id', id),

  listCrons: () => ipcRenderer.invoke('crons:list'),
  toggleCron: (label, enable) => ipcRenderer.invoke('crons:toggle', label, enable),
  cronLogs: (logPath) => ipcRenderer.invoke('crons:logs', logPath),
  cronHistory: () => ipcRenderer.invoke('crons:history'),

  // Todos
  loadTodos: () => ipcRenderer.invoke('todos:load'),
  saveTodos: (data) => ipcRenderer.invoke('todos:save', data),

  // Inbox
  loadInbox: () => ipcRenderer.invoke('inbox:load'),
  saveInbox: (items) => ipcRenderer.invoke('inbox:save', items),
  clearInbox: () => ipcRenderer.invoke('inbox:clear'),

  // Runs
  listRuns: (agentId) => ipcRenderer.invoke('runs:list', agentId),
  getRun: (runId) => ipcRenderer.invoke('runs:get', runId),

  // iOS Simulator
  simListDevices: () => ipcRenderer.invoke('simulator:list-devices'),
  simBoot: (udid) => ipcRenderer.invoke('simulator:boot', udid),
  simShutdown: (udid) => ipcRenderer.invoke('simulator:shutdown', udid),
  simScreenshot: (udid) => ipcRenderer.invoke('simulator:screenshot', udid),
  simTap: (udid, x, y) => ipcRenderer.invoke('simulator:tap', udid, x, y),
  simSwipe: (udid, x1, y1, x2, y2, dur) => ipcRenderer.invoke('simulator:swipe', udid, x1, y1, x2, y2, dur),

  onData:  (cb) => ipcRenderer.on('agent:data', (_, id, data) => cb(id, data)),
  onExit:  (cb) => ipcRenderer.on('agent:exit', (_, id, code) => cb(id, code)),
  onFocus: (cb) => ipcRenderer.on('agent:focus', (_, id, wsId) => cb(id, wsId)),
  onInbox: (cb) => ipcRenderer.on('inbox:new', (_, item) => cb(item)),
  onNotification: (cb) => ipcRenderer.on('agent:notification', (_, id, active) => cb(id, active)),
});
