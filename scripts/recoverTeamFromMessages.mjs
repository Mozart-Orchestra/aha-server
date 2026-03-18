import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: node scripts/recoverTeamFromMessages.mjs <messages.jsonl> [output.json]');
  process.exit(1);
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath) {
  usage();
}

const raw = fs.readFileSync(inputPath, 'utf8');
const messages = raw
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function normalizeTitle(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractQuotedTitle(text) {
  if (!text) return null;
  const match = text.match(/"(.*?)"/);
  return match ? match[1].trim() : null;
}

function extractInlineTaskTitle(text) {
  if (!text) return null;
  const match = text.match(/创建了任务：\*\*(.+?)\*\*/);
  return match ? match[1].trim() : null;
}

function extractNewTask(text) {
  if (!text) return null;
  const match = text.match(/New Task Created\*\*: (.+?)\nAssignee: ([^\n]+)\nPriority: ([^\n]+)/s);
  if (!match) return null;
  return {
    title: match[1].trim(),
    assigneeSessionId: match[2].trim(),
    priority: match[3].trim()
  };
}

function extractTaskUpdated(text) {
  if (!text) return null;
  const match = text.match(/Task Updated\*\*: (.+?)\nAssignee: ([^\n]+)(?:\nPriority: ([^\n]+))?(?:\nComment: ([\s\S]+))?/);
  if (!match) return null;
  return {
    title: match[1].trim(),
    assigneeSessionId: match[2].trim(),
    priority: match[3]?.trim() ?? null,
    comment: match[4]?.trim() ?? null
  };
}

const taskIdByTitle = new Map();
const tempTasks = [];
const tasks = new Map();
const members = new Map();

function ensureTask(taskId) {
  if (!tasks.has(taskId)) {
    tasks.set(taskId, {
      id: taskId,
      title: null,
      status: null,
      priority: null,
      assigneeSessionId: null,
      assigneeRole: null,
      createdAt: null,
      updatedAt: null,
      blockers: [],
      comments: [],
      history: []
    });
  }
  return tasks.get(taskId);
}

function applyTaskEvent(taskId, event) {
  const task = ensureTask(taskId);
  if (event.title && !task.title) task.title = event.title;
  if (event.priority && !task.priority) task.priority = event.priority;
  if (event.assigneeSessionId && !task.assigneeSessionId) task.assigneeSessionId = event.assigneeSessionId;
  if (event.assigneeRole && !task.assigneeRole) task.assigneeRole = event.assigneeRole;
  if (event.createdAt && (!task.createdAt || event.createdAt < task.createdAt)) {
    task.createdAt = event.createdAt;
  }
  const shouldAdvanceStatus =
    event.updatedAt &&
    (!task.updatedAt || event.updatedAt >= task.updatedAt);
  if (event.updatedAt && (!task.updatedAt || event.updatedAt > task.updatedAt)) {
    task.updatedAt = event.updatedAt;
  }
  if (event.status && (shouldAdvanceStatus || !task.status)) {
    task.status = event.status;
  }
  if (event.comment) task.comments.push({ timestamp: event.updatedAt ?? event.createdAt ?? null, comment: event.comment });
  if (event.blocker) task.blockers.push(event.blocker);
  task.history.push(event);
}

for (const message of messages) {
  if (message.fromSessionId) {
    const member = members.get(message.fromSessionId) ?? {
      sessionId: message.fromSessionId,
      role: message.fromRole ?? null,
      firstSeenAt: message.timestamp ?? null,
      lastSeenAt: message.timestamp ?? null
    };
    member.role ||= message.fromRole ?? null;
    member.lastSeenAt = message.timestamp ?? member.lastSeenAt;
    members.set(message.fromSessionId, member);
  }

  const content = message.content ?? '';
  if (content.includes('task IDs 如下')) {
    const matches = [...content.matchAll(/`([A-Za-z0-9]+)`\s*-\s*([^\n]+?)(?:\s*→|\s*$)/gm)];
    for (const [, taskId, title] of matches) {
      taskIdByTitle.set(normalizeTitle(title), taskId);
    }
  }

  const metadataTaskId = message.metadata?.taskId ?? null;
  if (metadataTaskId) {
    const event = {
      title: extractQuotedTitle(content) ?? extractInlineTaskTitle(content) ?? message.metadata?.title ?? null,
      status: message.metadata?.newStatus ?? message.metadata?.status ?? null,
      priority: message.metadata?.priority ?? null,
      assigneeSessionId: null,
      assigneeRole: message.fromRole ?? null,
      createdAt: message.timestamp ?? null,
      updatedAt: message.timestamp ?? null,
      blocker: message.metadata?.blockerId
        ? {
            blockerId: message.metadata.blockerId,
            type: message.metadata.blockerType ?? null,
            description: message.metadata.description ?? null
          }
        : null,
      comment: message.metadata?.description ?? null
    };
    applyTaskEvent(metadataTaskId, event);
  }

  const newTask = extractNewTask(content);
  if (newTask) {
    const mappedTaskId = taskIdByTitle.get(normalizeTitle(newTask.title));
    if (mappedTaskId) {
      applyTaskEvent(mappedTaskId, {
        ...newTask,
        status: 'todo',
        createdAt: message.timestamp ?? null,
        updatedAt: message.timestamp ?? null,
        assigneeRole: null
      });
    } else {
      tempTasks.push({
        id: `temp:${message.timestamp}:${tempTasks.length}`,
        ...newTask,
        status: 'todo',
        createdAt: message.timestamp ?? null,
        updatedAt: message.timestamp ?? null
      });
    }
    continue;
  }

  const updatedTask = extractTaskUpdated(content);
  if (updatedTask) {
    const mappedTaskId = taskIdByTitle.get(normalizeTitle(updatedTask.title));
    if (mappedTaskId) {
      applyTaskEvent(mappedTaskId, {
        ...updatedTask,
        updatedAt: message.timestamp ?? null,
        assigneeRole: null
      });
    } else {
      const matchedTask = [...tasks.values()].find((task) => task.title && normalizeTitle(task.title) === normalizeTitle(updatedTask.title));
      if (matchedTask) {
        applyTaskEvent(matchedTask.id, {
          ...updatedTask,
          updatedAt: message.timestamp ?? null,
          assigneeRole: null
        });
      }
    }
    continue;
  }
}

for (const tempTask of tempTasks) {
  const normalized = normalizeTitle(tempTask.title);
  const mappedTaskId = taskIdByTitle.get(normalized);
  if (mappedTaskId) {
    applyTaskEvent(mappedTaskId, {
      ...tempTask,
      assigneeRole: null
    });
    continue;
  }

  let matched = null;
  for (const task of tasks.values()) {
    if (task.title && normalizeTitle(task.title) === normalized) {
      matched = task.id;
      break;
    }
  }
  if (matched) {
    applyTaskEvent(matched, {
      ...tempTask,
      assigneeRole: null
    });
  } else {
    applyTaskEvent(tempTask.id, {
      ...tempTask,
      assigneeRole: null
    });
  }
}

const recovered = {
  source: path.resolve(inputPath),
  teamId: messages[0]?.teamId ?? null,
  messageCount: messages.length,
  recoveredAt: new Date().toISOString(),
  members: [...members.values()].sort((a, b) => (a.firstSeenAt ?? 0) - (b.firstSeenAt ?? 0)),
  tasks: [...tasks.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
};

const output = JSON.stringify(recovered, null, 2);
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  console.log(`Recovered team snapshot written to ${path.resolve(outputPath)}`);
} else {
  console.log(output);
}
