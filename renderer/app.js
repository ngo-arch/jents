import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const { api } = window;

// --- CodeMirror Theme ---
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: '#ffffff', fontWeight: '700', fontSize: '1.4em' },
  { tag: tags.heading2, color: '#ffffff', fontWeight: '650', fontSize: '1.2em' },
  { tag: tags.heading3, color: '#e8e8f0', fontWeight: '600' },
  { tag: tags.heading4, color: '#e8e8f0', fontWeight: '600' },
  { tag: tags.emphasis, color: '#b8b8cc', fontStyle: 'italic' },
  { tag: tags.strong, color: '#ffffff', fontWeight: '600' },
  { tag: tags.link, color: '#60a5fa' },
  { tag: tags.url, color: '#5a5a78' },
  { tag: tags.monospace, color: '#e2b0ff' },
  { tag: tags.processingInstruction, color: '#5a5a78' },
  { tag: tags.quote, color: '#9090aa', fontStyle: 'italic' },
  { tag: tags.list, color: '#5a5a78' },
  { tag: tags.meta, color: '#5a5a78' },
  { tag: tags.contentSeparator, color: '#5a5a78' },
]);

const mdTheme = EditorView.theme({
  '&': { backgroundColor: '#0e0918', color: '#d4d4dc' },
  '.cm-content': {
    caretColor: '#ff6b3d',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    fontSize: '15px',
    lineHeight: '1.75',
    padding: '32px 0',
  },
  '.cm-cursor': { borderLeftColor: '#ff6b3d', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(255, 107, 61, 0.15) !important',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.02)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-gutters': { display: 'none' },
  '.cm-scroller': { padding: '0 40px' },
  '.cm-line': { maxWidth: '860px' },
  '&.cm-focused': { outline: 'none' },
}, { dark: true });

// --- State ---
let config = null;
let activeAgentId = null;
let readerOpen = false;
let mobileViewerOpen = false;
let simActiveUdid = null;
let simStream = null;
let notes = [];
let todosData = { goals: [], todos: [] };
let inboxItems = [];
let runsData = [];
const terminals = new Map();
const fitAddons = new Map();
const searchAddons = new Map();
const agentStates = new Map();
const hasUnread = new Map();
const agentHasNotification = new Set(); // agents with active desktop notifications
let terminalFontSize = 13;

// Workspace state
let workspaces = null;
let activeWorkspaceId = null;
const agentWorkspaceMap = new Map(); // agentId -> workspaceId
const workspaceUnread = new Map(); // workspaceId -> boolean

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
  // Load workspaces first
  workspaces = await api.getWorkspaces();
  activeWorkspaceId = workspaces.activeWorkspaceId;

  config = await api.getConfig();

  // Build agent->workspace mapping for the active workspace
  for (const agent of config.agents) {
    agentWorkspaceMap.set(agent.id, activeWorkspaceId);
    const running = await api.isRunning(agent.id);
    agentStates.set(agent.id, running ? 'running' : 'stopped');
    hasUnread.set(agent.id, false);
  }

  await loadNotes();
  await loadTodosData();
  await loadInboxData();
  runsData = await api.listRuns();
  const muted = await api.getMuted();
  updateMuteUI(muted);
  renderWorkspaceStrip();
  renderSidebar();
  setupTerminals();
  setupEventListeners();

  if (config.agents.length > 0) {
    const ws = workspaces.workspaces.find(w => w.id === activeWorkspaceId);
    const lastAgent = ws?.lastSelectedAgentId;
    const targetAgent = (lastAgent && config.agents.some(a => a.id === lastAgent)) ? lastAgent : config.agents[0].id;
    selectAgent(targetAgent);
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
        <div class="pack-name">${escapeHtml(pack.name)}</div>
        <div class="pack-desc">${escapeHtml(pack.desc)}</div>
        <div class="pack-agents">${pack.agents.map(a => escapeHtml(a.name)).join(' + ')}</div>
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

    // Skip if agent with this id already exists in any workspace
    const idCheck = await api.checkAgentId(id);
    if (idCheck.exists) continue;

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
    agentWorkspaceMap.set(id, activeWorkspaceId);
    createTerminalForAgent(newAgent);
  }

  showMainUI();
  renderSidebar();
  if (config.agents.length > 0) selectAgent(config.agents[0].id);
  showToast(`${pack.name} created - ${pack.agents.length} agents ready`, 'success');
}

// --- Workspace Strip ---

const WS_COLORS = ['#5b8def', '#ef6b6b', '#6befa0', '#a06bef', '#f59e0b', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#06b6d4'];
let selectedWsColor = WS_COLORS[0];
let selectedWsIcon = null; // data URL or null
let editingWorkspaceId = null;

function updateMuteUI(muted) {
  const btn = document.getElementById('btn-mute-notifications');
  const iconOn = document.getElementById('mute-icon-on');
  const iconOff = document.getElementById('mute-icon-off');
  if (muted) {
    iconOn.classList.add('hidden');
    iconOff.classList.remove('hidden');
    btn.title = 'Unmute notifications';
    btn.classList.add('muted');
  } else {
    iconOn.classList.remove('hidden');
    iconOff.classList.add('hidden');
    btn.title = 'Mute notifications';
    btn.classList.remove('muted');
  }
}

function renderWorkspaceStrip() {
  const list = document.getElementById('workspace-list');
  list.innerHTML = '';

  if (!workspaces || !workspaces.workspaces) return;

  // Update sidebar header workspace name
  const activeWs = workspaces.workspaces.find(w => w.id === activeWorkspaceId);
  document.getElementById('workspace-name-label').textContent = activeWs ? activeWs.name : 'Workspace';

  const sorted = [...workspaces.workspaces].sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const ws of sorted) {
    const item = document.createElement('button');
    item.className = 'workspace-avatar' + (ws.id === activeWorkspaceId ? ' active' : '');
    item.dataset.workspaceId = ws.id;
    if (ws.icon) {
      item.style.background = `url(${ws.icon}) center/cover no-repeat`;
      item.textContent = '';
    } else {
      item.style.background = ws.color || '#5b8def';
      item.textContent = ws.name.charAt(0).toUpperCase();
    }
    item.title = ws.name;

    if (workspaceUnread.get(ws.id) && ws.id !== activeWorkspaceId) {
      item.classList.add('has-unread');
    }

    item.addEventListener('click', () => switchWorkspace(ws.id));

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showWorkspaceContextMenu(ws, e);
    });

    list.appendChild(item);
  }
}

function showWorkspaceContextMenu(ws, e) {
  const menu = document.getElementById('workspace-context-menu');
  menu.innerHTML = '';
  menu.classList.remove('hidden');

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename';
  renameBtn.addEventListener('click', () => {
    menu.classList.add('hidden');
    openWorkspaceModal('edit', ws);
  });
  menu.appendChild(renameBtn);

  if (workspaces.workspaces.length > 1) {
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'danger';
    deleteBtn.addEventListener('click', () => {
      menu.classList.add('hidden');
      deleteWorkspace(ws.id);
    });
    menu.appendChild(deleteBtn);
  }

  // Position near the click
  menu.style.left = (e.clientX + 4) + 'px';
  menu.style.top = (e.clientY - 4) + 'px';

  // Close on next click anywhere
  const close = () => { menu.classList.add('hidden'); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function toggleWorkspaceDropdown() {
  const dropdown = document.getElementById('workspace-dropdown');
  if (!dropdown.classList.contains('hidden')) {
    dropdown.classList.add('hidden');
    return;
  }
  renderWorkspaceDropdown();
  dropdown.classList.remove('hidden');

  const close = (e) => {
    if (!dropdown.contains(e.target) && e.target.id !== 'workspace-name-btn' && !e.target.closest('#workspace-name-btn')) {
      dropdown.classList.add('hidden');
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function renderWorkspaceDropdown() {
  const list = document.getElementById('workspace-dropdown-list');
  list.innerHTML = '';

  const sorted = [...workspaces.workspaces].sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const ws of sorted) {
    const item = document.createElement('div');
    item.className = 'workspace-dropdown-item' + (ws.id === activeWorkspaceId ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'workspace-dropdown-dot';
    dot.style.background = ws.color || '#5b8def';

    const name = document.createElement('span');
    name.className = 'workspace-dropdown-name';
    name.textContent = ws.name;

    const actions = document.createElement('span');
    actions.className = 'workspace-dropdown-actions';

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.title = 'Rename';
    editBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('workspace-dropdown').classList.add('hidden');
      openWorkspaceModal('edit', ws);
    });
    actions.appendChild(editBtn);

    // Delete button (only if more than 1 workspace)
    if (workspaces.workspaces.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.title = 'Delete';
      delBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M5 6l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13"/></svg>';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('workspace-dropdown').classList.add('hidden');
        deleteWorkspace(ws.id);
      });
      actions.appendChild(delBtn);
    }

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(actions);

    item.addEventListener('click', () => {
      document.getElementById('workspace-dropdown').classList.add('hidden');
      if (ws.id !== activeWorkspaceId) switchWorkspace(ws.id);
    });

    list.appendChild(item);
  }
}

async function switchWorkspace(workspaceId) {
  if (workspaceId === activeWorkspaceId) return;

  // Save current selection
  if (activeAgentId) {
    await api.updateWorkspace(activeWorkspaceId, { lastSelectedAgentId: activeAgentId });
  }

  closeAllPanels();

  // Hide all terminal wrappers
  document.querySelectorAll('.terminal-wrapper').forEach(w => w.classList.remove('active'));

  const oldWorkspaceId = activeWorkspaceId;
  activeWorkspaceId = workspaceId;
  config = await api.setActiveWorkspace(workspaceId);
  workspaces = await api.getWorkspaces();

  // Clear workspace unread
  workspaceUnread.set(workspaceId, false);

  // Build agent->workspace mapping and ensure terminals exist
  for (const agent of config.agents) {
    agentWorkspaceMap.set(agent.id, workspaceId);
    if (!agentStates.has(agent.id)) {
      const running = await api.isRunning(agent.id);
      agentStates.set(agent.id, running ? 'running' : 'stopped');
      hasUnread.set(agent.id, false);
    }
    if (!terminals.has(agent.id)) {
      createTerminalForAgent(agent);
      // Restore buffer for agents that were started previously
      const buf = await api.getBuffer(agent.id);
      if (buf) terminals.get(agent.id).write(buf);
    }
  }

  renderWorkspaceStrip();
  renderSidebar();

  if (config.agents.length > 0) {
    const ws = workspaces.workspaces.find(w => w.id === workspaceId);
    const last = ws?.lastSelectedAgentId;
    const targetAgent = (last && config.agents.some(a => a.id === last)) ? last : config.agents[0].id;
    selectAgent(targetAgent);
    showMainUI();
  } else {
    activeAgentId = null;
    showWelcomeScreen();
  }
}

function openWorkspaceModal(mode, ws) {
  editingWorkspaceId = mode === 'edit' ? ws.id : null;
  const modal = document.getElementById('workspace-modal');
  const title = document.getElementById('workspace-modal-title');
  const nameInput = document.getElementById('workspace-name-input');
  const confirmBtn = document.getElementById('btn-workspace-confirm');

  title.textContent = mode === 'edit' ? 'Edit Workspace' : 'New Workspace';
  confirmBtn.textContent = mode === 'edit' ? 'Save' : 'Create';
  nameInput.value = mode === 'edit' ? ws.name : '';
  selectedWsColor = mode === 'edit' ? (ws.color || WS_COLORS[0]) : WS_COLORS[Math.floor(Math.random() * WS_COLORS.length)];
  selectedWsIcon = mode === 'edit' ? (ws.icon || null) : null;

  renderWsColorPicker();
  updateWsIconPreview();
  modal.classList.remove('hidden');
  nameInput.focus();
}

function renderWsColorPicker() {
  const picker = document.getElementById('workspace-color-picker');
  picker.innerHTML = '';
  for (const color of WS_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'ws-color-swatch' + (color === selectedWsColor ? ' selected' : '');
    swatch.style.background = color;
    swatch.addEventListener('click', () => {
      selectedWsColor = color;
      picker.querySelectorAll('.ws-color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
    });
    picker.appendChild(swatch);
  }
}

function updateWsIconPreview() {
  const preview = document.getElementById('workspace-icon-preview');
  const clearBtn = document.getElementById('btn-workspace-icon-clear');
  if (selectedWsIcon) {
    preview.style.background = `url(${selectedWsIcon}) center/cover no-repeat`;
    preview.textContent = '';
    clearBtn.classList.remove('hidden');
  } else {
    preview.style.background = selectedWsColor;
    preview.textContent = (document.getElementById('workspace-name-input').value || '?').charAt(0).toUpperCase();
    clearBtn.classList.add('hidden');
  }
}

function handleWsIconFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    // Resize to 128x128 to keep data URL small
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
      selectedWsIcon = canvas.toDataURL('image/png');
      updateWsIconPreview();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function closeWorkspaceModal() {
  document.getElementById('workspace-modal').classList.add('hidden');
  editingWorkspaceId = null;
}

async function confirmWorkspaceModal() {
  const name = document.getElementById('workspace-name-input').value.trim();
  if (!name) { showToast('Workspace name is required', 'error'); return; }

  const editId = editingWorkspaceId;
  closeWorkspaceModal();

  if (editId) {
    // Edit mode - rename/recolor
    workspaces = await api.updateWorkspace(editId, { name, color: selectedWsColor, icon: selectedWsIcon || '' });
    renderWorkspaceStrip();
    showToast(`Workspace renamed to "${name}"`, 'success');
  } else {
    // Create mode
    workspaces = await api.createWorkspace({ name, color: selectedWsColor });
    const newWs = workspaces.workspaces[workspaces.workspaces.length - 1];
    renderWorkspaceStrip();
    await switchWorkspace(newWs.id);
    showToast(`Workspace "${name}" created`, 'success');
  }
}

async function deleteWorkspace(workspaceId) {
  const ws = workspaces.workspaces.find(w => w.id === workspaceId);
  if (!ws || workspaces.workspaces.length <= 1) return;

  const confirmed = await showConfirm(
    `Delete "${ws.name}"?`,
    'All agents in this workspace will be stopped. Agent working directories are preserved.',
    'Delete'
  );
  if (!confirmed) return;

  // Clean up terminals for agents in this workspace
  for (const [agentId, wsId] of agentWorkspaceMap) {
    if (wsId === workspaceId) {
      const terminal = terminals.get(agentId);
      if (terminal) terminal.dispose();
      terminals.delete(agentId);
      fitAddons.delete(agentId);
      searchAddons.delete(agentId);
      agentStates.delete(agentId);
      hasUnread.delete(agentId);
      agentWorkspaceMap.delete(agentId);
      const wrapper = document.getElementById(`terminal-${agentId}`);
      if (wrapper) wrapper.remove();
    }
  }

  workspaces = await api.deleteWorkspace(workspaceId);

  if (workspaceId === activeWorkspaceId) {
    activeWorkspaceId = workspaces.activeWorkspaceId;
    config = await api.setActiveWorkspace(activeWorkspaceId);
    // Ensure terminals for the new active workspace
    for (const agent of config.agents) {
      agentWorkspaceMap.set(agent.id, activeWorkspaceId);
      if (!agentStates.has(agent.id)) {
        const running = await api.isRunning(agent.id);
        agentStates.set(agent.id, running ? 'running' : 'stopped');
        hasUnread.set(agent.id, false);
      }
      if (!terminals.has(agent.id)) {
        createTerminalForAgent(agent);
      }
    }
    renderSidebar();
    if (config.agents.length > 0) selectAgent(config.agents[0].id);
    else showWelcomeScreen();
  }

  renderWorkspaceStrip();
}

// --- Sidebar ---
let draggedAgentId = null;

function renderSidebar() {
  const list = document.getElementById('agent-list');
  list.innerHTML = '';

  for (const agent of config.agents) {
    const item = document.createElement('div');
    item.className = 'agent-item';
    item.dataset.agentId = agent.id;
    item.style.setProperty('--agent-color', agent.color);
    item.draggable = true;

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

    // Get latest run summary for this agent
    const latestRun = runsData.find(r => r.agentId === agent.id && r.summary);
    const summaryHtml = latestRun
      ? `<div class="agent-item-summary" title="${escapeHtml(latestRun.summary)}">${escapeHtml(truncate(latestRun.summary, 40))} - ${formatTimeAgo(latestRun.endedAt)}</div>`
      : '';

    const descHtml = agent.description
      ? `<div class="agent-item-desc" title="${escapeHtml(agent.description)}">${escapeHtml(truncate(agent.description, 50))}</div>`
      : '';

    item.innerHTML = `
      <div class="agent-avatar" style="background:${sanitizeColor(agent.color)}">${escapeHtml(agent.shortName)}</div>
      <div class="agent-details">
        <div class="agent-item-name">${escapeHtml(agent.shortName)}</div>
        <div class="agent-item-role">${escapeHtml(agent.name)}</div>
        ${descHtml}
        ${summaryHtml}
        ${badgesHtml}
      </div>
      ${removeHtml}
      <div class="status-dot ${state}${agentHasNotification.has(agent.id) ? ' notified' : ''}" data-status="${escapeHtml(agent.id)}"></div>
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

    // Drag-and-drop reordering
    item.addEventListener('dragstart', (e) => {
      draggedAgentId = agent.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedAgentId = null;
      list.querySelectorAll('.agent-item').forEach(el => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (agent.id !== draggedAgentId) {
        // Clear all, then highlight this one
        list.querySelectorAll('.agent-item').forEach(el => el.classList.remove('drag-over'));
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!draggedAgentId || draggedAgentId === agent.id) return;
      reorderAgent(draggedAgentId, agent.id);
    });

    list.appendChild(item);
  }
}

async function reorderAgent(fromId, toId) {
  const updated = await api.reorderAgents(fromId, toId);
  if (updated) config = updated;
  renderSidebar();
  if (activeAgentId) selectAgent(activeAgentId);
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
  const terminal = new Terminal({ ...TERMINAL_OPTS, fontSize: terminalFontSize });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon((event, uri) => {
    api.openExternal(uri);
  }));

  // File path link provider - hover to underline, click to open (.md in Reader, others externally)
  // Matches paths with directories AND bare filenames with common extensions
  const FILE_PATH_RE = /(?:~\/|\.\/|\/)?(?:[\w@._-]+\/)+[\w@._-]+\.\w{1,10}|(?:^|(?<=\s|`|'|"|:|\(|\[))\.?[\w@_-][\w@._-]*\.(?:md|txt|json|yaml|yml|toml|py|js|ts|jsx|tsx|css|html|sh|sql|csv|xml|env|cfg|conf|ini|log|rs|go|rb|java|c|cpp|h|hpp|swift|kt)\b/g;
  terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const buf = terminal.buffer.active;
      // Collect wrapped line segments to handle paths/files that span wrapped lines
      const segments = []; // { lineY (1-based), text, offset (char offset in combined string) }
      let startY = y;
      // Walk up to find start of wrapped chain
      while (startY > 1) {
        const prev = buf.getLine(startY - 1);
        if (!prev || !prev.isWrapped) break;
        startY--;
      }
      // Walk down to collect all wrapped segments
      let combined = '';
      for (let ly = startY; ; ly++) {
        const l = buf.getLine(ly - 1);
        if (!l) break;
        if (ly > startY && !l.isWrapped) break;
        const t = l.translateToString(true);
        segments.push({ lineY: ly, text: t, offset: combined.length });
        combined += t;
      }

      const links = [];
      let m;
      FILE_PATH_RE.lastIndex = 0;
      while ((m = FILE_PATH_RE.exec(combined)) !== null) {
        const matchStart = m.index;
        const matchEnd = m.index + m[0].length;
        // Skip if it looks like a URL (matched by WebLinksAddon)
        const before = combined.slice(Math.max(0, matchStart - 10), matchStart);
        if (/https?:\/\/\S*$/.test(before)) continue;
        // Map combined-string positions back to line/column
        let startSeg = segments[0], endSeg = segments[0];
        for (const seg of segments) {
          if (matchStart >= seg.offset) startSeg = seg;
          if (matchEnd > seg.offset) endSeg = seg;
        }
        const startX = matchStart - startSeg.offset + 1;
        const endX = matchEnd - endSeg.offset;
        links.push({
          range: {
            start: { x: startX, y: startSeg.lineY },
            end: { x: endX, y: endSeg.lineY },
          },
          text: m[0],
          activate: async (_event, linkText) => {
            const resolved = await api.resolveFilePath(agent.id, linkText);
            if (!resolved) {
              showToast('File not found: ' + linkText, 'error');
              return;
            }
            if (resolved.endsWith('.md')) {
              openMarkdownFile(resolved);
            } else {
              api.openFile(resolved);
            }
          },
        });
      }
      // Only return links that touch the requested line y
      const relevant = links.filter(l => l.range.start.y <= y && l.range.end.y >= y);
      callback(relevant.length > 0 ? relevant : undefined);
    }
  });

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
  searchAddons.set(agent.id, searchAddon);

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
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) return;
  activeAgentId = agentId;

  // Clear unread
  hasUnread.set(agentId, false);
  const sidebarItem = document.querySelector(`.agent-item[data-agent-id="${agentId}"]`);
  if (sidebarItem) sidebarItem.classList.remove('has-unread');

  // Update sidebar active state
  document.querySelectorAll('.agent-item').forEach(item => {
    item.classList.toggle('active', item.dataset.agentId === agentId);
  });

  // Update toolbar
  const agentNameEl = document.getElementById('agent-name');
  if (agentNameEl) agentNameEl.textContent = agent.name;

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

  // Close context-dependent panels when switching agents
  document.getElementById('logs-panel').classList.add('hidden');
  document.getElementById('configure-panel').classList.add('hidden');

  // Reset armed confirmation states
  stopArmed = false;
  clearArmed = false;
  clearTimeout(stopConfirmTimeout);
  clearTimeout(clearConfirmTimeout);
  document.getElementById('btn-stop').classList.remove('armed');
  document.getElementById('btn-stop').title = 'Stop session';
  document.getElementById('btn-clear').classList.remove('armed');
  document.getElementById('btn-clear').title = 'Clear terminal';

  // Persist last-selected agent for the workspace
  if (activeWorkspaceId) {
    api.updateWorkspace(activeWorkspaceId, { lastSelectedAgentId: agentId });
  }
}

function setAgentState(agentId, state) {
  agentStates.set(agentId, state);
  if (agentId === activeAgentId) updateStatusUI(agentId);
  const dot = document.querySelector(`.status-dot[data-status="${agentId}"]`);
  if (dot) dot.className = `status-dot ${state}${agentHasNotification.has(agentId) ? ' notified' : ''}`;
}

function updateStatusUI(agentId) {
  const state = agentStates.get(agentId) || 'stopped';
  const badge = document.getElementById('agent-status');
  if (badge) {
    const labels = { running: 'Running', stopped: 'Stopped', error: 'Exited' };
    badge.textContent = labels[state] || state;
    badge.className = state;
  }

  const dot = document.querySelector(`.status-dot[data-status="${agentId}"]`);
  if (dot) dot.className = `status-dot ${state}${agentHasNotification.has(agentId) ? ' notified' : ''}`;

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
  for (const id of ['logs-panel', 'files-panel', 'notepad-panel', 'configure-panel', 'help-panel', 'crons-panel', 'todos-panel', 'inbox-panel']) {
    document.getElementById(id).classList.add('hidden');
  }
}

function toggleMobileViewer() {
  const panel = document.getElementById('mobile-viewer');
  const btn = document.getElementById('btn-mobile-viewer');
  if (mobileViewerOpen) {
    panel.classList.add('hidden');
    mobileViewerOpen = false;
    btn.classList.remove('active');
    stopSimStream();
    if (activeAgentId) {
      const fitAddon = fitAddons.get(activeAgentId);
      if (fitAddon) requestAnimationFrame(() => fitAddon.fit());
    }
  } else {
    panel.classList.remove('hidden');
    mobileViewerOpen = true;
    btn.classList.add('active');
    refreshSimDeviceList();
    if (activeAgentId) {
      const fitAddon = fitAddons.get(activeAgentId);
      if (fitAddon) requestAnimationFrame(() => fitAddon.fit());
    }
  }
}

async function refreshSimDeviceList() {
  const select = document.getElementById('sim-device-select');
  const devices = await api.simListDevices();
  select.innerHTML = '';
  if (devices.length === 0) {
    select.innerHTML = '<option value="">No simulators available</option>';
    stopSimStream();
    return;
  }
  // Group: booted first, then shutdown
  const booted = devices.filter(d => d.state === 'Booted');
  const shutdown = devices.filter(d => d.state === 'Shutdown');
  for (const d of [...booted, ...shutdown]) {
    const opt = document.createElement('option');
    opt.value = d.udid;
    const runtime = d.runtime.replace(/.*SimRuntime\./, '').replace(/-/g, ' ');
    opt.textContent = `${d.name} (${runtime})${d.state === 'Booted' ? ' - Running' : ''}`;
    select.appendChild(opt);
  }
  // Auto-select first booted device and start polling
  if (booted.length > 0) {
    select.value = booted[0].udid;
    startSimStream(booted[0].udid);
  } else {
    stopSimStream();
  }
}

async function startSimStream(udid) {
  stopSimStream();
  simActiveUdid = udid;
  const video = document.getElementById('sim-screen-video');
  const placeholder = document.getElementById('sim-placeholder');
  const dot = document.getElementById('mobile-live-dot');

  const sourceId = await api.simGetSourceId();
  if (!sourceId) {
    placeholder.classList.remove('hidden');
    video.classList.remove('active');
    dot.classList.remove('active');
    return;
  }

  try {
    simStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 30,
        },
      },
    });
    video.srcObject = simStream;
    video.classList.add('active');
    placeholder.classList.add('hidden');
    dot.classList.add('active');
  } catch {
    placeholder.classList.remove('hidden');
    video.classList.remove('active');
    dot.classList.remove('active');
  }
}

function stopSimStream() {
  if (simStream) {
    simStream.getTracks().forEach(t => t.stop());
    simStream = null;
  }
  const video = document.getElementById('sim-screen-video');
  video.srcObject = null;
  video.classList.remove('active');
  simActiveUdid = null;
  document.getElementById('mobile-live-dot').classList.remove('active');
  document.getElementById('sim-placeholder').classList.remove('hidden');
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

async function sendNote(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !activeAgentId) return;

  const bracketedText = `\x1b[200~${note.text}\x1b[201~\r`;

  if (agentStates.get(activeAgentId) !== 'running') {
    await startAgent(activeAgentId);
    await waitForAgentReady(activeAgentId);
  }
  api.write(activeAgentId, bracketedText);
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
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeColor(color) {
  if (!color) return '';
  // Allow hex colors, rgb/rgba, hsl/hsla, and CSS variables
  if (/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|var\(--.+\))$/.test(color)) return color;
  return '';
}

// --- Permission Modes ---
const PERMISSION_MODES = [
  { id: 'default',           label: 'Manual',        desc: 'Approve every action manually' },
  { id: 'auto',              label: 'Auto',           desc: 'AI classifiers approve safe actions' },
  { id: 'acceptEdits',       label: 'Accept Edits',   desc: 'Auto-accept file edits only' },
  { id: 'plan',              label: 'Plan',            desc: 'Plan only, no execution' },
  { id: 'bypassPermissions', label: 'YOLO',            desc: 'Skip all permission checks' },
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
  badge.title = `Permission mode: ${def.label} (saved per agent, applied on start)`;
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
    const savedIndicator = mode.id === currentMode ? '<span class="mode-saved">saved</span>' : '';
    item.innerHTML = `
      <span class="mode-menu-label">${mode.label} ${savedIndicator}</span>
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
  const def = PERMISSION_MODES.find(m => m.id === mode);
  if (mode === 'bypassPermissions') {
    showToast('YOLO mode: all permission checks bypassed', 'warn');
  } else {
    showToast(`${def.label} mode saved for this agent`, 'success');
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
let allFilesCache = [];

async function toggleFiles() {
  const panel = document.getElementById('files-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  closeAllPanels();
  const searchEl = document.getElementById('files-search');
  if (searchEl) searchEl.value = '';
  await loadFiles();
  panel.classList.remove('hidden');
}

async function loadFiles() {
  allFilesCache = await api.getRecentFiles();
  const filterEl = document.getElementById('files-agent-filter');

  // Build unique agents from files
  const agentMap = new Map();
  for (const f of allFilesCache) {
    if (!agentMap.has(f.agentId)) agentMap.set(f.agentId, f.agentName);
  }

  // Populate dropdown - default to active agent if it has files
  const prevValue = filterEl.value;
  filterEl.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '__all__';
  allOpt.textContent = 'All Agents';
  filterEl.appendChild(allOpt);
  for (const [id, name] of agentMap) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    filterEl.appendChild(opt);
  }

  // Default to active agent if it has files, otherwise keep previous or show all
  if (prevValue && agentMap.has(prevValue)) {
    filterEl.value = prevValue;
  } else if (activeAgentId && agentMap.has(activeAgentId)) {
    filterEl.value = activeAgentId;
  } else {
    filterEl.value = '__all__';
  }

  renderFiles();
}

function renderFiles() {
  const filterEl = document.getElementById('files-agent-filter');
  const filterValue = filterEl.value;
  const searchQuery = (document.getElementById('files-search')?.value || '').toLowerCase();
  let filtered = filterValue === '__all__' ? allFilesCache : allFilesCache.filter(f => f.agentId === filterValue);
  if (searchQuery) {
    filtered = filtered.filter(f => f.name.toLowerCase().includes(searchQuery) || f.relativePath.toLowerCase().includes(searchQuery));
  }
  const listEl = document.getElementById('files-list');
  listEl.innerHTML = '';

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="files-empty"><p>No files found</p></div>';
    return;
  }

  const showAgentBadge = filterValue === '__all__';

  for (const file of filtered) {
    const item = document.createElement('div');
    item.className = 'file-item';

    const ext = file.name.split('.').pop() || '?';
    const timeAgo = formatTimeAgo(file.mtime);
    const size = formatSize(file.size);

    const agentBadge = showAgentBadge
      ? `<span class="file-agent-badge" style="background:${sanitizeColor(file.agentColor)}">${escapeHtml(file.agentName)}</span>`
      : '';

    item.innerHTML = `
      <div class="file-icon" data-ext="${escapeHtml(ext)}">${escapeHtml(ext.slice(0, 3))}</div>
      <div class="file-details">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="file-path">${escapeHtml(file.relativePath)}</div>
        <div class="file-meta">
          ${agentBadge}
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

    item.addEventListener('click', (e) => {
      if (e.target.closest('.file-action-btn')) return;
      if (file.name.endsWith('.md')) {
        openMarkdownFile(file.path);
      } else {
        api.openFile(file.path);
      }
    });

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
  let text = stripAnsi(rawText);

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

    // Skip Claude Code welcome banner and UI chrome
    if (/^(Hey!|Hello!|Hi!)?\s*What can I help/i.test(trimmed)) continue;
    if (/^[⏵⏴►▶]\s*(accept|auto|plan|default|manual|bypassPermissions|YOLO)/i.test(trimmed)) continue;
    if (/^\s*(high|low|medium)\s*[·•]\s*\/effort/i.test(trimmed)) continue;
    if (/^(shift\+tab|tab)\s+to\s+(cycle|switch)/i.test(trimmed)) continue;
    if (/^❯\s*$/.test(trimmed)) continue;

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

function extractLastResponse(rawText) {
  const stripped = stripAnsi(rawText);

  const lines = stripped.split('\n');

  // Find the last user prompt line that has actual user input after the ❯/> marker
  // Skip empty prompts (just "❯" with nothing after) and Claude UI chrome
  let lastPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    // Must have ❯ or > followed by real user text (not just whitespace)
    if (/^[❯>]\s+\S/.test(trimmed)) {
      // Skip if it's just the prompt character echoed with no real content
      const afterPrompt = trimmed.replace(/^[❯>]\s+/, '');
      if (afterPrompt.length > 0) {
        lastPromptIdx = i;
        break;
      }
    }
  }

  if (lastPromptIdx < 0) {
    // No prompt with user input found - fall back to full buffer
    return rawText;
  }

  // Everything after the prompt line is the response
  let startIdx = lastPromptIdx + 1;

  // Skip blank lines and separator lines after the prompt
  while (startIdx < lines.length) {
    const trimmed = lines[startIdx].trim();
    if (trimmed === '') { startIdx++; continue; }
    if (/^[─═┄┈╌╍━┅┉╺╸\s]+$/.test(trimmed)) { startIdx++; continue; }
    break;
  }

  return lines.slice(startIdx).join('\n');
}

function openReader() {
  if (!activeAgentId) return;

  const rawText = getTerminalText(activeAgentId);
  if (!rawText.trim()) return;

  const lastResponse = extractLastResponse(rawText);
  const markdown = extractMarkdown(lastResponse);

  showReaderContent('Reader View', markdown);
}

function showReaderContent(title, markdown) {
  marked.setOptions({ breaks: false, gfm: true });

  const html = DOMPurify.sanitize(marked.parse(markdown));
  const contentEl = document.getElementById('reader-content');
  contentEl.innerHTML = `<div class="prose">${html}</div>`;
  contentEl.dataset.rawMarkdown = markdown;
  readerEditing = false;

  // Ensure source pane is hidden
  document.getElementById('reader-source').style.display = 'none';
  contentEl.style.display = 'block';
  document.getElementById('reader-mode-toggle').style.display = 'none';

  // Reset toolbar buttons
  document.getElementById('reader-title').textContent = title;
  document.getElementById('reader-title').classList.remove('unsaved');
  document.getElementById('btn-reader-edit').style.display = 'none';
  document.getElementById('btn-reader-save').style.display = 'none';
  document.getElementById('btn-reader-cancel-edit').style.display = 'none';
  document.getElementById('btn-reader-copy').style.display = 'flex';
  document.getElementById('btn-reader-copy-slack').style.display = 'flex';

  readerOpen = true;
  document.getElementById('reader').classList.remove('hidden');
}

let readerFilePath = null;
let readerEditing = false;
let readerOriginalContent = '';
let readerMode = 'preview';
let cmEditor = null;
let cmUnsaved = false;

async function openMarkdownFile(filePath) {
  const result = await api.readFile(filePath);
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }
  readerFilePath = filePath;
  readerOriginalContent = result.content;
  readerMode = 'preview';
  showReaderContent(result.name, result.content);
  document.getElementById('btn-reader-edit').style.display = 'flex';
}

// --- CodeMirror Source Editor ---

function wrapSelection(marker) {
  return (view) => {
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
      view.dispatch({ changes: { from, to, insert: selected.slice(marker.length, -marker.length) } });
    } else {
      view.dispatch({
        changes: { from, to, insert: marker + selected + marker },
        selection: { anchor: from + marker.length, head: to + marker.length },
      });
    }
    return true;
  };
}

function insertLink(view) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const linkText = selected || 'text';
  const insert = `[${linkText}](url)`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + linkText.length + 3, head: from + linkText.length + 6 },
  });
  return true;
}

function smartListEnter(view) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;

  // Task list: "  - [ ] text" or "  - [x] text"
  const taskMatch = text.match(/^(\s*)([-*+])\s\[[ x]\]\s(.*)$/);
  if (taskMatch) {
    const [, indent, marker, content] = taskMatch;
    if (content.trim() === '') {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
      return true;
    }
    view.dispatch({ changes: { from, to: from, insert: `\n${indent}${marker} [ ] ` } });
    return true;
  }

  // Ordered list: "  1. text"
  const orderedMatch = text.match(/^(\s*)(\d+)\.\s(.*)$/);
  if (orderedMatch) {
    const [, indent, num, content] = orderedMatch;
    if (content.trim() === '') {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
      return true;
    }
    const nextNum = parseInt(num) + 1;
    view.dispatch({ changes: { from, to: from, insert: `\n${indent}${nextNum}. ` } });
    return true;
  }

  // Unordered list: "  - text"
  const unorderedMatch = text.match(/^(\s*)([-*+])\s(.*)$/);
  if (unorderedMatch) {
    const [, indent, marker, content] = unorderedMatch;
    if (content.trim() === '') {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
      return true;
    }
    view.dispatch({ changes: { from, to: from, insert: `\n${indent}${marker} ` } });
    return true;
  }

  return false;
}

function indentListItem(view) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  if (/^\s*([-*+]|\d+\.)\s/.test(line.text)) {
    view.dispatch({ changes: { from: line.from, to: line.from, insert: '  ' } });
    return true;
  }
  return false;
}

function dedentListItem(view) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const leadingMatch = line.text.match(/^(\s+)/);
  if (leadingMatch && /^\s*([-*+]|\d+\.)\s/.test(line.text)) {
    const remove = Math.min(2, leadingMatch[1].length);
    view.dispatch({ changes: { from: line.from, to: line.from + remove } });
    return true;
  }
  return false;
}

function createOrUpdateEditor(markdownContent) {
  const parent = document.getElementById('reader-source');

  if (cmEditor) {
    cmEditor.dispatch({
      changes: { from: 0, to: cmEditor.state.doc.length, insert: markdownContent },
    });
    cmUnsaved = false;
    return;
  }

  const startState = EditorState.create({
    doc: markdownContent,
    extensions: [
      history(),
      keymap.of([
        { key: 'Mod-b', run: wrapSelection('**') },
        { key: 'Mod-i', run: wrapSelection('*') },
        { key: 'Mod-k', run: insertLink },
        { key: 'Mod-Shift-x', run: wrapSelection('~~') },
        { key: 'Mod-Shift-c', run: wrapSelection('`') },
        { key: 'Enter', run: smartListEnter },
        { key: 'Tab', run: indentListItem },
        { key: 'Shift-Tab', run: dedentListItem },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdHighlight),
      mdTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          cmUnsaved = true;
          document.getElementById('reader-title').classList.add('unsaved');
        }
      }),
    ],
  });

  cmEditor = new EditorView({ state: startState, parent });
  cmUnsaved = false;
}

function enterReaderEdit() {
  if (!readerFilePath) return;
  readerEditing = true;
  readerMode = 'source';

  createOrUpdateEditor(readerOriginalContent);

  document.getElementById('reader-content').style.display = 'none';
  document.getElementById('reader-source').style.display = 'flex';

  document.getElementById('reader-mode-toggle').style.display = 'flex';
  document.getElementById('btn-reader-edit').style.display = 'none';
  document.getElementById('btn-reader-copy').style.display = 'none';
  document.getElementById('btn-reader-copy-slack').style.display = 'none';
  document.getElementById('btn-reader-save').style.display = 'flex';
  document.getElementById('btn-reader-cancel-edit').style.display = 'flex';

  document.getElementById('btn-mode-source').classList.add('active');
  document.getElementById('btn-mode-preview').classList.remove('active');

  cmEditor.focus();
}

function switchReaderMode(mode) {
  if (mode === readerMode) return;
  readerMode = mode;

  if (mode === 'source') {
    document.getElementById('reader-content').style.display = 'none';
    document.getElementById('reader-source').style.display = 'flex';
    document.getElementById('btn-mode-source').classList.add('active');
    document.getElementById('btn-mode-preview').classList.remove('active');
    cmEditor.focus();
  } else {
    const currentMarkdown = cmEditor.state.doc.toString();
    marked.setOptions({ breaks: false, gfm: true });
    const html = DOMPurify.sanitize(marked.parse(currentMarkdown));
    const contentEl = document.getElementById('reader-content');
    contentEl.innerHTML = `<div class="prose">${html}</div>`;
    contentEl.dataset.rawMarkdown = currentMarkdown;
    attachCheckboxHandlers(contentEl);

    contentEl.style.display = 'block';
    document.getElementById('reader-source').style.display = 'none';
    document.getElementById('btn-mode-source').classList.remove('active');
    document.getElementById('btn-mode-preview').classList.add('active');
  }
}

function attachCheckboxHandlers(contentEl) {
  if (!readerEditing || !cmEditor) return;
  const checkboxes = contentEl.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((cb, index) => {
    cb.disabled = false;
    cb.addEventListener('change', () => {
      let md = cmEditor.state.doc.toString();
      let count = 0;
      md = md.replace(/\[([ x])\]/g, (match, state) => {
        if (count === index) {
          count++;
          return cb.checked ? '[x]' : '[ ]';
        }
        count++;
        return match;
      });
      cmEditor.dispatch({
        changes: { from: 0, to: cmEditor.state.doc.length, insert: md },
      });
      saveReaderEdit();
    });
  });
}

async function saveReaderEdit() {
  if (!readerFilePath || !cmEditor) return;

  const markdown = cmEditor.state.doc.toString();
  const result = await api.writeFile(readerFilePath, markdown);
  if (result.error) {
    showToast('Save failed: ' + result.error, 'error');
    return;
  }

  readerOriginalContent = markdown;
  cmUnsaved = false;
  document.getElementById('reader-title').classList.remove('unsaved');

  // If in preview mode, update the preview
  if (readerMode === 'preview') {
    marked.setOptions({ breaks: false, gfm: true });
    const html = DOMPurify.sanitize(marked.parse(markdown));
    const contentEl = document.getElementById('reader-content');
    contentEl.innerHTML = `<div class="prose">${html}</div>`;
    contentEl.dataset.rawMarkdown = markdown;
    attachCheckboxHandlers(contentEl);
  }

  showToast('Saved', 'success');
}

function cancelReaderEdit() {
  readerEditing = false;
  readerMode = 'preview';
  cmUnsaved = false;

  document.getElementById('reader-source').style.display = 'none';
  document.getElementById('reader-content').style.display = 'block';
  document.getElementById('reader-mode-toggle').style.display = 'none';

  marked.setOptions({ breaks: false, gfm: true });
  const contentEl = document.getElementById('reader-content');
  contentEl.innerHTML = `<div class="prose">${DOMPurify.sanitize(marked.parse(readerOriginalContent))}</div>`;
  contentEl.dataset.rawMarkdown = readerOriginalContent;

  document.getElementById('btn-reader-edit').style.display = readerFilePath ? 'flex' : 'none';
  document.getElementById('btn-reader-copy').style.display = 'flex';
  document.getElementById('btn-reader-copy-slack').style.display = 'flex';
  document.getElementById('btn-reader-save').style.display = 'none';
  document.getElementById('btn-reader-cancel-edit').style.display = 'none';
  document.getElementById('reader-title').classList.remove('unsaved');
}

function closeReader() {
  readerOpen = false;
  readerEditing = false;
  readerFilePath = null;
  readerOriginalContent = '';
  readerMode = 'preview';
  cmUnsaved = false;

  document.getElementById('reader').classList.add('hidden');
  document.getElementById('reader-source').style.display = 'none';
  document.getElementById('reader-content').style.display = 'block';
  document.getElementById('reader-mode-toggle').style.display = 'none';
  document.getElementById('reader-title').classList.remove('unsaved');

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
  let markdown;
  if (readerEditing && cmEditor) {
    markdown = cmEditor.state.doc.toString();
  } else {
    markdown = document.getElementById('reader-content').dataset.rawMarkdown || '';
  }
  const btn = document.getElementById('btn-reader-copy');

  try {
    await navigator.clipboard.writeText(markdown);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch {
    showToast('Copy failed', 'error');
  }
}

async function copyForSlack() {
  let proseEl;
  if (readerEditing && readerMode === 'source' && cmEditor) {
    const tempDiv = document.createElement('div');
    tempDiv.className = 'prose';
    marked.setOptions({ breaks: false, gfm: true });
    tempDiv.innerHTML = DOMPurify.sanitize(marked.parse(cmEditor.state.doc.toString()));
    proseEl = tempDiv;
  } else {
    proseEl = document.getElementById('reader-content').querySelector('.prose');
  }
  const btn = document.getElementById('btn-reader-copy-slack');
  if (!proseEl) return;

  // Clone the prose HTML and clean it up for Slack pasting
  const clone = proseEl.cloneNode(true);

  // Convert headers to bold paragraphs (Slack messages don't render h1-h6)
  clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = h.textContent;
    p.appendChild(strong);
    h.replaceWith(p);
  });

  const html = clone.innerHTML;
  let plainText;
  if (readerEditing && cmEditor) {
    plainText = cmEditor.state.doc.toString();
  } else {
    plainText = document.getElementById('reader-content').dataset.rawMarkdown || proseEl.innerText;
  }

  try {
    const htmlBlob = new Blob([html], { type: 'text/html' });
    const textBlob = new Blob([plainText], { type: 'text/plain' });
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
    ]);
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

      // Mark workspace-level unread for agents in other workspaces
      const agentWsId = agentWorkspaceMap.get(agentId);
      if (agentWsId && agentWsId !== activeWorkspaceId) {
        workspaceUnread.set(agentWsId, true);
        const wsAvatar = document.querySelector(`.workspace-avatar[data-workspace-id="${agentWsId}"]`);
        if (wsAvatar) wsAvatar.classList.add('has-unread');
      }
    } else {
      // Ensure the active agent never shows an unread badge
      hasUnread.set(agentId, false);
      const item = document.querySelector(`.agent-item[data-agent-id="${agentId}"]`);
      if (item) item.classList.remove('has-unread');
    }
  });

  // PTY exit
  api.onExit(async (agentId, exitCode) => {
    setAgentState(agentId, exitCode === 0 ? 'stopped' : 'error');

    const terminal = terminals.get(agentId);
    if (terminal) {
      terminal.writeln('');
      terminal.writeln(`  \x1b[2mSession ended (exit code: ${exitCode}). Press Start or Cmd+R to restart.\x1b[0m`);
    }

    // Refresh runs data and update sidebar summary for this agent
    runsData = await api.listRuns();
    const agentItem = document.querySelector(`.agent-item[data-agent-id="${agentId}"]`);
    if (agentItem) {
      const latestRun = runsData.find(r => r.agentId === agentId && r.summary);
      const detailsEl = agentItem.querySelector('.agent-details');
      const existingSummary = detailsEl?.querySelector('.agent-item-summary');
      if (existingSummary) existingSummary.remove();
      if (latestRun && detailsEl) {
        const roleEl = detailsEl.querySelector('.agent-item-role');
        if (roleEl) {
          const sumEl = document.createElement('div');
          sumEl.className = 'agent-item-summary';
          sumEl.title = latestRun.summary;
          sumEl.textContent = `${truncate(latestRun.summary, 40)} - ${formatTimeAgo(latestRun.endedAt)}`;
          roleEl.after(sumEl);
        }
      }
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
  document.getElementById('btn-reader-copy-slack').addEventListener('click', copyForSlack);
  document.getElementById('btn-reader-edit').addEventListener('click', enterReaderEdit);
  document.getElementById('btn-reader-save').addEventListener('click', saveReaderEdit);
  document.getElementById('btn-reader-cancel-edit').addEventListener('click', cancelReaderEdit);
  document.getElementById('btn-mode-source').addEventListener('click', () => switchReaderMode('source'));
  document.getElementById('btn-mode-preview').addEventListener('click', () => switchReaderMode('preview'));
  // Mobile viewer (iOS Simulator)
  document.getElementById('btn-mobile-viewer').addEventListener('click', toggleMobileViewer);
  document.getElementById('btn-mobile-close').addEventListener('click', toggleMobileViewer);
  document.getElementById('btn-sim-refresh').addEventListener('click', refreshSimDeviceList);
  document.getElementById('btn-sim-boot').addEventListener('click', async () => {
    const select = document.getElementById('sim-device-select');
    const udid = select.value;
    if (!udid) return;
    const result = await api.simBoot(udid);
    if (result.ok) {
      showToast('Simulator booting...', 'success');
      // Wait a moment for boot, then refresh and start polling
      setTimeout(async () => {
        await refreshSimDeviceList();
      }, 3000);
    } else {
      showToast(result.error || 'Failed to boot', 'error');
      // May already be booted - try refreshing
      await refreshSimDeviceList();
    }
  });
  document.getElementById('sim-device-select').addEventListener('change', (e) => {
    const udid = e.target.value;
    if (!udid) { stopSimStream(); return; }
    // Check if this device is booted by looking at the option text
    const opt = e.target.options[e.target.selectedIndex];
    if (opt && opt.textContent.includes('Running')) {
      startSimStream(udid);
    } else {
      stopSimStream();
    }
  });
  // Click on mirror video -> click in Simulator.app at mapped screen coordinates
  document.getElementById('sim-screen-video').addEventListener('click', async (e) => {
    if (!simActiveUdid) return;
    const img = e.target;
    const rect = img.getBoundingClientRect();
    // Relative position within the mirror (0-1)
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    // Get Simulator window bounds
    const win = await api.simWindowInfo();
    if (!win) return;
    // Map to screen coordinates (28px title bar offset)
    const titleBar = 28;
    const screenX = win.x + relX * win.w;
    const screenY = win.y + titleBar + relY * (win.h - titleBar);
    await api.simClick(screenX, screenY);
  });

  document.getElementById('btn-configure').addEventListener('click', toggleConfigure);
  document.getElementById('btn-close-configure').addEventListener('click', () => {
    document.getElementById('configure-panel').classList.add('hidden');
    if (activeAgentId) terminals.get(activeAgentId)?.focus();
  });
  document.getElementById('btn-config-guide').addEventListener('click', () => {
    toggleHelp();
  });
  document.getElementById('btn-crons').addEventListener('click', toggleCrons);
  document.getElementById('btn-close-crons').addEventListener('click', () => {
    document.getElementById('crons-panel').classList.add('hidden');
    if (activeAgentId) terminals.get(activeAgentId)?.focus();
  });
  document.getElementById('btn-crons-refresh').addEventListener('click', () => {
    if (cronsActiveTab === 'jobs') loadCronsList();
    else loadCronsHistory();
  });
  document.getElementById('btn-crons-log-back').addEventListener('click', closeCronLog);
  document.querySelectorAll('.crons-tab').forEach(tab => {
    tab.addEventListener('click', () => switchCronsTab(tab.dataset.tab));
  });

  // Todos panel
  document.getElementById('btn-todos').addEventListener('click', toggleTodos);
  document.getElementById('btn-close-todos').addEventListener('click', () => {
    document.getElementById('todos-panel').classList.add('hidden');
  });
  document.getElementById('btn-todo-add').addEventListener('click', addTodo);
  document.getElementById('todo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTodo(); }
  });
  document.getElementById('btn-manage-goals').addEventListener('click', showGoalsEditor);
  document.getElementById('btn-goals-back').addEventListener('click', hideGoalsEditor);
  document.getElementById('btn-goal-add').addEventListener('click', addGoal);
  document.getElementById('goal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addGoal(); }
  });

  // Inbox panel
  document.getElementById('btn-inbox').addEventListener('click', toggleInbox);
  document.getElementById('btn-close-inbox').addEventListener('click', () => {
    document.getElementById('inbox-panel').classList.add('hidden');
  });
  document.getElementById('btn-inbox-clear').addEventListener('click', clearInbox);

  // Inbox live events
  api.onInbox((item) => {
    inboxItems.unshift(item);
    updateInboxBadge();
    // If inbox panel is open, re-render
    if (!document.getElementById('inbox-panel').classList.contains('hidden')) {
      renderInboxList();
    }
  });

  document.getElementById('btn-files').addEventListener('click', toggleFiles);
  document.getElementById('btn-close-files').addEventListener('click', () => {
    document.getElementById('files-panel').classList.add('hidden');
    if (activeAgentId) terminals.get(activeAgentId)?.focus();
  });
  document.getElementById('btn-files-finder').addEventListener('click', () => {
    if (activeAgentId) api.openAgentCwd(activeAgentId);
  });
  document.getElementById('btn-files-refresh').addEventListener('click', loadFiles);
  document.getElementById('files-agent-filter').addEventListener('change', renderFiles);
  document.getElementById('files-search').addEventListener('input', renderFiles);

  // Logs panel
  document.getElementById('btn-close-logs').addEventListener('click', () => {
    document.getElementById('logs-panel').classList.add('hidden');
    if (activeAgentId) terminals.get(activeAgentId)?.focus();
  });
  document.getElementById('btn-logs-back').addEventListener('click', showLogsWithRuns);
  document.getElementById('btn-log-copy').addEventListener('click', copyLogContent);
  document.getElementById('btn-log-send').addEventListener('click', sendLogToAgent);

  // Notification click -> focus agent (may need workspace switch)
  api.onFocus((agentId, wsId) => {
    if (wsId && wsId !== activeWorkspaceId) {
      switchWorkspace(wsId).then(() => selectAgent(agentId));
    } else {
      selectAgent(agentId);
    }
  });

  // Desktop notification state -> status dot color
  api.onNotification((agentId, active) => {
    if (active) {
      agentHasNotification.add(agentId);
    } else {
      agentHasNotification.delete(agentId);
    }
    const dot = document.querySelector(`.status-dot[data-status="${agentId}"]`);
    if (dot) {
      const state = agentStates.get(agentId) || 'stopped';
      dot.className = `status-dot ${state}${active ? ' notified' : ''}`;
    }
  });


  // Terminal resize observer - handles window resize, panel open/close, sidebar toggle
  const termContainer = document.getElementById('terminal-container');
  const resizeObs = new ResizeObserver(() => {
    if (!activeAgentId) return;
    const fitAddon = fitAddons.get(activeAgentId);
    if (fitAddon) {
      fitAddon.fit();
      const terminal = terminals.get(activeAgentId);
      if (terminal && agentStates.get(activeAgentId) === 'running') {
        api.resize(activeAgentId, terminal.cols, terminal.rows);
      }
    }
  });
  resizeObs.observe(termContainer);

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
    // Escape closes overlays/panels in priority order
    if (e.key === 'Escape') {
      // Modals and overlays first (highest z-index)
      if (!document.getElementById('add-agent-modal').classList.contains('hidden')) { closeAddAgentModal(); return; }
      if (!document.getElementById('confirm-modal').classList.contains('hidden')) { closeConfirm(false); return; }
      if (!document.getElementById('bug-modal').classList.contains('hidden')) { closeBugModal(); return; }
      if (!document.getElementById('workspace-dropdown').classList.contains('hidden')) { document.getElementById('workspace-dropdown').classList.add('hidden'); return; }
      if (!document.getElementById('workspace-modal').classList.contains('hidden')) { closeWorkspaceModal(); return; }
      if (!document.getElementById('workspace-context-menu').classList.contains('hidden')) { document.getElementById('workspace-context-menu').classList.add('hidden'); return; }
      if (commandPaletteOpen) { closeCommandPalette(); return; }
      if (terminalSearchOpen) { closeTerminalSearch(); return; }
      if (readerOpen) { closeReader(); return; }
      if (mobileViewerOpen) { toggleMobileViewer(); return; }
      // Side panels
      const panelIds = ['configure-panel', 'help-panel', 'notepad-panel', 'todos-panel', 'inbox-panel', 'logs-panel', 'files-panel', 'crons-panel'];
      for (const id of panelIds) {
        const panel = document.getElementById(id);
        if (panel && !panel.classList.contains('hidden')) {
          panel.classList.add('hidden');
          if (activeAgentId) terminals.get(activeAgentId)?.focus();
          return;
        }
      }
    }

    if (e.metaKey || e.ctrlKey) {
      // When CodeMirror editor is focused, let it handle formatting shortcuts
      if (readerEditing && readerMode === 'source' && cmEditor && cmEditor.hasFocus) {
        if (['b', 'i', 'k'].includes(e.key) && !e.shiftKey) {
          return; // Let CodeMirror handle Cmd+B/I/K
        }
        // Cmd+/ toggles source/preview
        if (e.key === '/') {
          e.preventDefault();
          switchReaderMode(readerMode === 'source' ? 'preview' : 'source');
          return;
        }
      }

      // Cmd+K command palette
      if (e.key === 'k') {
        e.preventDefault();
        if (commandPaletteOpen) closeCommandPalette();
        else openCommandPalette();
        return;
      }

      // Cmd+Shift+[ / ] switch workspaces
      if (e.shiftKey && (e.key === '[' || e.key === '{')) {
        e.preventDefault();
        switchWorkspaceByOffset(-1);
        return;
      }
      if (e.shiftKey && (e.key === ']' || e.key === '}')) {
        e.preventDefault();
        switchWorkspaceByOffset(1);
        return;
      }

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

      // Cmd+T toggle todos
      if (e.key === 't') {
        e.preventDefault();
        toggleTodos();
        return;
      }

      // Cmd+I toggle inbox
      if (e.key === 'i') {
        e.preventDefault();
        toggleInbox();
        return;
      }

      // Cmd+Shift+M toggle mobile viewer
      if (e.key === 'm' && e.shiftKey) {
        e.preventDefault();
        toggleMobileViewer();
        return;
      }

      // Cmd+D toggle reader
      if (e.key === 'd') {
        e.preventDefault();
        toggleReader();
        return;
      }

      // Cmd+F: terminal search if focused on terminal, otherwise file manager
      if (e.key === 'f') {
        e.preventDefault();
        const filesOpen = !document.getElementById('files-panel').classList.contains('hidden');
        if (filesOpen) {
          document.getElementById('files-panel').classList.add('hidden');
        } else if (terminalSearchOpen) {
          closeTerminalSearch();
        } else {
          openTerminalSearch();
        }
        return;
      }

      // Cmd+Shift+F for file manager
      if (e.key === 'F' && e.shiftKey) {
        e.preventDefault();
        toggleFiles();
        return;
      }

      // Cmd+/ toggle source/preview in reader edit mode
      if (e.key === '/' && readerEditing) {
        e.preventDefault();
        switchReaderMode(readerMode === 'source' ? 'preview' : 'source');
        return;
      }

      // Cmd+S save in reader edit mode
      if (e.key === 's' && readerEditing) {
        e.preventDefault();
        saveReaderEdit();
        return;
      }

      // Cmd+= / Cmd++ increase font
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        changeFontSize(1);
        return;
      }

      // Cmd+- decrease font
      if (e.key === '-') {
        e.preventDefault();
        changeFontSize(-1);
        return;
      }

      // Cmd+0 reset font
      if (e.key === '0') {
        e.preventDefault();
        resetFontSize();
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

      // Cmd+N new instance
      if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        duplicateAgent();
        return;
      }
    }
  });

  // Workspace modal events
  document.getElementById('btn-add-workspace').addEventListener('click', () => openWorkspaceModal('create'));
  document.getElementById('btn-workspace-cancel').addEventListener('click', closeWorkspaceModal);
  document.getElementById('btn-workspace-confirm').addEventListener('click', confirmWorkspaceModal);
  document.getElementById('workspace-modal-backdrop').addEventListener('click', closeWorkspaceModal);
  document.getElementById('btn-workspace-icon-upload').addEventListener('click', () => {
    document.getElementById('workspace-icon-file').click();
  });
  document.getElementById('workspace-icon-file').addEventListener('change', (e) => {
    if (e.target.files[0]) handleWsIconFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btn-workspace-icon-clear').addEventListener('click', () => {
    selectedWsIcon = null;
    updateWsIconPreview();
  });
  document.getElementById('workspace-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmWorkspaceModal(); }
    if (e.key === 'Escape') closeWorkspaceModal();
  });

  // Workspace dropdown (sidebar header)
  document.getElementById('workspace-name-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleWorkspaceDropdown();
  });
  document.getElementById('btn-dropdown-new-ws').addEventListener('click', () => {
    document.getElementById('workspace-dropdown').classList.add('hidden');
    openWorkspaceModal('create');
  });
}

function switchWorkspaceByOffset(offset) {
  if (!workspaces || workspaces.workspaces.length <= 1) return;
  const sorted = [...workspaces.workspaces].sort((a, b) => (a.order || 0) - (b.order || 0));
  const currentIdx = sorted.findIndex(w => w.id === activeWorkspaceId);
  const nextIdx = (currentIdx + offset + sorted.length) % sorted.length;
  switchWorkspace(sorted[nextIdx].id);
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
    setAgentState(agentId, 'running');

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

function waitForAgentReady(agentId, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (agentStates.get(agentId) === 'running') { resolve(); return; }
    const start = Date.now();
    const check = setInterval(() => {
      if (agentStates.get(agentId) === 'running' || Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}

async function resumeAgent(agentId) {
  return startAgent(agentId, { resume: true });
}

async function restartAgent() {
  if (!activeAgentId) return;
  return startAgent(activeAgentId);
}

async function stopAgent() {
  if (!activeAgentId) return;
  await api.kill(activeAgentId);
  // State is set by the onExit handler when the PTY actually exits
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
  await showLogsWithRuns();
  panel.classList.remove('hidden');
}

let currentLogMarkdown = '';

async function viewLog(log) {
  const content = await api.readLog(log.path);
  const viewerEl = document.getElementById('log-viewer');
  const listEl = document.getElementById('logs-list');
  const backBtn = document.getElementById('btn-logs-back');
  const titleEl = document.getElementById('logs-title');

  // Clean the log using the same pipeline as Reader View
  currentLogMarkdown = extractMarkdown(content);

  // Render as formatted markdown
  marked.setOptions({ breaks: false, gfm: true });
  const contentEl = document.getElementById('log-content');
  contentEl.innerHTML = DOMPurify.sanitize(marked.parse(currentLogMarkdown));

  listEl.classList.add('hidden');
  viewerEl.classList.remove('hidden');
  backBtn.classList.remove('hidden');

  const date = new Date(log.mtime);
  titleEl.textContent = date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  }) + ' at ' + date.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
}

async function copyLogContent() {
  if (!currentLogMarkdown) return;
  const btn = document.getElementById('btn-log-copy');
  try {
    await navigator.clipboard.writeText(currentLogMarkdown);
    const span = btn.querySelector('span');
    span.textContent = 'Copied!';
    setTimeout(() => { span.textContent = 'Copy'; }, 1500);
  } catch {
    showToast('Copy failed', 'error');
  }
}

async function sendLogToAgent() {
  if (!currentLogMarkdown || !activeAgentId) return;

  const prefix = 'Here is a previous session transcript for reference:\n\n---\n\n';
  const text = prefix + currentLogMarkdown;
  const bracketedText = `\x1b[200~${text}\x1b[201~\r`;

  if (agentStates.get(activeAgentId) !== 'running') {
    await startAgent(activeAgentId);
    await waitForAgentReady(activeAgentId);
  }
  api.write(activeAgentId, bracketedText);

  // Close logs panel and focus terminal
  document.getElementById('logs-panel').classList.add('hidden');
  const terminal = terminals.get(activeAgentId);
  if (terminal) terminal.focus();
  showToast('Session transcript sent to agent', 'success');
}

// --- Helpers ---
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function formatDurationShort(sec) {
  if (!sec && sec !== 0) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\(B/g, '');
}

// --- Copy Last Response ---
async function copyLastResponse() {
  if (!activeAgentId) return;

  const rawText = getTerminalText(activeAgentId);
  if (!rawText.trim()) return;

  const lastResponse = extractLastResponse(rawText);
  const text = extractMarkdown(lastResponse);

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
  agentWorkspaceMap.set(newId, activeWorkspaceId);

  // Create terminal for new agent
  createTerminalForAgent(newAgent);

  // Re-render sidebar and select
  renderSidebar();
  selectAgent(newId);
}

// --- Crons Panel ---
let cronsActiveTab = 'jobs';

async function toggleCrons() {
  const panel = document.getElementById('crons-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  closeAllPanels();
  await loadCronsList();
  panel.classList.remove('hidden');
}

async function loadCronsList() {
  const jobs = await api.listCrons();
  const container = document.getElementById('crons-jobs');
  container.innerHTML = '';

  if (jobs.length === 0) {
    container.innerHTML = '<div class="crons-empty"><p>No scheduled tasks found</p><p style="font-size:11px;margin-top:4px">Add launchd plists to ~/Library/LaunchAgents/</p></div>';
    return;
  }

  for (const job of jobs) {
    const item = document.createElement('div');
    item.className = 'cron-item';

    let statusClass = 'stopped';
    if (job.running) statusClass = 'running';
    else if (job.loaded && job.lastExitCode != null && job.lastExitCode !== 0) statusClass = 'error';
    else if (job.loaded) statusClass = 'loaded';

    const toggleLabel = job.loaded ? 'On' : 'Off';
    const toggleClass = job.loaded ? 'active' : '';

    item.innerHTML = `
      <div class="cron-item-header">
        <div class="cron-status-dot ${statusClass}"></div>
        <span class="cron-item-name">${escapeHtml(job.name)}</span>
        <button class="cron-toggle-btn ${toggleClass}" data-label="${escapeHtml(job.label)}" data-loaded="${job.loaded}">${toggleLabel}</button>
      </div>
      <div class="cron-item-meta">
        <span class="cron-item-schedule">${escapeHtml(job.schedule)}</span>
        ${job.pid ? `<span>PID ${job.pid}</span>` : ''}
      </div>
    `;

    // Toggle on/off
    const toggleBtn = item.querySelector('.cron-toggle-btn');
    toggleBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = toggleBtn.dataset.label;
      const currentlyLoaded = toggleBtn.dataset.loaded === 'true';
      const result = await api.toggleCron(label, !currentlyLoaded);
      if (result.error) {
        showToast(result.error, 'error');
      } else {
        showToast(currentlyLoaded ? 'Job unloaded' : 'Job loaded', 'success');
        await loadCronsList();
      }
    });

    // Click to view logs
    if (job.logPath) {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.cron-toggle-btn')) return;
        viewCronLog(job.name, job.logPath);
      });
    }

    container.appendChild(item);
  }
}

async function loadCronsHistory() {
  const history = await api.cronHistory();
  const container = document.getElementById('crons-history');
  container.innerHTML = '';

  if (history.length === 0) {
    container.innerHTML = '<div class="crons-empty"><p>No run history</p></div>';
    return;
  }

  for (const entry of history) {
    const item = document.createElement('div');
    item.className = 'cron-history-item';

    let badgeClass = 'start';
    if (entry.status === 'OK') badgeClass = 'ok';
    else if (entry.status.startsWith('FAIL')) badgeClass = 'fail';
    else if (entry.status === 'SKIPPED') badgeClass = 'skip';
    else if (entry.status === 'START') badgeClass = 'start';

    // Format timestamp to relative or short
    const date = new Date(entry.timestamp);
    const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    item.innerHTML = `
      <span class="cron-history-time">${dateStr}</span>
      <span class="cron-history-agent">${escapeHtml(entry.agent)}</span>
      <span class="cron-badge ${badgeClass}">${escapeHtml(entry.status)}</span>
      <span class="cron-history-duration">${entry.duration !== '-' ? entry.duration : ''}</span>
    `;

    container.appendChild(item);
  }
}

async function viewCronLog(name, logPath) {
  const content = await api.cronLogs(logPath);
  document.getElementById('crons-log-title').textContent = name;
  document.getElementById('crons-log-content').textContent = content || '(empty)';

  document.getElementById('crons-jobs').classList.add('hidden');
  document.getElementById('crons-history').classList.add('hidden');
  document.getElementById('crons-tabs').classList.add('hidden');
  document.getElementById('crons-log-viewer').classList.remove('hidden');
}

function closeCronLog() {
  document.getElementById('crons-log-viewer').classList.add('hidden');
  document.getElementById('crons-tabs').classList.remove('hidden');
  switchCronsTab(cronsActiveTab);
}

function switchCronsTab(tab) {
  cronsActiveTab = tab;
  const jobsEl = document.getElementById('crons-jobs');
  const historyEl = document.getElementById('crons-history');

  document.querySelectorAll('.crons-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  if (tab === 'jobs') {
    jobsEl.classList.remove('hidden');
    historyEl.classList.add('hidden');
    loadCronsList();
  } else {
    jobsEl.classList.add('hidden');
    historyEl.classList.remove('hidden');
    loadCronsHistory();
  }
}

// --- Branded Confirm Modal ---
let confirmResolve = null;

function showConfirm(title, message, okLabel = 'Remove') {
  // Resolve any pending confirm as cancelled before showing a new one
  if (confirmResolve) {
    confirmResolve(false);
    confirmResolve = null;
  }
  return new Promise((resolve) => {
    confirmResolve = resolve;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-message').textContent = message;
    document.getElementById('btn-confirm-ok').textContent = okLabel;
    document.getElementById('confirm-modal').classList.remove('hidden');
  });
}

function closeConfirm(result) {
  document.getElementById('confirm-modal').classList.add('hidden');
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
}

async function removeAgent(agentId, skipConfirm = false) {
  if (!skipConfirm) {
    const agent = config.agents.find(a => a.id === agentId);
    const name = agent ? agent.name : agentId;
    const confirmed = await showConfirm(
      `Remove ${name}?`,
      'This removes the agent from Jents but does not delete its working directory or files.'
    );
    if (!confirmed) return;
  }

  // Kill if running
  api.kill(agentId);
  agentStates.delete(agentId);
  hasUnread.delete(agentId);
  agentWorkspaceMap.delete(agentId);

  // Remove terminal
  const terminal = terminals.get(agentId);
  if (terminal) terminal.dispose();
  terminals.delete(agentId);
  fitAddons.delete(agentId);
  searchAddons.delete(agentId);

  const wrapper = document.getElementById(`terminal-${agentId}`);
  if (wrapper) wrapper.remove();

  // Remove from config (atomic)
  const updated = await api.removeAgentConfig(agentId);
  if (updated) config = updated;

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
  // Guard against duplicate wrappers
  const existingWrapper = document.getElementById(`terminal-${agent.id}`);
  if (existingWrapper) return;

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
  {
    id: 'marketing',
    name: 'Marketing Team',
    desc: 'Campaigns, content, and performance analytics',
    agents: [
      { template: 'writer', name: 'Copywriter', color: '#6befa0' },
      { template: 'analyst', name: 'Performance Analyst', color: '#5b8def' },
      { template: 'pm', name: 'Campaign Manager', color: '#ec4899' },
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
  {
    id: 'linear',
    name: 'Linear',
    desc: 'Issues, projects, cycles, teams',
    docsUrl: 'https://github.com/anthropics/linear-mcp-server',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/linear-mcp-server'],
      env: { LINEAR_API_KEY: '' },
    },
    envLabels: {
      LINEAR_API_KEY: 'API Key (lin_api_...)',
    },
    setupNote: 'Create a personal API key at linear.app/settings/api.',
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
  contentEl.innerHTML = `<div class="help-prose">${DOMPurify.sanitize(marked.parse(HELP_CONTENT))}</div>`;
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
  document.getElementById('github-url-input').value = '';
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

  // Check for duplicate id across all workspaces
  const idCheck = await api.checkAgentId(id);
  if (idCheck.exists) {
    showToast(`Agent ID "${id}" already exists in workspace "${idCheck.workspaceName}"`, 'error');
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
  agentWorkspaceMap.set(id, activeWorkspaceId);

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

// --- Import from GitHub ---
async function importFromGithub() {
  const urlInput = document.getElementById('github-url-input');
  const url = urlInput.value.trim();
  if (!url) {
    showToast('Paste a GitHub URL first', 'error');
    urlInput.focus();
    return;
  }

  const btn = document.getElementById('btn-github-import');
  btn.textContent = 'Cloning...';
  btn.disabled = true;

  try {
    const result = await api.cloneGithub(url);

    if (result.error) {
      showToast(result.error, 'error');
      btn.textContent = 'Import';
      btn.disabled = false;
      return;
    }

    // Generate agent details from clone result
    const name = result.name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const id = result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const firstWord = name.split(/\s+/)[0];
    const shortName = firstWord.length <= 4 ? firstWord.toUpperCase() : firstWord.slice(0, 4).toUpperCase();

    // Check for duplicate across all workspaces
    const idCheck = await api.checkAgentId(id);
    if (idCheck.exists) {
      showToast(`Agent "${id}" already exists in workspace "${idCheck.workspaceName}"`, 'error');
      btn.textContent = 'Import';
      btn.disabled = false;
      return;
    }

    const color = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];

    const newAgent = {
      id,
      name,
      shortName,
      cwd: result.cwd,
      command: 'claude',
      color,
      channels: [],
    };

    const updated = await api.addAgent(newAgent);
    if (updated) config = updated;

    agentStates.set(id, 'stopped');
    hasUnread.set(id, false);
    agentWorkspaceMap.set(id, activeWorkspaceId);
    createTerminalForAgent(newAgent);

    showMainUI();
    renderSidebar();
    selectAgent(id);
    closeAddAgentModal();

    const extras = [];
    if (result.hasClaude) extras.push('CLAUDE.md detected');
    showToast(`${shortName} imported from GitHub${extras.length ? ' - ' + extras.join(', ') : ''}`, 'success');
  } finally {
    btn.textContent = 'Import';
    btn.disabled = false;
    urlInput.value = '';
  }
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
      <label>Description</label>
      <input id="cfg-description" type="text" value="${escapeHtml(agent.description || '')}" placeholder="What is this instance working on?" spellcheck="false" />
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
  const deleteBtn = agentForm.querySelector('#btn-cfg-delete');
  deleteBtn.addEventListener('click', async () => {
    document.getElementById('configure-panel').classList.add('hidden');
    await removeAgent(activeAgentId);
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
  const description = document.getElementById('cfg-description').value.trim();
  if (!name || !shortName || !cwd || !command) {
    showToast('All fields are required', 'error');
    return;
  }
  const updated = await api.updateAgent(activeAgentId, { name, shortName, cwd, command, description, color: selectedColor });
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

  // Save locally as backup
  await api.saveBug({
    description: text,
    agent: activeAgentId || null,
    timestamp: new Date().toISOString(),
  });

  // Build context for the GitHub issue
  const agent = activeAgentId ? config.agents.find(a => a.id === activeAgentId) : null;
  const agentContext = agent ? `${agent.name} (${agent.id})` : 'None';
  const mode = agent ? (agent.mode || 'default') : 'n/a';

  const title = text.length > 60 ? text.slice(0, 60) + '...' : text;
  const body = [
    `## Bug Report`,
    ``,
    text,
    ``,
    `## Context`,
    `- **App version**: v1.0.0-alpha`,
    `- **Active agent**: ${agentContext}`,
    `- **Permission mode**: ${mode}`,
    `- **Platform**: ${navigator.platform}`,
    `- **Timestamp**: ${new Date().toISOString()}`,
  ].join('\n');

  const issueUrl = `https://github.com/nckobrien-arch/jents/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=bug`;
  api.openExternal(issueUrl);

  closeBugModal();
  showToast('Opening GitHub to file the issue', 'success');
}

// --- Sidebar Toggle ---
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
  const strip = document.getElementById('workspace-strip');
  if (strip) strip.classList.toggle('hidden');
  // Terminal re-fit handled by ResizeObserver on terminal-container
}

document.getElementById('btn-sidebar-toggle').addEventListener('click', toggleSidebar);
document.getElementById('btn-mute-notifications').addEventListener('click', async () => {
  const current = await api.getMuted();
  const next = !current;
  await api.setMuted(next);
  updateMuteUI(next);
});
document.getElementById('btn-add-agent').addEventListener('click', openAddAgentModal);
document.getElementById('btn-duplicate-agent').addEventListener('click', duplicateAgent);
document.getElementById('btn-welcome-add').addEventListener('click', openAddAgentModal);
document.getElementById('btn-welcome-skip').addEventListener('click', () => {
  document.getElementById('welcome-screen').classList.add('hidden');
});
document.getElementById('btn-add-cancel').addEventListener('click', closeAddAgentModal);
document.getElementById('btn-add-confirm').addEventListener('click', confirmAddAgent);
document.getElementById('add-agent-backdrop').addEventListener('click', closeAddAgentModal);
document.getElementById('btn-browse-folder').addEventListener('click', async () => {
  const folder = await api.browseFolder();
  if (folder) document.getElementById('add-agent-cwd').value = folder;
});

document.getElementById('btn-github-import').addEventListener('click', importFromGithub);
document.getElementById('github-url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); importFromGithub(); }
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
  if (activeAgentId) terminals.get(activeAgentId)?.focus();
});
document.getElementById('btn-confirm-cancel').addEventListener('click', () => closeConfirm(false));
document.getElementById('btn-confirm-ok').addEventListener('click', () => closeConfirm(true));
document.getElementById('confirm-modal-backdrop').addEventListener('click', () => closeConfirm(false));

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

// --- Command Palette ---
const COMMANDS = [
  { label: 'Start / Restart Agent', shortcut: ['Cmd', 'R'], action: () => { if (agentStates.get(activeAgentId) === 'running') restartAgent(); else startAgent(activeAgentId); }},
  { label: 'Resume Last Session', shortcut: [], action: () => resumeAgent(activeAgentId) },
  { label: 'Stop Agent', shortcut: [], action: () => armStop() },
  { label: 'Toggle Notepad', shortcut: ['Cmd', 'E'], action: () => toggleNotepad() },
  { label: 'Toggle Reader View', shortcut: ['Cmd', 'D'], action: () => toggleReader() },
  { label: 'Toggle Mobile Viewer', shortcut: ['Cmd', 'Shift', 'M'], action: () => toggleMobileViewer() },
  { label: 'Toggle File Manager', shortcut: ['Cmd', 'Shift', 'F'], action: () => toggleFiles() },
  { label: 'Toggle Sidebar', shortcut: ['Cmd', 'B'], action: () => toggleSidebar() },
  { label: 'Scheduled Tasks', shortcut: [], action: () => toggleCrons() },
  { label: 'Session History', shortcut: [], action: () => toggleLogs() },
  { label: 'Configure Agent', shortcut: [], action: () => toggleConfigure() },
  { label: 'Search Terminal', shortcut: ['Cmd', 'F'], action: () => openTerminalSearch() },
  { label: 'Add Agent', shortcut: [], action: () => openAddAgentModal() },
  { label: 'New Instance', shortcut: ['Cmd', 'N'], action: () => duplicateAgent() },
  { label: 'Clear Terminal', shortcut: [], action: () => armClear() },
  { label: 'Copy Last Response', shortcut: [], action: () => copyLastResponse() },
  { label: 'Increase Font Size', shortcut: ['Cmd', '+'], action: () => changeFontSize(1) },
  { label: 'Decrease Font Size', shortcut: ['Cmd', '-'], action: () => changeFontSize(-1) },
  { label: 'Reset Font Size', shortcut: ['Cmd', '0'], action: () => resetFontSize() },
  { label: 'Report Bug', shortcut: [], action: () => openBugModal() },
  { label: 'Agent Guide', shortcut: [], action: () => toggleHelp() },
  { label: 'New Workspace', shortcut: [], action: () => openWorkspaceModal('create') },
  { label: 'Next Workspace', shortcut: ['Cmd', 'Shift', ']'], action: () => switchWorkspaceByOffset(1) },
  { label: 'Previous Workspace', shortcut: ['Cmd', 'Shift', '['], action: () => switchWorkspaceByOffset(-1) },
];

let commandPaletteOpen = false;
let selectedCommandIdx = 0;

function openCommandPalette() {
  commandPaletteOpen = true;
  const modal = document.getElementById('command-palette');
  const input = document.getElementById('command-palette-input');
  modal.classList.remove('hidden');
  input.value = '';
  selectedCommandIdx = 0;
  renderCommandList('');
  input.focus();
}

function closeCommandPalette() {
  commandPaletteOpen = false;
  document.getElementById('command-palette').classList.add('hidden');
}

function renderCommandList(query) {
  const list = document.getElementById('command-palette-list');
  list.innerHTML = '';

  const q = query.toLowerCase();
  const filtered = COMMANDS.filter(c => c.label.toLowerCase().includes(q));

  filtered.forEach((cmd, i) => {
    const item = document.createElement('div');
    item.className = `command-item${i === selectedCommandIdx ? ' selected' : ''}`;

    const shortcutHtml = cmd.shortcut.length > 0
      ? `<div class="command-item-shortcut">${cmd.shortcut.map(k => `<kbd>${k === 'Cmd' ? '\u2318' : k}</kbd>`).join('')}</div>`
      : '';

    item.innerHTML = `<span class="command-item-label">${cmd.label}</span>${shortcutHtml}`;
    item.addEventListener('click', () => {
      closeCommandPalette();
      cmd.action();
    });
    item.addEventListener('mouseenter', () => {
      selectedCommandIdx = i;
      list.querySelectorAll('.command-item').forEach((el, j) => el.classList.toggle('selected', j === i));
    });
    list.appendChild(item);
  });
}

document.getElementById('command-palette-input').addEventListener('input', (e) => {
  selectedCommandIdx = 0;
  renderCommandList(e.target.value);
});

document.getElementById('command-palette-input').addEventListener('keydown', (e) => {
  const items = document.querySelectorAll('.command-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedCommandIdx = Math.min(selectedCommandIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('selected', i === selectedCommandIdx));
    items[selectedCommandIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedCommandIdx = Math.max(selectedCommandIdx - 1, 0);
    items.forEach((el, i) => el.classList.toggle('selected', i === selectedCommandIdx));
    items[selectedCommandIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    items[selectedCommandIdx]?.click();
  } else if (e.key === 'Escape') {
    closeCommandPalette();
  }
});

document.getElementById('command-palette-backdrop').addEventListener('click', closeCommandPalette);

// --- Font Size ---
function changeFontSize(delta) {
  terminalFontSize = Math.max(9, Math.min(24, terminalFontSize + delta));
  for (const [id, terminal] of terminals) {
    terminal.options.fontSize = terminalFontSize;
    const fitAddon = fitAddons.get(id);
    if (fitAddon) fitAddon.fit();
    if (id === activeAgentId && agentStates.get(id) === 'running') {
      api.resize(id, terminal.cols, terminal.rows);
    }
  }
}

function resetFontSize() {
  terminalFontSize = 13;
  changeFontSize(0);
}

// --- Terminal Search ---
let terminalSearchOpen = false;

function openTerminalSearch() {
  terminalSearchOpen = true;
  const bar = document.getElementById('terminal-search');
  const input = document.getElementById('terminal-search-input');
  bar.classList.remove('hidden');
  input.value = '';
  input.focus();
}

function closeTerminalSearch() {
  terminalSearchOpen = false;
  document.getElementById('terminal-search').classList.add('hidden');
  if (activeAgentId) {
    const sa = searchAddons.get(activeAgentId);
    if (sa) sa.clearDecorations();
    const terminal = terminals.get(activeAgentId);
    if (terminal) terminal.focus();
  }
}

function doTerminalSearch(direction) {
  if (!activeAgentId) return;
  const sa = searchAddons.get(activeAgentId);
  if (!sa) return;
  const query = document.getElementById('terminal-search-input').value;
  if (!query) return;
  if (direction === 'next') sa.findNext(query);
  else sa.findPrevious(query);
}

document.getElementById('terminal-search-input').addEventListener('input', () => doTerminalSearch('next'));
document.getElementById('terminal-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doTerminalSearch(e.shiftKey ? 'prev' : 'next');
  }
  if (e.key === 'Escape') closeTerminalSearch();
});
document.getElementById('btn-search-next').addEventListener('click', () => doTerminalSearch('next'));
document.getElementById('btn-search-prev').addEventListener('click', () => doTerminalSearch('prev'));
document.getElementById('btn-search-close').addEventListener('click', closeTerminalSearch);

// --- Session History Search ---
let allLogs = [];

document.getElementById('logs-search-input').addEventListener('input', async (e) => {
  const query = e.target.value.toLowerCase();
  if (allLogs.length === 0 && activeAgentId) {
    allLogs = await api.getLogs(activeAgentId);
  }
  renderFilteredLogs(query);
});

function renderFilteredLogs(query) {
  const listEl = document.getElementById('logs-list');
  listEl.innerHTML = '';

  const filtered = query
    ? allLogs.filter(log => {
        const date = new Date(log.mtime);
        const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return `${dateStr} ${timeStr}`.toLowerCase().includes(query) || log.name.toLowerCase().includes(query);
      })
    : allLogs;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="logs-empty"><p>No matching sessions</p></div>';
    return;
  }

  for (const log of filtered) {
    const item = document.createElement('div');
    item.className = 'log-item';

    const date = new Date(log.mtime);
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const size = formatSize(log.size);

    item.innerHTML = `
      <div class="log-item-date">${dateStr} at ${timeStr}</div>
      <div class="log-item-meta"><span>${size}</span></div>
    `;
    item.addEventListener('click', () => viewLog(log));
    listEl.appendChild(item);
  }
}

// --- Todos ---

async function loadTodosData() {
  try { todosData = await api.loadTodos(); }
  catch { todosData = { goals: [], todos: [] }; }
}

function saveTodosData() { api.saveTodos(todosData); }

function toggleTodos() {
  const panel = document.getElementById('todos-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    if (activeAgentId) terminals.get(activeAgentId)?.focus();
    return;
  }
  closeAllPanels();
  panel.classList.remove('hidden');
  document.getElementById('goals-editor').classList.add('hidden');
  populateTodoSelects();
  renderTodosList();
  document.getElementById('todo-input').focus();
}

function populateTodoSelects() {
  // Agent select
  const agentSel = document.getElementById('todo-agent-select');
  const curAgent = agentSel.value;
  agentSel.innerHTML = '<option value="">No agent</option>';
  for (const agent of config.agents) {
    agentSel.innerHTML += `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.shortName)}</option>`;
  }
  agentSel.value = curAgent || '';

  // Goal select
  const goalSel = document.getElementById('todo-goal-select');
  const curGoal = goalSel.value;
  goalSel.innerHTML = '<option value="">No goal</option>';
  for (const goal of todosData.goals) {
    goalSel.innerHTML += `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</option>`;
  }
  goalSel.value = curGoal || '';
}

function addTodo() {
  const input = document.getElementById('todo-input');
  const text = input.value.trim();
  if (!text) return;
  const agentId = document.getElementById('todo-agent-select').value || null;
  const goalId = document.getElementById('todo-goal-select').value || null;

  todosData.todos.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    agentId,
    goalId,
    status: 'todo',
    createdAt: Date.now(),
    completedAt: null,
    summary: null,
  });
  saveTodosData();
  input.value = '';
  renderTodosList();
  input.focus();
}

function toggleTodoStatus(todoId) {
  const todo = todosData.todos.find(t => t.id === todoId);
  if (!todo) return;
  if (todo.status === 'todo') {
    todo.status = 'done';
    todo.completedAt = Date.now();
  } else {
    todo.status = 'todo';
    todo.completedAt = null;
  }
  saveTodosData();
  renderTodosList();
}

function deleteTodo(todoId) {
  todosData.todos = todosData.todos.filter(t => t.id !== todoId);
  saveTodosData();
  renderTodosList();
}

function editTodoInline(todoId) {
  const todo = todosData.todos.find(t => t.id === todoId);
  if (!todo) return;
  const el = document.querySelector(`.todo-item[data-todo-id="${todoId}"] .todo-text`);
  if (!el) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'todo-edit-input';
  input.value = todo.text;
  el.replaceWith(input);
  input.focus();
  input.select();
  const save = () => {
    todo.text = input.value.trim() || todo.text;
    saveTodosData();
    renderTodosList();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') renderTodosList();
  });
}

function renderTodoItem(todo) {
  const agent = config.agents.find(a => a.id === todo.agentId);
  const agentBadge = agent
    ? `<span class="todo-agent-badge" style="background:${sanitizeColor(agent.color)}">${escapeHtml(agent.shortName)}</span>`
    : '';
  const summaryHtml = todo.summary
    ? `<div class="todo-summary">${escapeHtml(truncate(todo.summary, 60))}</div>`
    : '';
  const checked = todo.status === 'done' ? 'checked' : '';
  const doneClass = todo.status === 'done' ? ' todo-done' : '';

  return `
    <div class="todo-item${doneClass}" data-todo-id="${todo.id}">
      <label class="todo-checkbox">
        <input type="checkbox" ${checked} />
        <span class="todo-checkmark"></span>
      </label>
      <div class="todo-content">
        <div class="todo-text">${escapeHtml(todo.text)}</div>
        ${summaryHtml}
        <div class="todo-meta">
          ${agentBadge}
          <span class="todo-time">${formatTimeAgo(todo.createdAt)}</span>
        </div>
      </div>
      <button class="todo-delete" title="Delete">&times;</button>
    </div>
  `;
}

function renderTodosList() {
  const listEl = document.getElementById('todos-list');
  listEl.innerHTML = '';

  const activeTodos = todosData.todos.filter(t => t.status === 'todo');
  const doneTodos = todosData.todos.filter(t => t.status === 'done');

  // Group active by goal
  const goalMap = new Map();
  const ungrouped = [];
  for (const todo of activeTodos) {
    if (todo.goalId) {
      if (!goalMap.has(todo.goalId)) goalMap.set(todo.goalId, []);
      goalMap.get(todo.goalId).push(todo);
    } else {
      ungrouped.push(todo);
    }
  }

  // Render goal groups
  for (const goal of todosData.goals) {
    const todos = goalMap.get(goal.id);
    if (!todos || todos.length === 0) continue;
    const section = document.createElement('div');
    section.className = 'todo-goal-group';
    section.innerHTML = `
      <div class="todo-goal-header" style="border-left-color:${sanitizeColor(goal.color) || 'var(--accent)'}">
        <span class="todo-goal-title">${escapeHtml(goal.title)}</span>
        <span class="todo-goal-count">${todos.length}</span>
      </div>
      <div class="todo-goal-items">${todos.map(renderTodoItem).join('')}</div>
    `;
    listEl.appendChild(section);
  }

  // Ungrouped
  if (ungrouped.length > 0) {
    const section = document.createElement('div');
    section.className = 'todo-goal-group';
    if (goalMap.size > 0) {
      section.innerHTML = `<div class="todo-goal-header"><span class="todo-goal-title">Ungrouped</span><span class="todo-goal-count">${ungrouped.length}</span></div>`;
    }
    section.innerHTML += `<div class="todo-goal-items">${ungrouped.map(renderTodoItem).join('')}</div>`;
    listEl.appendChild(section);
  }

  // Done section
  if (doneTodos.length > 0) {
    const section = document.createElement('div');
    section.className = 'todo-done-group';
    section.innerHTML = `
      <div class="todo-done-header">
        <span>Done (${doneTodos.length})</span>
        <svg class="todo-done-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="todo-done-items hidden">${doneTodos.map(renderTodoItem).join('')}</div>
    `;
    listEl.appendChild(section);
  }

  if (activeTodos.length === 0 && doneTodos.length === 0) {
    listEl.innerHTML = '<div class="todos-empty">No todos yet</div>';
  }

  // Wire up events via delegation
  listEl.querySelectorAll('.todo-checkbox input').forEach(cb => {
    cb.addEventListener('change', () => {
      const todoId = cb.closest('.todo-item').dataset.todoId;
      toggleTodoStatus(todoId);
    });
  });
  listEl.querySelectorAll('.todo-text').forEach(el => {
    el.addEventListener('dblclick', () => {
      const todoId = el.closest('.todo-item').dataset.todoId;
      editTodoInline(todoId);
    });
  });
  listEl.querySelectorAll('.todo-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const todoId = btn.closest('.todo-item').dataset.todoId;
      deleteTodo(todoId);
    });
  });
  listEl.querySelectorAll('.todo-done-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const items = hdr.nextElementSibling;
      items.classList.toggle('hidden');
      hdr.querySelector('.todo-done-chevron')?.classList.toggle('expanded');
    });
  });
}

// --- Goals Editor ---

function showGoalsEditor() {
  document.getElementById('goals-editor').classList.remove('hidden');
  document.getElementById('todos-list').classList.add('hidden');
  document.getElementById('todos-add').classList.add('hidden');
  renderGoalsList();
}

function hideGoalsEditor() {
  document.getElementById('goals-editor').classList.add('hidden');
  document.getElementById('todos-list').classList.remove('hidden');
  document.getElementById('todos-add').classList.remove('hidden');
  populateTodoSelects();
  renderTodosList();
}

function addGoal() {
  const input = document.getElementById('goal-input');
  const title = input.value.trim();
  if (!title) return;
  const colors = ['#ef6b6b', '#5b8def', '#6befa0', '#a06bef', '#f59e0b', '#ec4899', '#14b8a6'];
  todosData.goals.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    color: colors[todosData.goals.length % colors.length],
    order: todosData.goals.length,
  });
  saveTodosData();
  input.value = '';
  renderGoalsList();
}

function deleteGoal(goalId) {
  todosData.goals = todosData.goals.filter(g => g.id !== goalId);
  // Unlink todos from deleted goal
  for (const todo of todosData.todos) {
    if (todo.goalId === goalId) todo.goalId = null;
  }
  saveTodosData();
  renderGoalsList();
}

function renderGoalsList() {
  const listEl = document.getElementById('goals-list');
  listEl.innerHTML = '';
  if (todosData.goals.length === 0) {
    listEl.innerHTML = '<div class="todos-empty">No goals yet</div>';
    return;
  }
  for (const goal of todosData.goals) {
    const count = todosData.todos.filter(t => t.goalId === goal.id && t.status === 'todo').length;
    const item = document.createElement('div');
    item.className = 'goal-item';
    item.innerHTML = `
      <div class="goal-color-dot" style="background:${sanitizeColor(goal.color)}"></div>
      <div class="goal-info">
        <div class="goal-title">${escapeHtml(goal.title)}</div>
        <div class="goal-count">${count} todo${count !== 1 ? 's' : ''}</div>
      </div>
      <button class="goal-delete" data-goal-id="${escapeHtml(goal.id)}" title="Delete">&times;</button>
    `;
    listEl.appendChild(item);
  }
  listEl.querySelectorAll('.goal-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteGoal(btn.dataset.goalId));
  });
}

// --- Inbox ---

async function loadInboxData() {
  try { inboxItems = await api.loadInbox(); }
  catch { inboxItems = []; }
  updateInboxBadge();
}

function updateInboxBadge() {
  const badge = document.getElementById('inbox-badge');
  const unread = inboxItems.filter(i => !i.read).length;
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function toggleInbox() {
  const panel = document.getElementById('inbox-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    if (activeAgentId) terminals.get(activeAgentId)?.focus();
    return;
  }
  closeAllPanels();
  panel.classList.remove('hidden');
  renderInboxList();
}

function renderInboxList() {
  const listEl = document.getElementById('inbox-list');
  listEl.innerHTML = '';

  if (inboxItems.length === 0) {
    listEl.innerHTML = '<div class="inbox-empty">No notifications</div>';
    return;
  }

  for (const item of inboxItems) {
    const agent = config.agents.find(a => a.id === item.agentId);
    // Also check across workspaces
    const agentColor = agent?.color || '#5a5a78';
    const agentLabel = agent?.shortName || item.agentId || '';

    const typeIcon = item.type === 'exit'
      ? '<svg viewBox="0 0 24 24" class="inbox-icon exit"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" class="inbox-icon idle"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>';

    const readClass = item.read ? ' inbox-read' : '';
    const summaryHtml = item.summary ? `<div class="inbox-summary">${escapeHtml(truncate(item.summary, 80))}</div>` : '';

    const el = document.createElement('div');
    el.className = `inbox-item${readClass}`;
    el.dataset.inboxId = item.id;
    el.innerHTML = `
      ${typeIcon}
      <div class="inbox-content">
        <div class="inbox-title">
          <span class="inbox-agent-dot" style="background:${sanitizeColor(agentColor)}"></span>
          ${escapeHtml(item.title || '')}
        </div>
        <div class="inbox-detail">${escapeHtml(item.detail || '')}</div>
        ${summaryHtml}
      </div>
      <div class="inbox-time">${formatTimeAgo(item.timestamp)}</div>
    `;

    el.addEventListener('click', () => {
      // Mark as read
      item.read = true;
      api.saveInbox(inboxItems);
      updateInboxBadge();
      el.classList.add('inbox-read');

      // Switch to that agent if it exists in current workspace
      if (agent) {
        selectAgent(item.agentId);
        document.getElementById('inbox-panel').classList.add('hidden');
      }
    });

    listEl.appendChild(el);
  }
}

function clearInbox() {
  inboxItems = [];
  api.clearInbox();
  updateInboxBadge();
  renderInboxList();
}

// --- Enhanced Logs (Run Records) ---

async function loadRunsForAgent(agentId) {
  return api.listRuns(agentId);
}

async function showLogsWithRuns() {
  if (!activeAgentId) return;
  const panel = document.getElementById('logs-panel');
  const listEl = document.getElementById('logs-list');
  const viewerEl = document.getElementById('log-viewer');

  // Reset to list view
  viewerEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  document.getElementById('btn-logs-back').classList.add('hidden');
  document.getElementById('logs-title').textContent = 'Session History';

  // Load both run records and raw logs for this agent
  const runs = await loadRunsForAgent(activeAgentId);
  const logs = await api.getLogs(activeAgentId);

  listEl.innerHTML = '';

  if (runs.length === 0 && logs.length === 0) {
    listEl.innerHTML = '<div class="logs-empty"><p>No sessions yet</p><p class="logs-empty-sub">Start the agent with Cmd+R</p></div>';
    return;
  }

  // Build a merged list: run records first (they have richer data), then orphan logs
  const runLogPaths = new Set(runs.map(r => r.logPath));

  // Render run records as rich cards
  // The most recent completed run is the one --continue will resume
  const mostRecentCompleted = runs.find(r => r.exitCode != null);

  for (const run of runs) {
    const agent = config.agents.find(a => a.id === run.agentId);
    const statusIcon = run.exitCode === 0
      ? '<span class="run-status success">&#10003;</span>'
      : run.exitCode != null
        ? `<span class="run-status error">&#10007;</span>`
        : '<span class="run-status running">&#8226;</span>';
    const duration = run.durationSec != null ? formatDurationShort(run.durationSec) : 'running';
    const date = new Date(run.startedAt);
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const summaryHtml = run.summary ? `<div class="run-summary">${escapeHtml(truncate(run.summary, 80))}</div>` : '';
    const triggerLabel = run.trigger === 'resume' ? 'resumed' : run.trigger || 'manual';
    const isCompleted = run.exitCode != null;
    const isMostRecent = run === mostRecentCompleted;
    const isCurrentlyRunning = run.exitCode == null;

    const card = document.createElement('div');
    card.className = 'run-card';

    // Show resume button on the most recent completed run
    const resumeBtn = isMostRecent
      ? '<button class="run-resume-btn" title="Resume this session">Resume</button>'
      : '';

    card.innerHTML = `
      <div class="run-card-header">
        ${statusIcon}
        <span class="run-duration">${duration}</span>
        <span class="run-trigger">${triggerLabel}</span>
        ${resumeBtn}
      </div>
      ${summaryHtml}
      <div class="run-card-meta">${dateStr} at ${timeStr}</div>
    `;

    // Resume button handler
    const resumeBtnEl = card.querySelector('.run-resume-btn');
    if (resumeBtnEl) {
      resumeBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('logs-panel').classList.add('hidden');
        resumeAgent(activeAgentId);
      });
    }

    card.addEventListener('click', () => {
      if (run.logPath) {
        const logObj = { path: run.logPath, name: run.logPath.split('/').pop() };
        viewLog(logObj);
      }
    });
    listEl.appendChild(card);
  }

  // Render any orphan logs (logs without a run record - from before this feature)
  const orphanLogs = logs.filter(l => !runLogPaths.has(l.path));
  if (orphanLogs.length > 0 && runs.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'run-divider';
    divider.textContent = 'Older sessions';
    listEl.appendChild(divider);
  }
  for (const log of orphanLogs) {
    const item = document.createElement('div');
    item.className = 'log-item';
    const date = new Date(log.mtime);
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    item.innerHTML = `
      <div class="log-item-date">${dateStr} at ${timeStr}</div>
      <div class="log-item-meta"><span>${formatSize(log.size)}</span></div>
    `;
    item.addEventListener('click', () => viewLog(log));
    listEl.appendChild(item);
  }
}

// --- Start ---
init();
