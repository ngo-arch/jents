import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { marked } from 'marked';

const { api } = window;

// --- State ---
let config = null;
let activeAgentId = null;
let readerOpen = false;
let notes = [];
const terminals = new Map();
const fitAddons = new Map();
const agentStates = new Map();
const hasUnread = new Map();

// --- Theme ---
const termTheme = {
  background:        '#0e0918',
  foreground:        '#e8e8f0',
  cursor:            '#ff6b3d',
  cursorAccent:      '#0e0918',
  selectionBackground: 'rgba(255,107,61,0.20)',
  selectionForeground: '#ffffff',
  black:          '#1b1728',
  red:            '#f87171',
  green:          '#34d399',
  yellow:         '#fbbf24',
  blue:           '#60a5fa',
  magenta:        '#a78bfa',
  cyan:           '#22d3ee',
  white:          '#e8e8f0',
  brightBlack:    '#5a5a78',
  brightRed:      '#fca5a5',
  brightGreen:    '#6ee7b7',
  brightYellow:   '#fde68a',
  brightBlue:     '#93c5fd',
  brightMagenta:  '#c4b5fd',
  brightCyan:     '#67e8f9',
  brightWhite:    '#ffffff',
};

// --- Toast ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('fade-out'); }, 3000);
  setTimeout(() => { toast.remove(); }, 3500);
}

// --- Terminal Config ---
const TERMINAL_OPTS = {
  cursorBlink: true,
  cursorStyle: 'bar',
  cursorWidth: 2,
  fontSize: 13,
  lineHeight: 1.3,
  fontFamily: "'SF Mono', Menlo, Monaco, 'Cascadia Code', monospace",
  fontWeight: '400',
  fontWeightBold: '600',
  theme: termTheme,
  scrollback: 10000,
  allowProposedApi: true,
  macOptionIsMeta: true,
  drawBoldTextInBrightColors: false,
};

// --- Init ---
async function init() {
  config = await api.getConfig();

  for (const agent of config.agents) {
    const running = await api.isRunning(agent.id);
    agentStates.set(agent.id, running ? 'running' : 'stopped');
    hasUnread.set(agent.id, false);
  }

  await loadNotes();
  renderSidebar();
  setupTerminals();
  setupEventListeners();

  if (config.agents.length > 0) {
    selectAgent(config.agents[0].id);
    showMainUI();
  } else {
    showWelcomeScreen();
  }
}

function showWelcomeScreen() {
  document.getElementById('welcome-screen').classList.remove('hidden');
  document.getElementById('toolbar').style.display = 'none';
  document.getElementById('terminal-container').style.display = 'none';
  renderStarterPacks();
}

function showMainUI() {
  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('toolbar').style.display = '';
  document.getElementById('terminal-container').style.display = '';
}

function renderStarterPacks() {
  const container = document.getElementById('starter-packs');
  if (!container) return;
  container.innerHTML = '';
  for (const pack of STARTER_PACKS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'starter-pack-card';
    const dots = pack.agents.map(a => `<span class="pack-dot" style="background:${a.color}"></span>`).join('');
    card.innerHTML = `
      <div class="pack-dots">${dots}</div>
      <div class="pack-info">
        <div class="pack-name">${pack.name}</div>
        <div class="pack-desc">${pack.desc}</div>
        <div class="pack-agents">${pack.agents.map(a => a.name).join(' + ')}</div>
      </div>
    `;
    card.addEventListener('click', () => createStarterPack(pack));
    container.appendChild(card);
  }
}

async function createStarterPack(pack) {
  for (const agentDef of pack.agents) {
    const tmpl = SKILL_TEMPLATES.find(t => t.id === agentDef.template) || SKILL_TEMPLATES[0];
    const id = agentDef.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Skip if agent with this id already exists
    if (config.agents.some(a => a.id === id)) continue;

    const firstWord = agentDef.name.split(/\s+/)[0];
    const shortName = firstWord.length <= 4 ? firstWord.toUpperCase() : firstWord.slice(0, 4).toUpperCase();
    const cwd = `~/agents/${id}`;

    const newAgent = {
      id,
      name: agentDef.name,
      shortName,
      cwd,
      command: 'claude',
      color: agentDef.color,
      channels: [],
    };

    const updated = await api.addAgent(newAgent);
    if (updated) config = updated;

    // Write starter files from template
    if (tmpl && (tmpl.claudeMd || tmpl.runFiles.length > 0)) {
      const files = [];
      if (tmpl.claudeMd) files.push({ name: 'CLAUDE.md', content: tmpl.claudeMd });
      for (const rf of tmpl.runFiles) files.push(rf);
      await api.writeStarterFiles(cwd, files);
    }

    agentStates.set(id, 'stopped');
    hasUnread.set(id, false);
    createTerminalForAgent(newAgent);
  }

  showMainUI();
  renderSidebar();
  if (config.agents.length > 0) selectAgent(config.agents[0].id);
  showToast(`${pack.name} created - ${pack.agents.length} agents ready`, 'success');
}

// --- Sidebar ---
function renderSidebar() {
  const list = document.getElementById('agent-list');
  list.innerHTML = '';

  for (const agent of config.agents) {
    const item = document.createElement('div');
    item.className = 'agent-item';
    item.dataset.agentId = agent.id;
    item.style.setProperty('--agent-color', agent.color);

    const state = agentStates.get(agent.id) || 'stopped';

    // Build channel badges
    const channels = agent.channels || [];
    let badgesHtml = '';
    if (channels.length > 0) {
      const badges = channels.map(ch => {
        const def = AVAILABLE_CHANNELS.find(c => c.plugin === ch);
        return def ? `<span class="channel-badge">${def.id === 'imessage' ? 'iMsg' : def.name}</span>` : '';
      }).join('');
      badgesHtml = `<div class="channel-badges">${badges}</div>`;
    }

    const removeHtml = `<button class="agent-remove-btn" data-remove-id="${agent.id}" title="Remove agent">&times;</button>`;

    item.innerHTML = `
      <div class="agent-avatar" style="background:${agent.color}">${agent.shortName}</div>
      <div class="agent-details">
        <div class="agent-item-name">${agent.shortName}</div>
        <div class="agent-item-role">${agent.name}</div>
        ${badgesHtml}
      </div>
      ${removeHtml}
      <div class="unread-badge" style="background:${agent.color}"></div>
      <div class="status-dot ${state}" data-status="${agent.id}"></div>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.agent-remove-btn')) return;
      selectAgent(agent.id);
    });

    const removeBtn = item.querySelector('.agent-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeAgent(agent.id);
      });
    }

    list.appendChild(item);
  }
}

// --- Terminals ---
function setupTerminals() {
  const container = document.getElementById('terminal-container');

  for (const agent of config.agents) {
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.id = `terminal-${agent.id}`;
    container.appendChild(wrapper);

    initTerminalForAgent(agent, wrapper);
  }
}

function initTerminalForAgent(agent, wrapper) {
  const terminal = new Terminal(TERMINAL_OPTS);
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon((event, uri) => {
    api.openExternal(uri);
  }));

  terminal.open(wrapper);
  fitAddon.fit();

  terminal.onData((data) => {
    if (agentStates.get(agent.id) === 'running') {
      api.write(agent.id, data);
      // Scroll to bottom when user sends input
      terminal.scrollToBottom();
    }
  });

  terminals.set(agent.id, terminal);
  fitAddons.set(agent.id, fitAddon);

  if (agentStates.get(agent.id) !== 'running') {
    terminal.writeln('');
    terminal.writeln('  \x1b[38;2;91;141;239m\u2B24\x1b[0m \x1b[38;2;239;107;107m\u2B24\x1b[0m \x1b[38;2;107;239;160m\u2B24\x1b[0m \x1b[38;2;160;107;239m\u2B24\x1b[0m');
    terminal.writeln('');
    terminal.writeln(`  \x1b[1m${agent.shortName}\x1b[0m \x1b[2m- ${agent.name}\x1b[0m`);
    terminal.writeln('');
    terminal.writeln('  \x1b[2mReady. Press \x1b[0m\x1b[38;2;255;107;61mStart\x1b[0m \x1b[2mor \x1b[0m\x1b[38;2;255;107;61mCmd+R\x1b[0m \x1b[2mto begin.\x1b[0m');
    terminal.writeln('');
    terminal.write('\x1b[?25l'); // Hide cursor when not running
  }
}

// --- Agent Selection ---
function selectAgent(agentId) {
  activeAgentId = agentId;
  const agent = config.agents.find(a => a.id === agentId);

  // Clear unread
  hasUnread.set(agentId, false);
  const sidebarItem = document.querySelector(`.agent-item[data-agent-id="${agentId}"]`);
  if (sidebarItem) sidebarItem.classList.remove('has-unread');

  // Update sidebar active state
  document.querySelectorAll('.agent-item').forEach(item => {
    item.classList.toggle('active', item.dataset.agentId === agentId);
  });

  // Update toolbar
  document.getElementById('agent-name').textContent = agent.name;

  updateStatusUI(agentId);
  updateModeBadge(agentId);

  // Set agent color
  document.documentElement.style.setProperty('--agent-color', agent.color);

  // Show correct terminal
  document.querySelectorAll('.terminal-wrapper').forEach(w => {
    w.classList.toggle('active', w.id === `terminal-${agentId}`);
  });

  // Fit and focus terminal
  requestAnimationFrame(() => {
    const fitAddon = fitAddons.get(agentId);
    if (fitAddon) {
      fitAddon.fit();
      const terminal = terminals.get(agentId);
      if (terminal && agentStates.get(agentId) === 'running') {
        api.resize(agentId, terminal.cols, terminal.rows);
      }
    }
    // Focus terminal so keystrokes go directly to it
    const notepadOpen = !document.getElementById('notepad-panel').classList.contains('hidden');
    if (!notepadOpen) {
      const terminal = terminals.get(agentId);
      if (terminal) terminal.focus();
    }
  });

  // Close logs panel when switching agents
  document.getElementById('logs-panel').classList.add('hidden');

  // Reset armed confirmation states
  stopArmed = false;
  clearArmed = false;
  clearTimeout(stopConfirmTimeout);
  clearTimeout(clearConfirmTimeout);
  document.getElementById('btn-stop').classList.remove('armed');
  document.getElementById('btn-stop').title = 'Stop session';
  document.getElementById('btn-clear').classList.remove('armed');
  document.getElementById('btn-clear').title = 'Clear terminal';
}

function updateStatusUI(agentId) {
  const state = agentStates.get(agentId) || 'stopped';
  const badge = document.getElementById('agent-status');
  const labels = { running: 'Running', stopped: 'Stopped', error: 'Exited' };
  badge.textContent = labels[state] || state;
  badge.className = state;

  const dot = document.querySelector(`.status-dot[data-status="${agentId}"]`);
  if (dot) dot.className = `status-dot ${state}`;

  const isRunning = state === 'running';
  document.getElementById('btn-start').style.display = isRunning ? 'none' : 'flex';
  document.getElementById('btn-resume').style.display = isRunning ? 'none' : 'flex';
  document.getElementById('btn-restart').style.display = isRunning ? 'flex' : 'none';
  document.getElementById('btn-stop').style.display = isRunning ? 'flex' : 'none';
}

// --- Notepad ---
async function loadNotes() {
  try {
    notes = await api.loadNotes();
  } catch (e) {
    console.error('Failed to load notes:', e);
  }
}

function saveNotesToStorage() {
  api.saveNotes(notes);
}

function closeAllPanels() {
  for (const id of ['logs-panel', 'files-panel', 'notepad-panel', 'configure-panel', 'help-panel']) {
    document.getElementById(id).classList.add('hidden');
  }
}

function toggleNotepad() {
  const panel = document.getElementById('notepad-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    if (activeAgentId) {
      const terminal = terminals.get(activeAgentId);
      if (terminal) terminal.focus();
    }
    return;
  }
  closeAllPanels();
  panel.classList.remove('hidden');
  renderNotepadList();
  document.getElementById('notepad-input').focus();
}

function addNote() {
  const input = document.getElementById('notepad-input');
  const text = input.value;
  if (!text.trim()) return;

  notes.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    createdAt: Date.now(),
  });
  saveNotesToStorage();
  input.value = '';
  renderNotepadList();
  input.focus();
}

function sendNote(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !activeAgentId) return;

  const running = agentStates.get(activeAgentId) === 'running';
  const bracketedText = `\x1b[200~${note.text}\x1b[201~\r`;

  if (!running) {
    startAgent(activeAgentId).then(() => {
      setTimeout(() => api.write(activeAgentId, bracketedText), 800);
    });
  } else {
    api.write(activeAgentId, bracketedText);
  }
}

function editNote(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  const item = document.querySelector(`.note-item[data-note-id="${noteId}"]`);
  if (!item) return;

  const pre = item.querySelector('.note-text');
  const textarea = document.createElement('textarea');
  textarea.className = 'note-edit-input';
  textarea.value = note.text;
  textarea.rows = 4;
  pre.replaceWith(textarea);
  textarea.focus();

  // Replace buttons with save/cancel
  const actions = item.querySelector('.note-actions');
  actions.innerHTML = `
    <button class="note-action-btn note-send-btn note-save-edit">Save</button>
    <button class="note-action-btn note-delete-btn note-cancel-edit">Cancel</button>
  `;
  actions.querySelector('.note-save-edit').addEventListener('click', () => {
    note.text = textarea.value;
    saveNotesToStorage();
    renderNotepadList();
  });
  actions.querySelector('.note-cancel-edit').addEventListener('click', () => {
    renderNotepadList();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      note.text = textarea.value;
      saveNotesToStorage();
      renderNotepadList();
    }
  });
}

function deleteNote(noteId) {
  notes = notes.filter(n => n.id !== noteId);
  saveNotesToStorage();
  renderNotepadList();
}

function renderNotepadList() {
  const listEl = document.getElementById('notepad-list');
  listEl.innerHTML = '';

  if (notes.length === 0) {
    listEl.innerHTML = '<div class="notepad-empty">No notes yet</div>';
    return;
  }

  for (const note of notes) {
    const item = document.createElement('div');
    item.className = 'note-item';
    item.dataset.noteId = note.id;

    const timeAgo = formatTimeAgo(note.createdAt);
    const preview = note.text.length > 500 ? note.text.slice(0, 500) + '...' : note.text;

    item.innerHTML = `
      <pre class="note-text">${escapeHtml(preview)}</pre>
      <div class="note-meta">
        <span class="note-time">${timeAgo}</span>
        <div class="note-actions">
          <button class="note-action-btn note-send-btn">Send</button>
          <button class="note-action-btn note-edit-btn">Edit</button>
          <button class="note-action-btn note-delete-btn">Del</button>
        </div>
      </div>
    `;

    item.querySelector('.note-send-btn').addEventListener('click', () => sendNote(note.id));
    item.querySelector('.note-edit-btn').addEventListener('click', () => editNote(note.id));
    item.querySelector('.note-delete-btn').addEventListener('click', () => deleteNote(note.id));

    listEl.appendChild(item);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Permission Modes ---
const PERMISSION_MODES = [
  { id: 'default',           label: 'Default',      desc: 'Manual approval for each action' },
  { id: 'auto',              label: 'Auto',          desc: 'AI classifiers approve safe actions' },
  { id: 'acceptEdits',       label: 'Accept Edits',  desc: 'Auto-accept file edits only' },
  { id: 'plan',              label: 'Plan',          desc: 'Plan only, no execution' },
  { id: 'bypassPermissions', label: 'YOLO',          desc: 'Skip all permission checks' },
];

function getAgentMode(agentId) {
  const agent = config.agents.find(a => a.id === agentId);
  return (agent && agent.mode) || 'default';
}

function updateModeBadge(agentId) {
  const mode = getAgentMode(agentId);
  const def = PERMISSION_MODES.find(m => m.id === mode) || PERMISSION_MODES[0];
  const badge = document.getElementById('mode-badge');
  badge.textContent = def.label;
  badge.className = `mode-${mode}`;
  // YOLO warning bar
  const toolbar = document.getElementById('toolbar');
  toolbar.classList.toggle('yolo-active', mode === 'bypassPermissions');
}

function renderModeMenu() {
  const menu = document.getElementById('mode-menu');
  const currentMode = getAgentMode(activeAgentId);
  menu.innerHTML = '';

  for (const mode of PERMISSION_MODES) {
    const item = document.createElement('button');
    item.className = `mode-menu-item${mode.id === currentMode ? ' active' : ''}`;
    item.innerHTML = `
      <span class="mode-menu-label">${mode.label}</span>
      <span class="mode-menu-desc">${mode.desc}</span>
    `;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      setAgentMode(activeAgentId, mode.id);
      menu.classList.add('hidden');
    });
    menu.appendChild(item);
  }
}

async function setAgentMode(agentId, mode) {
  const updated = await api.setAgentField(agentId, 'mode', mode);
  if (updated) config = updated;
  updateModeBadge(agentId);
  if (mode === 'bypassPermissions') {
    showToast('YOLO mode: all permission checks bypassed', 'warn');
  }
}

// --- Channel Definitions ---
const AVAILABLE_CHANNELS = [
  {
    id: 'imessage',
    name: 'iMessage',
    plugin: 'plugin:imessage@claude-plugins-official',
    icon: '💬',
    desc: 'Receive messages via iMessage (macOS only)',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    plugin: 'plugin:telegram@claude-plugins-official',
    icon: '✈',
    desc: 'Receive messages via Telegram bot',
  },
  {
    id: 'discord',
    name: 'Discord',
    plugin: 'plugin:discord@claude-plugins-official',
    icon: '🎮',
    desc: 'Receive messages via Discord bot',
  },
];

// --- Channels Panel ---
function toggleChannels() {
  const panel = document.getElementById('channels-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  closeAllPanels();
  renderChannelsPanel();
  panel.classList.remove('hidden');
}

function renderChannelsPanel() {
  if (!activeAgentId) return;
  const agent = config.agents.find(a => a.id === activeAgentId);
  if (!agent || agent.type === 'ssh') {
    document.getElementById('channels-list').innerHTML =
      '<div class="files-empty"><p>Channels not available for SSH</p></div>';
    return;
  }

  document.getElementById('channels-agent-label').textContent =
    `Configuring channels for ${agent.shortName}`;

  const listEl = document.getElementById('channels-list');
  listEl.innerHTML = '';

  const agentChannels = agent.channels || [];

  for (const ch of AVAILABLE_CHANNELS) {
    const enabled = agentChannels.includes(ch.plugin);
    const item = document.createElement('div');
    item.className = `channel-item${enabled ? ' enabled' : ''}`;

    item.innerHTML = `
      <div class="channel-icon">${ch.icon}</div>
      <div class="channel-info">
        <div class="channel-name">${ch.name}</div>
        <div class="channel-desc">${ch.desc}</div>
      </div>
      <button class="channel-toggle${enabled ? ' active' : ''}" data-channel="${ch.plugin}"></button>
    `;

    const toggle = item.querySelector('.channel-toggle');
    toggle.addEventListener('click', () => toggleChannel(agent.id, ch.plugin));

    listEl.appendChild(item);
  }
}

async function toggleChannel(agentId, plugin) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) return;

  const oldChannels = agent.channels ? [...agent.channels] : [];
  const channels = [...oldChannels];
  const idx = channels.indexOf(plugin);
  if (idx >= 0) {
    channels.splice(idx, 1);
  } else {
    channels.push(plugin);
  }

  // Update local config immediately so UI reflects the change
  agent.channels = channels;
  renderConfigureChannels();
  renderSidebar();
  selectAgent(activeAgentId);

  // Persist to disk - revert if save fails
  try {
    const updated = await api.setAgentField(agentId, 'channels', channels);
    if (updated) config = updated;
  } catch (err) {
    agent.channels = oldChannels;
    renderConfigureChannels();
    renderSidebar();
    showToast('Failed to save channel change', 'error');
  }
}

// --- Files Panel ---
async function toggleFiles() {
  const panel = document.getElementById('files-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  closeAllPanels();
  await loadFiles();
  panel.classList.remove('hidden');
}

async function loadFiles() {
  const files = await api.getRecentFiles();
  const listEl = document.getElementById('files-list');
  listEl.innerHTML = '';

  if (files.length === 0) {
    listEl.innerHTML = '<div class="files-empty"><p>No files found</p></div>';
    return;
  }

  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'file-item';

    const ext = file.name.split('.').pop() || '?';
    const timeAgo = formatTimeAgo(file.mtime);
    const size = formatSize(file.size);

    item.innerHTML = `
      <div class="file-icon">${ext.slice(0, 3)}</div>
      <div class="file-details">
        <div class="file-name">${file.name}</div>
        <div class="file-path">${file.relativePath}</div>
        <div class="file-meta">
          <span class="file-agent-badge" style="background:${file.agentColor}">${file.agentName}</span>
          <span>${timeAgo}</span>
          <span>${size}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="file-action-btn" data-action="reveal" title="Reveal in Finder">
          <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      </div>
    `;

    // Click to open file
    item.addEventListener('click', (e) => {
      if (e.target.closest('.file-action-btn')) return;
      api.openFile(file.path);
    });

    // Reveal in Finder
    const revealBtn = item.querySelector('[data-action="reveal"]');
    revealBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.revealFile(file.path);
    });

    listEl.appendChild(item);
  }
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- Reader ---
function getTerminalText(agentId) {
  const terminal = terminals.get(agentId);
  if (!terminal) return '';

  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return lines.join('\n');
}

function extractMarkdown(rawText) {
  // Strip ANSI escape codes
  let text = rawText
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\(B/g, '');

  // Process line by line for noise removal
  const lines = text.split('\n');
  const cleaned = [];
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty-ish lines made of only noise chars
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●◐◓◑◒▪▫⬒⬔⬕⬓⏺╺╸─│┌┐└┘├┤┬┴┼╭╮╰╯\s]*$/.test(trimmed) && trimmed.length > 0 && !/\w/.test(trimmed)) continue;

    // Skip box-drawing border lines (─── or ═══ etc)
    if (/^[─═┄┈╌╍━┅┉╺╸├┤┼┬┴┌┐└┘╭╮╰╯│╵╷\s]+$/.test(trimmed)) continue;

    // Skip Claude Code UI: tool call headers/footers, permission prompts
    if (/^(Read|Edit|Write|Bash|Grep|Glob|Agent|Task|WebFetch|WebSearch)\(/.test(trimmed)) continue;
    if (/^(Allow|Deny|Skip)\s/.test(trimmed) && trimmed.length < 40) continue;
    if (/^(Yes|No)\s*\(/.test(trimmed)) continue;

    // Skip progress/status lines
    if (/^(Thinking|Running|Streaming|Connecting)\.\.\.\s*$/.test(trimmed)) continue;

    // Strip leading ⏺ bullets (Claude Code action markers)
    const stripped = line.replace(/^\s*⏺\s*/, '');

    // Strip remaining spinner/noise chars inline
    cleaned.push(stripped.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●◐◓◑◒▪▫⬒⬔⬕⬓]/g, ''));
  }

  text = cleaned.join('\n');

  // Collapse excessive blank lines
  text = text.replace(/\n{4,}/g, '\n\n\n');

  return text.trim();
}

function openReader() {
  if (!activeAgentId) return;

  const rawText = getTerminalText(activeAgentId);
  if (!rawText.trim()) return;

  const markdown = extractMarkdown(rawText);

  // Configure marked
  marked.setOptions({
    breaks: false,
    gfm: true,
  });

  const html = marked.parse(markdown);
  const contentEl = document.getElementById('reader-content');
  contentEl.innerHTML = `<div class="prose">${html}</div>`;

  // Store raw markdown for copy
  contentEl.dataset.rawMarkdown = markdown;

  readerOpen = true;
  document.getElementById('reader').classList.remove('hidden');
}

function closeReader() {
  readerOpen = false;
  document.getElementById('reader').classList.add('hidden');
  // Return focus to terminal
  if (activeAgentId) {
    const terminal = terminals.get(activeAgentId);
    if (terminal) terminal.focus();
  }
}

function toggleReader() {
  if (readerOpen) closeReader();
  else openReader();
}

async function copyReaderContent() {
  const contentEl = document.getElementById('reader-content');
  const markdown = contentEl.dataset.rawMarkdown || '';
  const btn = document.getElementById('btn-reader-copy');

  try {
    await navigator.clipboard.writeText(markdown);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch {
    showToast('Copy failed', 'error');
  }
}

// --- Event Listeners ---
function setupEventListeners() {
  // PTY data
  api.onData((agentId, data) => {
    const terminal = terminals.get(agentId);
    if (terminal) {
      terminal.write(data);
      // Auto-scroll to bottom if user is near the bottom (within 5 rows)
      const buf = terminal.buffer.active;
      const viewportTop = buf.viewportY;
      const totalRows = buf.length;
      const visibleRows = terminal.rows;
      const distFromBottom = totalRows - (viewportTop + visibleRows);
      if (distFromBottom < 5) {
        terminal.scrollToBottom();
      }
    }

    // Only mark unread if this agent is NOT the currently active/visible one
    if (agentId !== activeAgentId) {
      hasUnread.set(agentId, true);
      const item = document.querySelector(`.agent-item[data-agent-id="${agentId}"]`);
      if (item) item.classList.add('has-unread');
    } else {
      // Ensure the active agent never shows an unread badge
      hasUnread.set(agentId, false);
      const item = document.querySelector(`.agent-item[data-agent-id="${agentId}"]`);
      if (item) item.classList.remove('has-unread');
    }
  });

  // PTY exit
  api.onExit((agentId, exitCode) => {
    agentStates.set(agentId, exitCode === 0 ? 'stopped' : 'error');
    if (agentId === activeAgentId) updateStatusUI(agentId);

    const dot = document.querySelector(`.status-dot[data-status="${agentId}"]`);
    if (dot) dot.className = `status-dot ${exitCode === 0 ? 'stopped' : 'error'}`;

    const terminal = terminals.get(agentId);
    if (terminal) {
      terminal.writeln('');
      terminal.writeln(`  \x1b[2mSession ended (exit code: ${exitCode}). Press Start or Cmd+R to restart.\x1b[0m`);
    }
  });

  // Notepad input
  const notepadInput = document.getElementById('notepad-input');
  notepadInput.addEventListener('keydown', (e) => {
    // Cmd+Enter to save note
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      addNote();
      return;
    }
  });

  // Notepad buttons
  document.getElementById('btn-notepad-save').addEventListener('click', addNote);
  document.getElementById('btn-notepad').addEventListener('click', toggleNotepad);
  document.getElementById('btn-close-notepad').addEventListener('click', () => {
    document.getElementById('notepad-panel').classList.add('hidden');
    if (activeAgentId) {
      const terminal = terminals.get(activeAgentId);
      if (terminal) terminal.focus();
    }
  });

  // Mode selector
  document.getElementById('mode-badge').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('mode-menu');
    if (menu.classList.contains('hidden')) {
      renderModeMenu();
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  });

  // Close mode menu on outside click
  document.addEventListener('click', () => {
    document.getElementById('mode-menu').classList.add('hidden');
  });

  // Toolbar buttons
  document.getElementById('btn-start').addEventListener('click', () => startAgent(activeAgentId));
  document.getElementById('btn-resume').addEventListener('click', () => resumeAgent(activeAgentId));
  document.getElementById('btn-restart').addEventListener('click', restartAgent);
  document.getElementById('btn-stop').addEventListener('click', armStop);
  document.getElementById('btn-clear').addEventListener('click', armClear);
  document.getElementById('btn-copy-last').addEventListener('click', copyLastResponse);
  document.getElementById('btn-logs').addEventListener('click', toggleLogs);
  document.getElementById('btn-reader').addEventListener('click', toggleReader);
  document.getElementById('btn-reader-close').addEventListener('click', closeReader);
  document.getElementById('btn-reader-copy').addEventListener('click', copyReaderContent);
  document.getElementById('btn-configure').addEventListener('click', toggleConfigure);
  document.getElementById('btn-close-configure').addEventListener('click', () => {
    document.getElementById('configure-panel').classList.add('hidden');
  });
  document.getElementById('btn-config-guide').addEventListener('click', () => {
    toggleHelp();
  });
  document.getElementById('btn-files').addEventListener('click', toggleFiles);
  document.getElementById('btn-close-files').addEventListener('click', () => {
    document.getElementById('files-panel').classList.add('hidden');
  });
  document.getElementById('btn-files-finder').addEventListener('click', () => {
    if (activeAgentId) api.openAgentCwd(activeAgentId);
  });
  document.getElementById('btn-files-refresh').addEventListener('click', loadFiles);

  // Logs panel
  document.getElementById('btn-close-logs').addEventListener('click', () => {
    document.getElementById('logs-panel').classList.add('hidden');
  });
  document.getElementById('btn-logs-back').addEventListener('click', showLogsList);

  // Notification click -> focus agent
  api.onFocus((agentId) => {
    selectAgent(agentId);
  });

  // Window resize
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (!activeAgentId) return;
      const fitAddon = fitAddons.get(activeAgentId);
      if (fitAddon) {
        fitAddon.fit();
        const terminal = terminals.get(activeAgentId);
        if (terminal) api.resize(activeAgentId, terminal.cols, terminal.rows);
      }
    }, 50);
  });

  // Drag-and-drop file paths into terminal
  const termContainer = document.getElementById('terminal-container');

  termContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    termContainer.classList.add('drag-over');
  });

  termContainer.addEventListener('dragleave', (e) => {
    // Only remove if leaving the container (not entering a child)
    if (!termContainer.contains(e.relatedTarget)) {
      termContainer.classList.remove('drag-over');
    }
  });

  termContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    termContainer.classList.remove('drag-over');

    const files = e.dataTransfer.files;
    if (files.length === 0 || !activeAgentId) return;

    const paths = Array.from(files).map(f => {
      const p = api.getPathForFile(f);
      // Quote paths that contain spaces
      return p.includes(' ') ? `"${p}"` : p;
    });

    const pathStr = paths.join(' ');

    if (agentStates.get(activeAgentId) === 'running') {
      api.write(activeAgentId, pathStr);
    } else {
      // If not running, write to terminal visually and start with the path
      const terminal = terminals.get(activeAgentId);
      if (terminal) terminal.write(pathStr);
    }
  });

  // Also support drop on notepad textarea
  const notepadArea = document.getElementById('notepad-input');
  notepadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  notepadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const paths = Array.from(files).map(f => {
      const p = api.getPathForFile(f);
      return p.includes(' ') ? `"${p}"` : p;
    });

    // Insert at cursor position
    const start = notepadArea.selectionStart;
    const end = notepadArea.selectionEnd;
    const text = notepadArea.value;
    const pathStr = paths.join(' ');
    notepadArea.value = text.slice(0, start) + pathStr + text.slice(end);
    notepadArea.selectionStart = notepadArea.selectionEnd = start + pathStr.length;
    notepadArea.focus();
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Escape closes overlays
    if (e.key === 'Escape') {
      if (readerOpen) { closeReader(); return; }
    }

    if (e.metaKey || e.ctrlKey) {
      // Cmd+1-9 switch agents
      const num = parseInt(e.key);
      if (num >= 1 && num <= config.agents.length) {
        e.preventDefault();
        selectAgent(config.agents[num - 1].id);
        return;
      }

      // Cmd+B toggle sidebar
      if (e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Cmd+E toggle notepad
      if (e.key === 'e') {
        e.preventDefault();
        toggleNotepad();
        return;
      }

      // Cmd+D toggle reader
      if (e.key === 'd') {
        e.preventDefault();
        toggleReader();
        return;
      }

      // Cmd+F toggle files
      if (e.key === 'f') {
        e.preventDefault();
        toggleFiles();
        return;
      }

      // Cmd+R start/restart
      if (e.key === 'r' && !e.shiftKey) {
        e.preventDefault();
        if (agentStates.get(activeAgentId) === 'running') {
          restartAgent();
        } else {
          startAgent(activeAgentId);
        }
        return;
      }
    }
  });
}

// --- Actions ---
async function startAgent(agentId, opts = {}) {
  if (!agentId) return;

  // Check if command exists before spawning
  const agent = config.agents.find(a => a.id === agentId);
  if (agent) {
    const cmd = agent.command.split(' ')[0];
    const check = await api.checkCommand(cmd);
    if (!check.found) {
      const terminal = terminals.get(agentId);
      if (terminal) {
        terminal.writeln('');
        terminal.writeln(`  \x1b[31mCommand not found: ${cmd}\x1b[0m`);
        terminal.writeln(`  \x1b[2mMake sure "${cmd}" is installed and available on your PATH.\x1b[0m`);
        if (cmd === 'claude') {
          terminal.writeln(`  \x1b[2mInstall: npm install -g @anthropic-ai/claude-code\x1b[0m`);
        }
        terminal.writeln('');
      }
      showToast(`Command not found: ${cmd}`, 'error');
      return;
    }
  }

  const terminal = terminals.get(agentId);
  if (terminal) terminal.clear();

  const result = await api.spawn(agentId, opts);
  if (result && result.error) {
    const terminal = terminals.get(agentId);
    if (terminal) {
      terminal.writeln(`\r\n  \x1b[31m${result.error}\x1b[0m\r\n`);
    }
    showToast(result.error, 'error');
    return;
  }
  if (result) {
    // Show cursor now that agent is running
    if (terminal) terminal.write('\x1b[?25h');
    agentStates.set(agentId, 'running');
    if (agentId === activeAgentId) updateStatusUI(agentId);

    const dot = document.querySelector(`.status-dot[data-status="${agentId}"]`);
    if (dot) dot.className = 'status-dot running';

    requestAnimationFrame(() => {
      const fitAddon = fitAddons.get(agentId);
      if (fitAddon) {
        fitAddon.fit();
        const term = terminals.get(agentId);
        if (term) api.resize(agentId, term.cols, term.rows);
      }
    });
  }
}

async function resumeAgent(agentId) {
  return startAgent(agentId, { resume: true });
}

async function restartAgent() {
  if (!activeAgentId) return;
  const terminal = terminals.get(activeAgentId);
  if (terminal) terminal.clear();

  const result = await api.restart(activeAgentId);
  if (result && result.error) {
    const term = terminals.get(activeAgentId);
    if (term) {
      term.writeln(`\r\n  \x1b[31m${result.error}\x1b[0m\r\n`);
    }
    showToast(result.error, 'error');
    return;
  }
  if (result) {
    agentStates.set(activeAgentId, 'running');
    updateStatusUI(activeAgentId);

    const dot = document.querySelector(`.status-dot[data-status="${activeAgentId}"]`);
    if (dot) dot.className = 'status-dot running';

    requestAnimationFrame(() => {
      const fitAddon = fitAddons.get(activeAgentId);
      if (fitAddon) {
        fitAddon.fit();
        const term = terminals.get(activeAgentId);
        if (term) api.resize(activeAgentId, term.cols, term.rows);
      }
    });
  }
}

async function stopAgent() {
  if (!activeAgentId) return;
  await api.kill(activeAgentId);
  agentStates.set(activeAgentId, 'stopped');
  updateStatusUI(activeAgentId);

  const dot = document.querySelector(`.status-dot[data-status="${activeAgentId}"]`);
  if (dot) dot.className = 'status-dot stopped';
}

let clearArmed = false;
let clearConfirmTimeout = null;

function armClear() {
  const btn = document.getElementById('btn-clear');
  if (clearArmed) {
    clearTimeout(clearConfirmTimeout);
    clearArmed = false;
    btn.classList.remove('armed');
    btn.title = 'Clear terminal';
    if (activeAgentId) {
      const terminal = terminals.get(activeAgentId);
      if (terminal) terminal.clear();
    }
    return;
  }
  clearArmed = true;
  btn.classList.add('armed');
  btn.title = 'Click again to confirm';
  clearConfirmTimeout = setTimeout(() => {
    clearArmed = false;
    btn.classList.remove('armed');
    btn.title = 'Clear terminal';
  }, 3000);
}

// --- Logs ---
async function toggleLogs() {
  const panel = document.getElementById('logs-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  closeAllPanels();
  if (!activeAgentId) return;
  await showLogsList();
  panel.classList.remove('hidden');
}

async function showLogsList() {
  const logs = await api.getLogs(activeAgentId);
  const listEl = document.getElementById('logs-list');
  const viewerEl = document.getElementById('log-viewer');
  const backBtn = document.getElementById('btn-logs-back');
  const titleEl = document.getElementById('logs-title');

  viewerEl.classList.add('hidden');
  listEl.style.display = 'block';
  backBtn.classList.add('hidden');
  titleEl.textContent = 'Session History';
  listEl.innerHTML = '';

  if (logs.length === 0) {
    listEl.innerHTML = '<div class="logs-empty"><p>No sessions recorded yet</p></div>';
    return;
  }

  for (const log of logs) {
    const item = document.createElement('div');
    item.className = 'log-item';

    const date = new Date(log.mtime);
    const dateStr = date.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    const timeStr = date.toLocaleTimeString(undefined, {
      hour: 'numeric', minute: '2-digit',
    });
    const size = formatSize(log.size);

    item.innerHTML = `
      <div class="log-item-date">${dateStr} at ${timeStr}</div>
      <div class="log-item-meta"><span>${size}</span></div>
    `;

    item.addEventListener('click', () => viewLog(log));
    listEl.appendChild(item);
  }
}

async function viewLog(log) {
  const content = await api.readLog(log.path);
  const viewerEl = document.getElementById('log-viewer');
  const listEl = document.getElementById('logs-list');
  const backBtn = document.getElementById('btn-logs-back');
  const titleEl = document.getElementById('logs-title');

  document.getElementById('log-content').textContent = stripAnsi(content);
  listEl.style.display = 'none';
  viewerEl.classList.remove('hidden');
  backBtn.classList.remove('hidden');

  const date = new Date(log.mtime);
  titleEl.textContent = date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  }) + ' at ' + date.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
}

// --- Helpers ---
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// --- Copy Last Response ---
async function copyLastResponse() {
  if (!activeAgentId) return;
  const terminal = terminals.get(activeAgentId);
  if (!terminal) return;

  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }

  // Walk backwards to find the last prompt boundary (common Claude Code patterns)
  let endIdx = lines.length - 1;
  // Trim trailing blanks
  while (endIdx > 0 && lines[endIdx].trim() === '') endIdx--;

  let startIdx = endIdx;
  for (let i = endIdx; i >= 0; i--) {
    const line = lines[i].trim();
    // Claude Code prompt indicators
    if (/^[>❯\$]/.test(line) || /^╭─/.test(line) || /^human:?\s*$/i.test(line)) {
      startIdx = i + 1;
      break;
    }
    startIdx = i;
  }

  const text = lines.slice(startIdx, endIdx + 1).join('\n')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\(B/g, '')
    .trim();

  if (!text) return;

  const btn = document.getElementById('btn-copy-last');
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch {
    showToast('Copy failed', 'error');
  }
}

// --- Stop Confirmation ---
let stopConfirmTimeout = null;
let stopArmed = false;

function armStop() {
  const btn = document.getElementById('btn-stop');
  if (stopArmed) {
    // Second click - actually stop
    clearTimeout(stopConfirmTimeout);
    stopArmed = false;
    btn.classList.remove('armed');
    stopAgent();
    return;
  }
  // First click - arm
  stopArmed = true;
  btn.classList.add('armed');
  btn.title = 'Click again to confirm';
  stopConfirmTimeout = setTimeout(() => {
    stopArmed = false;
    btn.classList.remove('armed');
    btn.title = 'Stop session';
  }, 3000);
}

// --- MCP Panel ---
let mcpConfig = null;
let editingServerName = null;

async function toggleMcp() {
  const panel = document.getElementById('mcp-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  closeAllPanels();
  await loadMcpPanel();
  panel.classList.remove('hidden');
}

async function loadMcpPanel() {
  if (!activeAgentId) return;
  const agent = config.agents.find(a => a.id === activeAgentId);
  document.getElementById('mcp-agent-label').textContent = agent ? agent.shortName : '';

  mcpConfig = await api.readMcp(activeAgentId);
  renderMcpList();
}

function renderMcpList() {
  const listEl = document.getElementById('mcp-list');
  const editorEl = document.getElementById('mcp-editor');
  editorEl.classList.add('hidden');
  listEl.style.display = 'block';
  listEl.innerHTML = '';

  const servers = mcpConfig && mcpConfig.mcpServers ? mcpConfig.mcpServers : {};
  const names = Object.keys(servers);

  if (names.length === 0) {
    listEl.innerHTML = '<div class="files-empty"><p>No MCP servers configured</p></div>';
    return;
  }

  for (const name of names) {
    const server = servers[name];
    const item = document.createElement('div');
    item.className = 'mcp-item';

    const typeLabel = server.type || 'stdio';
    const detail = server.type === 'http' ? server.url : (server.command || '');

    item.innerHTML = `
      <div class="mcp-item-info">
        <div class="mcp-item-name">${escapeHtml(name)}</div>
        <div class="mcp-item-detail">${escapeHtml(typeLabel)} - ${escapeHtml(detail)}</div>
      </div>
      <div class="mcp-item-actions">
        <button class="note-action-btn note-send-btn mcp-edit-btn" title="Edit">Edit</button>
        <button class="note-action-btn note-delete-btn mcp-del-btn" title="Remove">Del</button>
      </div>
    `;

    item.querySelector('.mcp-edit-btn').addEventListener('click', () => editMcpServer(name));
    item.querySelector('.mcp-del-btn').addEventListener('click', () => deleteMcpServer(name));
    listEl.appendChild(item);
  }
}

function editMcpServer(name) {
  editingServerName = name;
  const servers = mcpConfig.mcpServers || {};
  const serverJson = JSON.stringify(servers[name] || {}, null, 2);

  document.getElementById('mcp-list').style.display = 'none';
  document.getElementById('mcp-editor').classList.remove('hidden');
  document.getElementById('mcp-editor-title').textContent = name;
  document.getElementById('mcp-editor-input').value = serverJson;
}

function addMcpServer() {
  // Show integration library instead of bare prompt
  renderMcpLibrary();
}

function renderMcpLibrary() {
  const listEl = document.getElementById('mcp-list');
  const editorEl = document.getElementById('mcp-editor');
  editorEl.classList.add('hidden');
  listEl.style.display = 'block';
  listEl.innerHTML = '<div class="mcp-library-header">Integration Library</div>';

  for (const tmpl of MCP_TEMPLATES) {
    const item = document.createElement('div');
    item.className = 'mcp-item mcp-library-item';
    item.innerHTML = `
      <div class="mcp-item-info">
        <div class="mcp-item-name">${escapeHtml(tmpl.name)}</div>
        <div class="mcp-item-detail">${escapeHtml(tmpl.desc)}</div>
      </div>
      <div class="mcp-item-actions">
        <button class="note-action-btn note-send-btn mcp-add-tmpl-btn">Add</button>
      </div>
    `;
    item.querySelector('.mcp-add-tmpl-btn').addEventListener('click', () => {
      if (!mcpConfig) mcpConfig = { mcpServers: {} };
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      mcpConfig.mcpServers[tmpl.id] = JSON.parse(JSON.stringify(tmpl.config));
      editMcpServer(tmpl.id);
      showToast(tmpl.setupNote, 'info');
    });
    listEl.appendChild(item);
  }

  // Custom server option at bottom
  const customItem = document.createElement('div');
  customItem.className = 'mcp-item mcp-library-item';
  customItem.innerHTML = `
    <div class="mcp-item-info">
      <div class="mcp-item-name">Custom Server</div>
      <div class="mcp-item-detail">Configure a server manually with JSON</div>
    </div>
    <div class="mcp-item-actions">
      <button class="note-action-btn note-send-btn mcp-add-custom-btn">Add</button>
    </div>
  `;
  customItem.querySelector('.mcp-add-custom-btn').addEventListener('click', () => {
    const name = prompt('Server name:');
    if (!name || !name.trim()) return;
    if (!mcpConfig) mcpConfig = { mcpServers: {} };
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    mcpConfig.mcpServers[name.trim()] = { type: 'stdio', command: '', args: [] };
    editMcpServer(name.trim());
  });
  listEl.appendChild(customItem);
}

async function saveMcpEditor() {
  try {
    const parsed = JSON.parse(document.getElementById('mcp-editor-input').value);
    mcpConfig.mcpServers[editingServerName] = parsed;
    await api.writeMcp(activeAgentId, mcpConfig);
    renderMcpList();
  } catch (err) {
    alert('Invalid JSON: ' + err.message);
  }
}

async function deleteMcpServer(name) {
  if (!mcpConfig || !mcpConfig.mcpServers) return;
  delete mcpConfig.mcpServers[name];
  await api.writeMcp(activeAgentId, mcpConfig);
  renderMcpList();
}

// --- Agent Duplication ---
async function duplicateAgent() {
  if (!activeAgentId) return;
  const source = config.agents.find(a => a.id === activeAgentId);
  if (!source || source.type === 'webview') return;

  // Find next available instance number
  const baseId = source.id.replace(/-\d+$/, '');
  const existing = config.agents.filter(a => a.id === baseId || a.id.startsWith(baseId + '-'));
  const num = existing.length + 1;
  const newId = `${baseId}-${num}`;

  const newAgent = {
    ...JSON.parse(JSON.stringify(source)),
    id: newId,
    name: `${source.name} (${num})`,
    shortName: `${source.shortName}${num}`,
  };

  const updated = await api.addAgent(newAgent);
  if (updated) config = updated;

  // Initialize state
  agentStates.set(newId, 'stopped');
  hasUnread.set(newId, false);

  // Create terminal for new agent
  createTerminalForAgent(newAgent);

  // Re-render sidebar and select
  renderSidebar();
  selectAgent(newId);
}

function removeAgent(agentId) {
  // Kill if running
  api.kill(agentId);
  agentStates.delete(agentId);
  hasUnread.delete(agentId);

  // Remove terminal
  const terminal = terminals.get(agentId);
  if (terminal) terminal.dispose();
  terminals.delete(agentId);
  fitAddons.delete(agentId);

  const wrapper = document.getElementById(`terminal-${agentId}`);
  if (wrapper) wrapper.remove();

  // Remove from config (atomic)
  api.removeAgentConfig(agentId).then(updated => { if (updated) config = updated; });

  renderSidebar();
  if (activeAgentId === agentId) {
    if (config.agents.length > 0) {
      selectAgent(config.agents[0].id);
    } else {
      activeAgentId = null;
      showWelcomeScreen();
    }
  }
}

function createTerminalForAgent(agent) {
  const container = document.getElementById('terminal-container');
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = `terminal-${agent.id}`;
  container.appendChild(wrapper);
  initTerminalForAgent(agent, wrapper);
}

// --- Skill Templates ---
const SKILL_TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank',
    desc: 'Empty directory, build from scratch',
    claudeMd: null,
    runFiles: [],
  },
  {
    id: 'analyst',
    name: 'Data Analyst',
    desc: 'Query databases, build reports, surface insights',
    claudeMd: `# Data Analyst

## Role
You are a semi-autonomous data analyst. You query databases, build reports, and surface actionable insights. You operate independently on analysis tasks but check in before taking actions that affect shared systems.

## Guidelines
- Always include date filters and LIMIT in SQL queries - never run unbounded queries
- Lead with the sharpest "so what" - the insight matters more than the method
- Use tables for comparisons, charts descriptions for trends
- When querying, search for tables first - never guess table or column names
- For time series, always show MoM and YoY context
- Present numbers with appropriate precision (round to meaningful digits)
- If data looks unexpected, flag it rather than explaining it away

## Workflow
1. Clarify the question - restate what you're analyzing and why
2. Identify relevant data sources
3. Write and run queries incrementally
4. Synthesize findings into a clear narrative
5. End with specific, actionable recommendations
`,
    runFiles: [
      { name: 'run-analysis.md', content: `# Run Analysis

Analyze the topic described below. Follow these steps:

1. **Scope** - Clarify what we're measuring and the time range
2. **Data discovery** - Find relevant tables and understand their schema
3. **Query** - Write focused SQL queries with date filters and limits
4. **Analyze** - Look for patterns, outliers, and trends
5. **Report** - Summarize with:
   - Key metrics table
   - Trend analysis (MoM, YoY where applicable)
   - Top 3 actionable recommendations

## Topic
[Describe what to analyze]
` },
    ],
  },
  {
    id: 'writer',
    name: 'Content Writer',
    desc: 'Draft content, edit copy, maintain voice',
    claudeMd: `# Content Writer

## Role
You are a semi-autonomous content writer. You draft, edit, and refine written content while maintaining a consistent voice and tone. You work independently on drafts but seek approval before publishing or sending.

## Guidelines
- Match the voice and tone established in existing samples
- Keep writing concise and punchy - cut filler words ruthlessly
- Always save drafts before sharing - never publish directly
- Read existing content before writing new content in the same space
- Use active voice, short sentences, concrete language
- When editing, preserve the author's intent - improve clarity, not style preferences

## Workflow
1. Review any style guides or existing samples
2. Draft content based on the brief
3. Self-edit: cut length by 20%, strengthen the opening
4. Save draft for review
`,
    runFiles: [
      { name: 'run-draft.md', content: `# Draft Content

Write a draft based on the brief below.

1. Review any existing style samples in this directory
2. Write the first draft
3. Self-edit for conciseness and clarity
4. Save the final draft

## Brief
[Describe what to write]
` },
    ],
  },
  {
    id: 'engineer',
    name: 'Software Engineer',
    desc: 'Write code, fix bugs, review changes',
    claudeMd: `# Software Engineer

## Role
You are a semi-autonomous software engineer. You write, debug, and review code. You make changes independently within your scope but confirm before making architectural decisions or changes that affect other systems.

## Guidelines
- Read existing code before modifying - understand the patterns in use
- Keep changes minimal and focused on the task at hand
- Run tests after making changes
- Don't add features beyond what was asked
- Don't refactor code you didn't change
- Prefer editing existing files over creating new ones
- Write code that matches the existing style of the codebase

## Workflow
1. Understand the task and its scope
2. Read relevant existing code
3. Make focused changes
4. Test the changes
5. Summarize what was changed and why
`,
    runFiles: [
      { name: 'run-task.md', content: `# Implement Task

Implement the task described below.

1. Read relevant code to understand existing patterns
2. Make the minimum changes needed
3. Run tests to verify
4. Summarize changes

## Task
[Describe what to implement]
` },
    ],
  },
  {
    id: 'pm',
    name: 'Product Manager',
    desc: 'Write specs, track progress, coordinate work',
    claudeMd: `# Product Manager

## Role
You are a semi-autonomous product manager. You write specs, track progress, and coordinate across workstreams. You operate independently on research and documentation but confirm before communicating decisions to stakeholders.

## Guidelines
- Always check the current state of things before planning
- Write clear requirements with specific acceptance criteria
- Keep stakeholders informed but don't over-communicate
- When in doubt, bias toward shipping smaller increments
- Track decisions and their rationale - context gets lost fast
- Separate facts from opinions in your analysis

## Workflow
1. Understand the goal and constraints
2. Research current state
3. Draft the spec or plan
4. Identify risks and open questions
5. Present for review
`,
    runFiles: [
      { name: 'run-spec.md', content: `# Write Spec

Write a product spec for the feature described below.

1. Research the current state and any prior art
2. Define the problem clearly
3. Propose a solution with:
   - User stories
   - Acceptance criteria
   - Open questions
4. Identify risks and dependencies

## Feature
[Describe the feature]
` },
    ],
  },
  {
    id: 'reviewer',
    name: 'Code Reviewer',
    desc: 'Review PRs, catch bugs, enforce standards',
    claudeMd: `# Code Reviewer

## Role
You are a staff-level code reviewer. You review pull requests, catch bugs before they ship, and enforce code quality standards. You provide actionable feedback - not style nitpicks.

## Guidelines
- Focus on correctness, security, and maintainability - not style preferences
- Every comment should be actionable: say what to change, not just what's wrong
- Distinguish blocking issues from suggestions (prefix with MUST or CONSIDER)
- Check for: logic errors, edge cases, missing error handling, security holes, test gaps
- Read the PR description first to understand intent before reviewing code
- Don't suggest refactors that aren't related to the PR's purpose
- If the code works and is clear, approve it - perfect is the enemy of shipped

## Workflow
1. Read the PR description and linked issues
2. Review the diff file by file
3. Flag blocking issues (MUST) vs suggestions (CONSIDER)
4. Check test coverage for changed code paths
5. Summarize: approve, request changes, or comment
`,
    runFiles: [
      { name: 'run-review.md', content: `# Review Code

Review the changes described below. Follow these steps:

1. **Understand** - Read the PR description and context
2. **Review** - Go through each changed file
3. **Flag** - Mark issues as MUST (blocking) or CONSIDER (suggestion)
4. **Test gaps** - Note any untested code paths
5. **Verdict** - Approve, request changes, or comment

## PR / Changes
[Paste PR link or describe the changes]
` },
    ],
  },
  {
    id: 'qa',
    name: 'QA Tester',
    desc: 'Test features, find bugs, write regression tests',
    claudeMd: `# QA Tester

## Role
You are a thorough QA tester. You test features systematically, find bugs before users do, and write regression tests to prevent regressions. You think like a user who will try everything wrong.

## Guidelines
- Test the happy path first, then edge cases, then adversarial inputs
- Every bug report needs: steps to reproduce, expected vs actual, severity
- Write regression tests for every bug you find
- Check both the feature and its neighbors - changes often break adjacent things
- Test with realistic data, not just "test123"
- Don't just verify it works - verify it fails gracefully when it shouldn't work
- If you can't reproduce a bug, document exactly what you tried

## Workflow
1. Understand what the feature should do (read spec/PR)
2. Write test cases: happy path, edge cases, error cases
3. Execute tests systematically
4. File bugs with reproduction steps
5. Write automated regression tests for confirmed bugs
`,
    runFiles: [
      { name: 'run-test.md', content: `# Test Feature

Test the feature described below. Follow these steps:

1. **Understand** - Read the spec or PR to know expected behavior
2. **Plan** - Write test cases (happy path, edges, errors)
3. **Execute** - Run each test case, document results
4. **Report** - File bugs with repro steps, expected vs actual
5. **Automate** - Write regression tests for any bugs found

## Feature
[Describe what to test]
` },
    ],
  },
  {
    id: 'devops',
    name: 'DevOps',
    desc: 'Deploy, monitor, manage infrastructure',
    claudeMd: `# DevOps

## Role
You are a DevOps engineer. You manage deployments, monitor production health, and maintain infrastructure. You bias toward reliability and reversibility - every deploy should be easy to roll back.

## Guidelines
- Always check current production state before making changes
- Prefer small, incremental deploys over big-bang releases
- Every change should be reversible - know the rollback plan before deploying
- Monitor after deploying: check logs, error rates, latency
- Document infrastructure changes - the next person debugging at 2am will thank you
- Never run destructive commands without confirming first
- Keep secrets out of code and logs

## Workflow
1. Pre-deploy: check current state, verify tests pass
2. Deploy: push changes incrementally
3. Verify: check health endpoints, logs, error rates
4. Monitor: watch for 10-15 minutes post-deploy
5. Document: note what changed and any issues
`,
    runFiles: [
      { name: 'run-deploy.md', content: `# Deploy

Deploy the changes described below. Follow these steps:

1. **Pre-check** - Verify tests pass, review what's being deployed
2. **Deploy** - Push changes to the target environment
3. **Verify** - Check health endpoints, logs, error rates
4. **Monitor** - Watch metrics for 10-15 minutes
5. **Document** - Note what was deployed and any issues

## What to deploy
[Describe the changes or target]
` },
    ],
  },
];

// --- Starter Packs ---
// Pre-built teams that create multiple agents at once
// Inspired by gstack (github.com/garrytan/gstack) by Garry Tan
const STARTER_PACKS = [
  {
    id: 'engineering',
    name: 'Engineering Team',
    desc: 'Ship software with a full dev squad',
    agents: [
      { template: 'engineer', name: 'Engineer', color: '#14b8a6' },
      { template: 'reviewer', name: 'Code Reviewer', color: '#f59e0b' },
      { template: 'qa', name: 'QA Tester', color: '#ec4899' },
    ],
  },
  {
    id: 'product',
    name: 'Product Team',
    desc: 'Plan, build, and analyze your product',
    agents: [
      { template: 'pm', name: 'Product Manager', color: '#a06bef' },
      { template: 'engineer', name: 'Engineer', color: '#14b8a6' },
      { template: 'analyst', name: 'Data Analyst', color: '#5b8def' },
    ],
  },
  {
    id: 'content',
    name: 'Content Studio',
    desc: 'Write, edit, and publish content',
    agents: [
      { template: 'writer', name: 'Writer', color: '#6befa0' },
      { template: 'reviewer', name: 'Editor', color: '#f59e0b' },
      { template: 'analyst', name: 'Research Analyst', color: '#5b8def' },
    ],
  },
  {
    id: 'fullstack',
    name: 'Full Stack',
    desc: 'End-to-end: plan, build, test, deploy',
    agents: [
      { template: 'pm', name: 'Product Manager', color: '#a06bef' },
      { template: 'engineer', name: 'Engineer', color: '#14b8a6' },
      { template: 'reviewer', name: 'Code Reviewer', color: '#f59e0b' },
      { template: 'devops', name: 'DevOps', color: '#ef6b6b' },
    ],
  },
];

// --- Integration Templates ---
const MCP_TEMPLATES = [
  {
    id: 'slack',
    name: 'Slack',
    desc: 'Read channels, send messages, search threads',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
    },
    envLabels: {
      SLACK_BOT_TOKEN: 'Bot/User Token (xoxb-... or xoxp-...)',
      SLACK_TEAM_ID: 'Team ID (starts with T)',
    },
    setupNote: 'Create a Slack app at api.slack.com/apps and add the necessary scopes.',
  },
  {
    id: 'github',
    name: 'GitHub',
    desc: 'Manage repos, PRs, issues',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    },
    envLabels: {
      GITHUB_PERSONAL_ACCESS_TOKEN: 'Personal Access Token (ghp_...)',
    },
    setupNote: 'Create a token at github.com/settings/tokens with repo scope.',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    desc: 'Query and explore databases',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:pass@localhost:5432/db'],
      env: {},
    },
    envLabels: {},
    setupNote: 'Replace the connection string (last arg) with your database URL.',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    desc: 'Read and write files in specified directories',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '~/Documents'],
      env: {},
    },
    envLabels: {},
    setupNote: 'Change the path argument to the directory you want to expose.',
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    desc: 'Drive, Docs, Gmail, Sheets',
    docsUrl: 'https://github.com/nicholasgriffen/workspace-mcp',
    config: {
      type: 'stdio',
      command: 'workspace-mcp',
      args: ['--single-user', '--tools', 'drive', 'docs', 'gmail'],
      env: { GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '' },
    },
    envLabels: {
      GOOGLE_OAUTH_CLIENT_ID: 'OAuth Client ID',
      GOOGLE_OAUTH_CLIENT_SECRET: 'OAuth Client Secret',
    },
    setupNote: 'Install workspace-mcp and run setup first.',
  },
];

// --- Help Panel ---
const HELP_CONTENT = `
## What is an Agent?

An agent is a **semi-autonomous team member** powered by Claude Code. Each agent lives in its own working directory with its own instructions, tools, and context.

Think of it like hiring a specialist: you give them a desk (working directory), a job description (CLAUDE.md), standard procedures (run files), and tools (MCP servers). Then you let them work.

**The anatomy of an agent:**
- **Working directory** - the agent's home base. All its files live here.
- **CLAUDE.md** - the agent's instructions. Its role, guidelines, and knowledge.
- **run-*.md files** - repeatable tasks. Like SOPs the agent can execute.
- **.mcp.json** - integrations. Connects the agent to Slack, databases, APIs, etc.

## Building Your Agent

**1. Create CLAUDE.md** - This is the most important file. It tells the agent who it is and how to operate. Start the agent, then ask it to help you write its own instructions based on what you need.

**2. Add run files** - For tasks you'll repeat, create \`run-*.md\` files. Name them clearly: \`run-analysis.md\`, \`run-weekly-report.md\`, \`run-deploy.md\`. Then just tell the agent "follow run-analysis" to kick one off.

**3. Configure integrations** - Use the MCP panel (lightning bolt icon) to connect your agent to external tools. The Integration Library has pre-built configs for common services.

**4. Set permissions** - Use the mode selector in the toolbar to control how much autonomy your agent has. Start with "Default" (manual approval) and loosen as you build trust.

## Best Practices

- **Focused roles beat broad ones.** A "Data Analyst" agent will outperform a "do everything" agent. Scope creates competence.
- **Keep CLAUDE.md concise but specific.** Guidelines should be actionable, not aspirational. "Always include date filters in SQL" beats "be thorough."
- **Use run files for multi-step workflows.** If you find yourself giving the same sequence of instructions repeatedly, capture it in a run file.
- **Start with Default permissions.** Watch how the agent works, then adjust. You can always increase autonomy later.
- **Let agents build themselves.** Start a new agent and tell it what you need - it can help write its own CLAUDE.md and run files.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+1-9 | Switch agent tabs |
| Cmd+R | Start / restart agent |
| Cmd+E | Notepad |
| Cmd+D | Reader view |
| Cmd+F | File manager |
| Cmd+B | Toggle sidebar |
| Esc | Close overlay |
`;

function toggleHelp() {
  const panel = document.getElementById('help-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  closeAllPanels();
  renderHelpContent();
  panel.classList.remove('hidden');
}

function renderHelpContent() {
  const contentEl = document.getElementById('help-content');
  marked.setOptions({ breaks: false, gfm: true });
  contentEl.innerHTML = `<div class="help-prose">${marked.parse(HELP_CONTENT)}</div>`;
}

// --- Add Agent Modal ---
let selectedTemplate = null;

const PRESET_COLORS = [
  '#5b8def', '#ef6b6b', '#6befa0', '#a06bef',
  '#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6',
];
let selectedColor = PRESET_COLORS[0];

function renderColorPicker(containerId, currentColor) {
  const picker = document.getElementById(containerId);
  picker.innerHTML = '';
  for (const color of PRESET_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = `color-swatch${color === currentColor ? ' active' : ''}`;
    swatch.style.background = color;
    swatch.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedColor = color;
      picker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
    picker.appendChild(swatch);
  }
}

function renderTemplateSelector() {
  const container = document.getElementById('template-selector');
  container.innerHTML = '';
  for (const tmpl of SKILL_TEMPLATES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `template-card${selectedTemplate === tmpl.id ? ' active' : ''}`;
    card.innerHTML = `<div class="template-name">${tmpl.name}</div><div class="template-desc">${tmpl.desc}</div>`;
    card.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedTemplate = tmpl.id;
      container.querySelectorAll('.template-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      // Pre-fill name if blank
      const nameInput = document.getElementById('add-agent-name');
      if (!nameInput.value.trim() && tmpl.id !== 'blank') {
        nameInput.value = tmpl.name;
        nameInput.dispatchEvent(new Event('input'));
      }
    });
    container.appendChild(card);
  }
}

function openAddAgentModal() {
  document.getElementById('add-agent-name').value = '';
  const cwdInput = document.getElementById('add-agent-cwd');
  cwdInput.value = '';
  delete cwdInput.dataset.manual;
  document.getElementById('add-agent-command').value = 'claude';
  selectedColor = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
  selectedTemplate = 'blank';
  renderColorPicker('color-picker', selectedColor);
  renderTemplateSelector();
  document.getElementById('add-agent-modal').classList.remove('hidden');
  document.getElementById('add-agent-name').focus();
}

function closeAddAgentModal() {
  document.getElementById('add-agent-modal').classList.add('hidden');
}

async function confirmAddAgent() {
  const name = document.getElementById('add-agent-name').value.trim();
  const cwd = document.getElementById('add-agent-cwd').value.trim();
  const command = document.getElementById('add-agent-command').value.trim() || 'claude';

  if (!name) {
    showToast('Agent name is required', 'error');
    return;
  }
  if (!cwd) {
    showToast('Working directory is required', 'error');
    return;
  }

  // Generate id from name
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) {
    showToast('Invalid agent name', 'error');
    return;
  }

  // Check for duplicate id
  if (config.agents.some(a => a.id === id)) {
    showToast('An agent with this name already exists', 'error');
    return;
  }

  // Generate shortName: first word, uppercase, max 4 chars
  const firstWord = name.split(/\s+/)[0];
  const shortName = firstWord.length <= 4 ? firstWord.toUpperCase() : firstWord.slice(0, 4).toUpperCase();

  // Normalize cwd: convert home dir to ~
  let normalizedCwd = cwd;
  if (cwd.startsWith('/Users/') || cwd.startsWith('/home/')) {
    const homeParts = cwd.split('/');
    if (homeParts.length >= 3) {
      normalizedCwd = '~/' + homeParts.slice(3).join('/');
    }
  }

  // Auto-create directory if it doesn't exist (main process handles this on spawn,
  // but let's also ensure it via the config save so the folder is ready)
  const newAgent = {
    id,
    name,
    shortName,
    cwd: normalizedCwd,
    command,
    color: selectedColor,
    channels: [],
  };

  const updated = await api.addAgent(newAgent);
  if (updated) config = updated;

  // Write starter files from template
  const tmpl = SKILL_TEMPLATES.find(t => t.id === selectedTemplate);
  if (tmpl && (tmpl.claudeMd || tmpl.runFiles.length > 0)) {
    const files = [];
    if (tmpl.claudeMd) files.push({ name: 'CLAUDE.md', content: tmpl.claudeMd });
    for (const rf of tmpl.runFiles) files.push(rf);
    await api.writeStarterFiles(normalizedCwd, files);
  }

  // Initialize state
  agentStates.set(id, 'stopped');
  hasUnread.set(id, false);

  // Create terminal
  createTerminalForAgent(newAgent);

  // Show main UI if coming from welcome screen
  showMainUI();

  // Re-render and select
  renderSidebar();
  selectAgent(id);
  closeAddAgentModal();
  showToast(`${shortName} added`, 'success');
}

// --- Unified Configure Panel ---
let configureMcpConfig = null;

function toggleConfigure() {
  const panel = document.getElementById('configure-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  closeAllPanels();
  renderConfigurePanel();
  panel.classList.remove('hidden');
}

async function renderConfigurePanel() {
  if (!activeAgentId) return;
  const agent = config.agents.find(a => a.id === activeAgentId);
  if (!agent) return;

  // --- Agent section ---
  const agentForm = document.getElementById('config-agent-form');
  agentForm.innerHTML = `
    <div class="form-group">
      <label>Name</label>
      <input id="cfg-name" type="text" value="${escapeHtml(agent.name)}" spellcheck="false" />
    </div>
    <div class="form-group">
      <label>Short Name</label>
      <input id="cfg-shortname" type="text" value="${escapeHtml(agent.shortName)}" maxlength="5" spellcheck="false" />
    </div>
    <div class="form-group">
      <label>Working Directory</label>
      <div class="folder-input">
        <input id="cfg-cwd" type="text" value="${escapeHtml(agent.cwd)}" spellcheck="false" />
        <button class="browse-btn" id="btn-cfg-browse" type="button">Browse</button>
      </div>
    </div>
    <div class="form-group">
      <label>Command</label>
      <input id="cfg-command" type="text" value="${escapeHtml(agent.command)}" spellcheck="false" />
    </div>
    <div class="form-group">
      <label>Color</label>
      <div id="cfg-color-picker"></div>
    </div>
    <div class="settings-actions">
      <button id="btn-cfg-save" class="settings-save-btn">Save Changes</button>
      <button id="btn-cfg-delete" class="settings-delete-btn">Delete Agent</button>
    </div>
  `;
  selectedColor = agent.color;
  renderColorPicker('cfg-color-picker', agent.color);
  agentForm.querySelector('#btn-cfg-browse').addEventListener('click', async () => {
    const folder = await api.browseFolder();
    if (folder) document.getElementById('cfg-cwd').value = folder;
  });
  agentForm.querySelector('#btn-cfg-save').addEventListener('click', saveConfigureAgent);
  let deleteArmed = false;
  let deleteTimeout = null;
  const deleteBtn = agentForm.querySelector('#btn-cfg-delete');
  deleteBtn.addEventListener('click', () => {
    if (deleteArmed) {
      clearTimeout(deleteTimeout);
      removeAgent(activeAgentId);
      document.getElementById('configure-panel').classList.add('hidden');
      return;
    }
    deleteArmed = true;
    deleteBtn.classList.add('armed');
    deleteBtn.textContent = 'Click again to confirm';
    deleteTimeout = setTimeout(() => {
      deleteArmed = false;
      deleteBtn.classList.remove('armed');
      deleteBtn.textContent = 'Delete Agent';
    }, 3000);
  });

  // --- Integrations section ---
  configureMcpConfig = await api.readMcp(activeAgentId);
  renderConfigureIntegrations();

  // --- Channels section ---
  renderConfigureChannels();
}

function renderConfigureIntegrations() {
  const container = document.getElementById('config-integrations');
  const servers = configureMcpConfig && configureMcpConfig.mcpServers ? configureMcpConfig.mcpServers : {};
  const names = Object.keys(servers);

  if (names.length === 0) {
    // Empty state: show library directly
    container.innerHTML = '<p class="config-empty-hint">Connect your agent to external tools.</p>';
    renderIntegrationLibrary(container);
    return;
  }

  // Show existing servers
  container.innerHTML = '';
  for (const name of names) {
    const server = servers[name];
    const tmpl = MCP_TEMPLATES.find(t => t.id === name);
    const typeLabel = server.type || 'stdio';
    const detail = server.type === 'http' ? server.url : (server.command || '');
    const docsLink = tmpl && tmpl.docsUrl ? `<a class="mcp-docs-link" href="#" data-url="${tmpl.docsUrl}">Docs</a>` : '';

    const item = document.createElement('div');
    item.className = 'mcp-item';
    item.innerHTML = `
      <div class="mcp-item-info">
        <div class="mcp-item-name">${escapeHtml(tmpl ? tmpl.name : name)} ${docsLink}</div>
        <div class="mcp-item-detail">${escapeHtml(typeLabel)} - ${escapeHtml(detail)}</div>
      </div>
      <div class="mcp-item-actions">
        <button class="note-action-btn note-send-btn mcp-edit-btn" type="button">Edit</button>
        <button class="note-action-btn note-delete-btn mcp-del-btn" type="button">Del</button>
      </div>
    `;
    item.querySelector('.mcp-edit-btn').addEventListener('click', () => showMcpForm(name));
    item.querySelector('.mcp-del-btn').addEventListener('click', async () => {
      delete configureMcpConfig.mcpServers[name];
      await api.writeMcp(activeAgentId, configureMcpConfig);
      renderConfigureIntegrations();
    });
    const docLink = item.querySelector('.mcp-docs-link');
    if (docLink) docLink.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(docLink.dataset.url); });
    container.appendChild(item);
  }

  // Add Integration button
  const addBtn = document.createElement('button');
  addBtn.className = 'config-add-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add Integration';
  addBtn.addEventListener('click', () => {
    const libraryEl = container.querySelector('.mcp-library-section');
    if (libraryEl) { libraryEl.remove(); addBtn.textContent = '+ Add Integration'; return; }
    addBtn.textContent = 'Cancel';
    const section = document.createElement('div');
    section.className = 'mcp-library-section';
    renderIntegrationLibrary(section);
    container.appendChild(section);
  });
  container.appendChild(addBtn);
}

function renderIntegrationLibrary(container) {
  for (const tmpl of MCP_TEMPLATES) {
    const item = document.createElement('div');
    item.className = 'integration-card';
    item.innerHTML = `
      <div class="integration-card-info">
        <div class="integration-card-name">${escapeHtml(tmpl.name)}</div>
        <div class="integration-card-desc">${escapeHtml(tmpl.desc)}</div>
      </div>
    `;
    item.addEventListener('click', () => {
      if (!configureMcpConfig) configureMcpConfig = { mcpServers: {} };
      if (!configureMcpConfig.mcpServers) configureMcpConfig.mcpServers = {};
      configureMcpConfig.mcpServers[tmpl.id] = JSON.parse(JSON.stringify(tmpl.config));
      showMcpForm(tmpl.id);
    });
    container.appendChild(item);
  }

  // Custom server
  const custom = document.createElement('div');
  custom.className = 'integration-card';
  custom.innerHTML = `
    <div class="integration-card-info">
      <div class="integration-card-name">Custom Server</div>
      <div class="integration-card-desc">Configure manually with JSON</div>
    </div>
  `;
  custom.addEventListener('click', () => {
    const name = prompt('Server name:');
    if (!name || !name.trim()) return;
    if (!configureMcpConfig) configureMcpConfig = { mcpServers: {} };
    if (!configureMcpConfig.mcpServers) configureMcpConfig.mcpServers = {};
    configureMcpConfig.mcpServers[name.trim()] = { type: 'stdio', command: '', args: [] };
    showMcpJsonEditor(name.trim());
  });
  container.appendChild(custom);
}

function showMcpForm(name) {
  const container = document.getElementById('config-integrations');
  const server = configureMcpConfig.mcpServers[name];
  const tmpl = MCP_TEMPLATES.find(t => t.id === name);
  const envEntries = Object.entries(server.env || {});

  container.innerHTML = '';

  // Header with back button
  const header = document.createElement('div');
  header.className = 'mcp-form-header';
  header.innerHTML = `<button type="button" class="mcp-back-btn">&larr; Back</button><span class="mcp-form-title">${escapeHtml(tmpl ? tmpl.name : name)}</span>`;
  if (tmpl && tmpl.docsUrl) {
    const docsLink = document.createElement('a');
    docsLink.className = 'mcp-docs-link';
    docsLink.href = '#';
    docsLink.textContent = 'Setup docs';
    docsLink.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(tmpl.docsUrl); });
    header.appendChild(docsLink);
  }
  header.querySelector('.mcp-back-btn').addEventListener('click', () => renderConfigureIntegrations());
  container.appendChild(header);

  if (tmpl && tmpl.setupNote) {
    const note = document.createElement('p');
    note.className = 'mcp-setup-note';
    note.textContent = tmpl.setupNote;
    container.appendChild(note);
  }

  // Type
  const typeGroup = document.createElement('div');
  typeGroup.className = 'form-group';
  typeGroup.innerHTML = `<label>Type</label><div class="mcp-form-value">${escapeHtml(server.type || 'stdio')}</div>`;
  container.appendChild(typeGroup);

  // Command / URL
  if (server.type === 'http') {
    const urlGroup = document.createElement('div');
    urlGroup.className = 'form-group';
    urlGroup.innerHTML = `<label>URL</label><input id="mcp-form-url" type="text" value="${escapeHtml(server.url || '')}" spellcheck="false" />`;
    container.appendChild(urlGroup);
  } else {
    const cmdGroup = document.createElement('div');
    cmdGroup.className = 'form-group';
    cmdGroup.innerHTML = `<label>Command</label><div class="mcp-form-value">${escapeHtml(server.command || '')} ${escapeHtml((server.args || []).join(' '))}</div>`;
    container.appendChild(cmdGroup);
  }

  // Env vars as form fields
  if (envEntries.length > 0) {
    for (const [key, value] of envEntries) {
      const label = (tmpl && tmpl.envLabels && tmpl.envLabels[key]) || key;
      const group = document.createElement('div');
      group.className = 'form-group';
      group.innerHTML = `<label>${escapeHtml(label)}</label><input class="mcp-env-input" data-key="${escapeHtml(key)}" type="text" value="${escapeHtml(value)}" placeholder="Paste your value here" spellcheck="false" />`;
      container.appendChild(group);
    }
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  actions.innerHTML = `<button type="button" class="settings-save-btn" id="btn-mcp-form-save">Save</button><button type="button" class="config-json-toggle">Edit as JSON</button>`;
  actions.querySelector('#btn-mcp-form-save').addEventListener('click', async () => {
    // Save env values back
    container.querySelectorAll('.mcp-env-input').forEach(input => {
      server.env[input.dataset.key] = input.value;
    });
    if (server.type === 'http') {
      const urlInput = container.querySelector('#mcp-form-url');
      if (urlInput) server.url = urlInput.value;
    }
    configureMcpConfig.mcpServers[name] = server;
    await api.writeMcp(activeAgentId, configureMcpConfig);
    showToast('Integration saved', 'success');
    renderConfigureIntegrations();
  });
  actions.querySelector('.config-json-toggle').addEventListener('click', () => showMcpJsonEditor(name));
  container.appendChild(actions);
}

function showMcpJsonEditor(name) {
  const container = document.getElementById('config-integrations');
  const server = configureMcpConfig.mcpServers[name];
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'mcp-form-header';
  header.innerHTML = `<button type="button" class="mcp-back-btn">&larr; Back</button><span class="mcp-form-title">${escapeHtml(name)} (JSON)</span>`;
  header.querySelector('.mcp-back-btn').addEventListener('click', () => renderConfigureIntegrations());
  container.appendChild(header);

  const textarea = document.createElement('textarea');
  textarea.className = 'mcp-json-editor';
  textarea.rows = 12;
  textarea.spellcheck = false;
  textarea.value = JSON.stringify(server, null, 2);
  container.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  actions.innerHTML = `<button type="button" class="settings-save-btn" id="btn-mcp-json-save">Save</button>`;
  actions.querySelector('#btn-mcp-json-save').addEventListener('click', async () => {
    try {
      const parsed = JSON.parse(textarea.value);
      configureMcpConfig.mcpServers[name] = parsed;
      await api.writeMcp(activeAgentId, configureMcpConfig);
      showToast('Integration saved', 'success');
      renderConfigureIntegrations();
    } catch (err) {
      showToast('Invalid JSON: ' + err.message, 'error');
    }
  });
  container.appendChild(actions);
}

function renderConfigureChannels() {
  if (!activeAgentId) return;
  const agent = config.agents.find(a => a.id === activeAgentId);
  if (!agent) return;

  const container = document.getElementById('config-channels');
  container.innerHTML = '';
  const agentChannels = agent.channels || [];

  for (const ch of AVAILABLE_CHANNELS) {
    const enabled = agentChannels.includes(ch.plugin);
    const item = document.createElement('div');
    item.className = `channel-item${enabled ? ' enabled' : ''}`;
    item.innerHTML = `
      <div class="channel-icon">${ch.icon}</div>
      <div class="channel-info">
        <div class="channel-name">${ch.name}</div>
        <div class="channel-desc">${ch.desc}</div>
      </div>
      <button class="channel-toggle${enabled ? ' active' : ''}" type="button" data-channel="${ch.plugin}"></button>
    `;
    item.querySelector('.channel-toggle').addEventListener('click', () => toggleChannel(agent.id, ch.plugin));
    container.appendChild(item);
  }
}

async function saveConfigureAgent() {
  if (!activeAgentId) return;
  const name = document.getElementById('cfg-name').value.trim();
  const shortName = document.getElementById('cfg-shortname').value.trim();
  const cwd = document.getElementById('cfg-cwd').value.trim();
  const command = document.getElementById('cfg-command').value.trim();
  if (!name || !shortName || !cwd || !command) {
    showToast('All fields are required', 'error');
    return;
  }
  await api.setAgentField(activeAgentId, 'name', name);
  await api.setAgentField(activeAgentId, 'shortName', shortName);
  await api.setAgentField(activeAgentId, 'cwd', cwd);
  await api.setAgentField(activeAgentId, 'command', command);
  const updated = await api.setAgentField(activeAgentId, 'color', selectedColor);
  if (updated) config = updated;
  renderSidebar();
  selectAgent(activeAgentId);
  showToast('Settings saved', 'success');
}

// --- Bug Report ---
function openBugModal() {
  document.getElementById('bug-modal').classList.remove('hidden');
  const input = document.getElementById('bug-input');
  input.value = '';
  input.focus();
}

function closeBugModal() {
  document.getElementById('bug-modal').classList.add('hidden');
}

async function submitBug() {
  const input = document.getElementById('bug-input');
  const text = input.value.trim();
  if (!text) return;

  await api.saveBug({
    description: text,
    agent: activeAgentId || null,
    timestamp: new Date().toISOString(),
  });

  closeBugModal();
  showToast('Bug report saved', 'success');
}

// --- Sidebar Toggle ---
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
  // Re-fit terminal after sidebar width change
  requestAnimationFrame(() => {
    if (activeAgentId) {
      const fitAddon = fitAddons.get(activeAgentId);
      if (fitAddon) {
        fitAddon.fit();
        const terminal = terminals.get(activeAgentId);
        if (terminal) api.resize(activeAgentId, terminal.cols, terminal.rows);
      }
    }
  });
}

document.getElementById('btn-sidebar-toggle').addEventListener('click', toggleSidebar);
document.getElementById('btn-add-agent').addEventListener('click', openAddAgentModal);
document.getElementById('btn-duplicate-agent').addEventListener('click', duplicateAgent);
document.getElementById('btn-welcome-add').addEventListener('click', openAddAgentModal);
document.getElementById('btn-add-cancel').addEventListener('click', closeAddAgentModal);
document.getElementById('btn-add-confirm').addEventListener('click', confirmAddAgent);
document.getElementById('add-agent-backdrop').addEventListener('click', closeAddAgentModal);
document.getElementById('btn-browse-folder').addEventListener('click', async () => {
  const folder = await api.browseFolder();
  if (folder) document.getElementById('add-agent-cwd').value = folder;
});
document.getElementById('add-agent-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); confirmAddAgent(); }
  if (e.key === 'Escape') closeAddAgentModal();
});
document.getElementById('add-agent-name').addEventListener('input', (e) => {
  const cwdInput = document.getElementById('add-agent-cwd');
  // Only auto-fill if cwd is empty or was previously auto-filled
  if (!cwdInput.dataset.manual) {
    const slug = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    cwdInput.value = slug ? `~/agents/${slug}` : '';
  }
});
document.getElementById('add-agent-cwd').addEventListener('input', () => {
  document.getElementById('add-agent-cwd').dataset.manual = 'true';
});
document.getElementById('btn-close-help').addEventListener('click', () => {
  document.getElementById('help-panel').classList.add('hidden');
});
document.getElementById('btn-report-bug').addEventListener('click', openBugModal);
document.getElementById('btn-bug-cancel').addEventListener('click', closeBugModal);
document.getElementById('btn-bug-submit').addEventListener('click', submitBug);
document.getElementById('bug-modal-backdrop').addEventListener('click', closeBugModal);
document.getElementById('bug-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submitBug();
  }
  if (e.key === 'Escape') closeBugModal();
});

// --- Start ---
init();
