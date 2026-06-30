# Jents

A macOS app that runs Claude Code agents as a team. Real terminals, Slack-style workspaces, smart notifications, and keyboard shortcuts.

**[jents.co](https://jents.co)** - [Download](https://github.com/ngo-arch/jents/releases)

## What it does

Jents wraps the Claude Code CLI in a native Electron app. Each agent gets its own PTY terminal, working directory, and config. You switch between them like tabs, get notified when they need you, and manage everything with keyboard shortcuts.

- **Workspaces** - Group agents by project. Each workspace has its own roster. Switch with Cmd+Shift+[/].
- **Real terminals** - Full xterm.js with ANSI color, scrollback, interactive input. Not a chat UI.
- **Agent-to-agent comms** - Built-in MCP server lets agents message each other and delegate tasks. Dormant agents auto-start when they receive work.
- **Smart notifications** - Desktop alerts on agent exit and idle. Inbox catches everything. Click to jump cross-workspace.
- **Notepad** - Save prompts you reuse. Send to any agent with one click.
- **Reader View** - Strip ANSI noise, render markdown, edit and save .md files.
- **Todos** - Goals and tasks assignable to agents.
- **Starter packs** - Pre-built teams (Engineering, Product, Content, Marketing, Full Stack) that scaffold multiple agents at once.
- **MCP integrations** - Connect Slack, GitHub, PostgreSQL, Google Workspace, Linear with labeled form fields.
- **Permission modes** - Default, Auto, Accept Edits, Plan, YOLO per agent.
- **Session history** - Every run auto-saved with duration, exit code, and summary.
- **File manager** - Recent files across all agent directories.
- **Scheduled tasks** - Manage launchd crons from the app.
- **Command palette** - Cmd+K to find any action.

## Install

### Download (recommended)

Grab the latest `.zip` from [Releases](https://github.com/ngo-arch/jents/releases), unzip, and drag `Jents.app` to `/Applications`.

**Opening on macOS.** Jents is ad-hoc signed but not notarized (no paid Apple Developer ID), so macOS quarantines the download. After moving it to `/Applications`, clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/Jents.app
```

Then open it normally. (If you skip this, macOS may say the app is "damaged" or "can't be opened" — that's Gatekeeper on an un-notarized app, not an actual corrupt download.)

### Build from source

Requires Node.js 18+ and macOS.

```bash
git clone https://github.com/ngo-arch/jents.git ~/agent-desk
cd ~/agent-desk
npm install
npm run build
npm start
```

To package as a standalone app:

```bash
npx electron-packager . Jents --platform=darwin --arch=arm64 --icon=icon.icns --out=dist --overwrite
cp -R dist/Jents-darwin-arm64/Jents.app /Applications/Jents.app
xattr -cr /Applications/Jents.app
```

## Prerequisites

- **Claude Code CLI** - Install with `npm install -g @anthropic-ai/claude-code`. Jents spawns `claude` as the default command for each agent.
- **macOS** - Electron + node-pty. Apple Silicon and Intel supported.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+K | Command palette |
| Cmd+1-9 | Switch agent tabs |
| Cmd+R | Start / restart agent |
| Cmd+N | New instance (duplicate) |
| Cmd+E | Notepad |
| Cmd+D | Reader view |
| Cmd+T | Todos |
| Cmd+I | Inbox |
| Cmd+F | Terminal search |
| Cmd+Shift+F | File manager |
| Cmd+B | Toggle sidebar |
| Cmd+Shift+[/] | Switch workspace |
| Cmd+=/- | Font size |
| Esc | Close overlay |

## How agents work

Each agent is a directory with:

- **CLAUDE.md** - Instructions, role, guidelines
- **run-*.md** - Repeatable task workflows
- **.mcp.json** - MCP server integrations

Jents creates these automatically from templates when you add an agent. The agent's terminal runs `claude` (or any command you configure) in that directory.

### Agent-to-agent communication

Every Claude-based agent automatically gets a Jents MCP server injected with tools for inter-agent messaging:

- `list_agents` - See all agents across workspaces
- `send_message` - Send an FYI or status update to another agent
- `delegate_task` - Hand off work with context, get results back
- `complete_task` - Return results to the requesting agent
- `check_messages` - Read incoming messages and tasks

When an agent delegates a task to a stopped agent, Jents auto-starts the target.

## Tech stack

- Electron 33
- xterm.js 5 (@xterm/xterm)
- node-pty (native PTY spawning)
- marked (markdown rendering)
- esbuild (bundler)
- @modelcontextprotocol/sdk (agent comms)

## Data

All user data lives in `~/agent-desk/`:

| File | Purpose |
|------|---------|
| `team.json` | Default workspace agent roster |
| `team-{id}.json` | Additional workspace rosters |
| `workspaces.json` | Workspace registry |
| `notes.json` | Notepad |
| `todos.json` | Todos and goals |
| `inbox.json` | Notification inbox |
| `runs.json` | Run records |
| `logs/` | Auto-saved session transcripts |

## License

MIT
