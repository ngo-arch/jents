#!/usr/bin/env node

// Jents Comms MCP Server
// Provides agent-to-agent messaging and task delegation.
// One instance per agent, spawned by Claude CLI via --mcp-config.
// Stateless - all state lives in the filesystem under JENTS_DATA_DIR.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const AGENT_ID = process.env.JENTS_AGENT_ID;
const DATA_DIR = process.env.JENTS_DATA_DIR || path.join(os.homedir(), 'agent-desk');
const MAIL_DIR = path.join(DATA_DIR, 'mail');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function generateId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Read all agents across all workspaces
function getAllAgents() {
  const agents = [];
  const wsPath = path.join(DATA_DIR, 'workspaces.json');
  let workspaces;
  try {
    workspaces = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
  } catch {
    // Fallback: just read team.json
    try {
      const team = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'team.json'), 'utf-8'));
      return team.agents.map(a => ({ id: a.id, name: a.name, shortName: a.shortName, workspace: 'default' }));
    } catch { return []; }
  }

  for (const ws of workspaces.workspaces) {
    const configPath = path.join(DATA_DIR, ws.configFile);
    try {
      const team = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      for (const a of team.agents) {
        agents.push({ id: a.id, name: a.name, shortName: a.shortName, workspace: ws.name });
      }
    } catch {}
  }
  return agents;
}

function getAgentName(agentId) {
  const agents = getAllAgents();
  const agent = agents.find(a => a.id === agentId);
  return agent ? agent.name : agentId;
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: 'jents',
  version: '1.0.0',
});

// Tool: list_agents
server.tool(
  'list_agents',
  'List all agents in the Jents workspace. Returns each agent\'s id, name, shortName, and workspace.',
  {},
  async () => {
    const agents = getAllAgents();
    return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
  }
);

// Tool: send_message
server.tool(
  'send_message',
  'Send a message to another agent. The message will be delivered to their terminal automatically. Use for informal communication, status updates, or FYI messages where no response is expected.',
  { to: z.string().describe('Agent ID to send to'), message: z.string().describe('Message content') },
  async ({ to, message }) => {
    const agents = getAllAgents();
    if (!agents.find(a => a.id === to)) {
      return { content: [{ type: 'text', text: `Error: Agent "${to}" not found. Use list_agents to see available agents.` }], isError: true };
    }

    const msgId = generateId('msg');
    const msg = {
      id: msgId,
      type: 'message',
      from: AGENT_ID,
      fromName: getAgentName(AGENT_ID),
      to,
      message,
      timestamp: Date.now(),
    };

    const agentMailDir = path.join(MAIL_DIR, to);
    ensureDir(agentMailDir);
    fs.writeFileSync(path.join(agentMailDir, `${msgId}.json`), JSON.stringify(msg, null, 2));

    return { content: [{ type: 'text', text: JSON.stringify({ delivered: true, message_id: msgId }) }] };
  }
);

// Tool: delegate_task
server.tool(
  'delegate_task',
  'Delegate a task to another agent and get a task_id back. The target agent will be started automatically if not running. The result will be delivered to your terminal when the task is complete - no polling needed. Use this when you need work done by another agent and want the result back.',
  {
    to: z.string().describe('Agent ID to delegate to'),
    task: z.string().describe('Description of the task to perform'),
    context: z.string().optional().describe('Additional context or data the agent needs'),
  },
  async ({ to, task, context }) => {
    const agents = getAllAgents();
    if (!agents.find(a => a.id === to)) {
      return { content: [{ type: 'text', text: `Error: Agent "${to}" not found. Use list_agents to see available agents.` }], isError: true };
    }

    const taskId = generateId('task');
    const taskRecord = {
      id: taskId,
      from: AGENT_ID,
      fromName: getAgentName(AGENT_ID),
      to,
      toName: getAgentName(to),
      task,
      context: context || null,
      status: 'pending',
      createdAt: Date.now(),
      result: null,
      completedAt: null,
    };

    // Write task tracking file
    ensureDir(TASKS_DIR);
    fs.writeFileSync(path.join(TASKS_DIR, `${taskId}.json`), JSON.stringify(taskRecord, null, 2));

    // Write delivery file to target agent's mailbox
    const agentMailDir = path.join(MAIL_DIR, to);
    ensureDir(agentMailDir);
    fs.writeFileSync(path.join(agentMailDir, `${taskId}.json`), JSON.stringify({
      id: taskId,
      type: 'task',
      from: AGENT_ID,
      fromName: getAgentName(AGENT_ID),
      to,
      task,
      context: context || null,
      timestamp: Date.now(),
    }, null, 2));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          task_id: taskId,
          status: 'delegated',
          to,
          note: 'The result will be delivered to your terminal when complete. Continue with other work or wait for it.',
        }),
      }],
    };
  }
);

// Tool: complete_task
server.tool(
  'complete_task',
  'Mark a delegated task as complete and send the result back to the requesting agent. Call this when you have finished a task that was delegated to you via [DELEGATED TASK].',
  {
    task_id: z.string().describe('The task_id from the delegated task'),
    result: z.string().describe('The result or output of the completed task'),
  },
  async ({ task_id, result }) => {
    const taskPath = path.join(TASKS_DIR, `${task_id}.json`);
    let taskRecord;
    try {
      taskRecord = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    } catch {
      return { content: [{ type: 'text', text: `Error: Task "${task_id}" not found.` }], isError: true };
    }

    if (taskRecord.status === 'completed') {
      return { content: [{ type: 'text', text: `Task "${task_id}" is already completed.` }] };
    }

    // Update task record
    taskRecord.status = 'completed';
    taskRecord.result = result;
    taskRecord.completedAt = Date.now();
    fs.writeFileSync(taskPath, JSON.stringify(taskRecord, null, 2));

    // Write result delivery file to originator's mailbox
    const originMailDir = path.join(MAIL_DIR, taskRecord.from);
    ensureDir(originMailDir);
    fs.writeFileSync(path.join(originMailDir, `result-${task_id}.json`), JSON.stringify({
      id: `result-${task_id}`,
      type: 'result',
      from: AGENT_ID,
      fromName: getAgentName(AGENT_ID),
      to: taskRecord.from,
      taskId: task_id,
      task: taskRecord.task,
      result,
      timestamp: Date.now(),
    }, null, 2));

    return { content: [{ type: 'text', text: JSON.stringify({ completed: true, task_id }) }] };
  }
);

// Tool: check_task_status
server.tool(
  'check_task_status',
  'Check the status of a previously delegated task. Usually not needed since results are auto-delivered, but useful as a fallback.',
  { task_id: z.string().describe('The task_id to check') },
  async ({ task_id }) => {
    const taskPath = path.join(TASKS_DIR, `${task_id}.json`);
    try {
      const taskRecord = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
      const response = { task_id, status: taskRecord.status, to: taskRecord.to };
      if (taskRecord.status === 'completed') response.result = taskRecord.result;
      if (taskRecord.status === 'failed') response.error = taskRecord.error;
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    } catch {
      return { content: [{ type: 'text', text: `Error: Task "${task_id}" not found.` }], isError: true };
    }
  }
);

// Tool: check_messages
server.tool(
  'check_messages',
  'Check your mailbox for messages, delegated tasks, or task results from other agents. Messages are consumed on read (removed from mailbox after retrieval). Call this proactively - it is your only way to receive inbound communication.',
  {},
  async () => {
    const agentMailDir = path.join(MAIL_DIR, AGENT_ID);
    if (!fs.existsSync(agentMailDir)) {
      return { content: [{ type: 'text', text: JSON.stringify({ messages: [] }) }] };
    }

    const files = fs.readdirSync(agentMailDir).filter(f => f.endsWith('.json')).sort();
    const messages = [];
    for (const f of files) {
      const filePath = path.join(agentMailDir, f);
      try {
        const msg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        messages.push(msg);
        // Consume on read - delete after successful parse
        fs.unlinkSync(filePath);
      } catch {}
    }

    return { content: [{ type: 'text', text: JSON.stringify({ messages }, null, 2) }] };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Jents comms server error: ${err.message}\n`);
  process.exit(1);
});
