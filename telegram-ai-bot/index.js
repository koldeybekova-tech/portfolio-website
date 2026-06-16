import fs from "node:fs";

loadEnv();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const BOT_NAME = process.env.BOT_NAME || "AI bot";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful Telegram assistant. Answer clearly and briefly.";
const APPROVER_USER_IDS = parseCsv(process.env.APPROVER_USER_IDS);
const CONNECTORS = parseConnectors(process.env.CONNECTORS_JSON);
const AUTO_MEMORY = process.env.AUTO_MEMORY !== "false";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || "";
const RAILWAY_DEPLOY_HOOK_URL = process.env.RAILWAY_DEPLOY_HOOK_URL || "";
const DATA_DIR = "data";
const MEMORY_FILE = `${DATA_DIR}/memory.json`;
const HISTORY_FILE = `${DATA_DIR}/history.jsonl`;
const TASKS_FILE = `${DATA_DIR}/tasks.json`;
const MAX_HISTORY_ITEMS = 16;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY in .env");

let offset = 0;
let botUsername = "";
let pendingActions = new Map();

const telegram = (method) =>
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

async function main() {
  const me = await telegramCall("getMe");
  botUsername = me.username ? `@${me.username}` : "";
  console.log(`${BOT_NAME} is running as ${botUsername || me.first_name}`);

  while (true) {
    try {
      await pollOnce();
    } catch (error) {
      console.error("Polling error:", error.message);
      await sleep(2000);
    }
  }
}

async function pollOnce() {
  const updates = await telegramCall("getUpdates", {
    offset,
    timeout: 30,
    allowed_updates: ["message"],
  });

  for (const update of updates) {
    offset = update.update_id + 1;
    await safeHandleMessage(update.message);
  }
}

async function safeHandleMessage(message) {
  try {
    await handleMessage(message);
  } catch (error) {
    console.error("Message error:", error.message);
    if (message?.chat?.id) {
      await sendMessage(
        message.chat.id,
        `I got an error while answering: ${error.message}`
      ).catch((sendError) => {
        console.error("Could not send error to Telegram:", sendError.message);
      });
    }
  }
}

async function handleMessage(message) {
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const isPrivate = message.chat.type === "private";
  const mentioned = botUsername && text.includes(botUsername);
  const addressedByName = /^бот[,:\s]|^bot[,:\s]/i.test(text);
  const command =
    text.startsWith("/ask") ||
    text.startsWith("/start") ||
    text.startsWith("/help") ||
    text.startsWith("/whoami") ||
    text.startsWith("/remember") ||
    text.startsWith("/memory") ||
    text.startsWith("/history") ||
    text.startsWith("/forget") ||
    text.startsWith("/todo") ||
    text.startsWith("/todos") ||
    text.startsWith("/done") ||
    text.startsWith("/undone") ||
    text.startsWith("/delete") ||
    text.startsWith("/task") ||
    text.startsWith("/tools") ||
    text.startsWith("/tool") ||
    text.startsWith("/actions") ||
    text.startsWith("/act") ||
    text.startsWith("/do") ||
    text.startsWith("/connectors") ||
    text.startsWith("/run") ||
    text.startsWith("/approve") ||
    text.startsWith("/reject");

  if (!isPrivate && !mentioned && !command && !addressedByName) return;
  recordHistory(message, "user", text);

  if (text.startsWith("/start")) {
    await sendMessage(
      chatId,
      `Hi, I’m ${BOT_NAME}. Ask me anything here, or tag ${botUsername} in a group chat.`
    );
    return;
  }

  maybeAutoRemember(message, text);

  if (text.startsWith("/help")) {
    await sendMessage(chatId, helpText());
    return;
  }

  if (text.startsWith("/whoami")) {
    await sendMessage(chatId, `Your Telegram user id: ${message.from?.id || "unknown"}`);
    return;
  }

  if (text.startsWith("/connectors")) {
    await sendMessage(chatId, connectorsText());
    return;
  }

  if (text.startsWith("/approve")) {
    await approveAction(message, text);
    return;
  }

  if (text.startsWith("/reject")) {
    await rejectAction(message, text);
    return;
  }

  if (text.startsWith("/remember")) {
    await rememberCommand(message, text);
    return;
  }

  if (text.startsWith("/memory")) {
    await memoryCommand(chatId);
    return;
  }

  if (text.startsWith("/history")) {
    await historyCommand(chatId);
    return;
  }

  if (text.startsWith("/forget")) {
    await forgetCommand(message, text);
    return;
  }

  if (text.startsWith("/todo")) {
    await todoCommand(message, text);
    return;
  }

  if (text.startsWith("/todos")) {
    await todosCommand(chatId);
    return;
  }

  if (text.startsWith("/done")) {
    await updateTaskStatusCommand(message, text, true);
    return;
  }

  if (text.startsWith("/undone")) {
    await updateTaskStatusCommand(message, text, false);
    return;
  }

  if (text.startsWith("/delete")) {
    await deleteTaskCommand(message, text);
    return;
  }

  if (text.startsWith("/tools")) {
    await sendMessage(chatId, toolsText());
    return;
  }

  if (text.startsWith("/tool")) {
    await toolCommand(message, text);
    return;
  }

  if (text.startsWith("/actions")) {
    await sendMessage(chatId, actionsText());
    return;
  }

  if (text.startsWith("/act")) {
    await queueWriteToolAction(message, text);
    return;
  }

  const routed = !command
    ? routeNaturalMessage(text, { isPrivate, mentioned, addressedByName })
    : null;

  if (routed?.type === "memory") {
    await rememberFact(message, routed.text);
    return;
  }

  if (routed?.type === "todo") {
    await addTask(message, routed.text);
    return;
  }

  if (routed?.type === "todos") {
    await todosCommand(chatId);
    return;
  }

  if (routed?.type === "deleteTask") {
    await deleteTaskById(message, routed.id);
    return;
  }

  if (routed?.type === "tool") {
    await runToolFromParts(message, routed.toolName, routed.input);
    return;
  }

  if (routed?.type === "builtin") {
    await queueBuiltinActionFromParts(message, routed.actionName, routed.text);
    return;
  }

  await sendChatAction(chatId, "typing");

  if (text.startsWith("/task")) {
    const task = text.replace(/^\/task(@\w+)?/i, "").trim();
    if (!task) {
      await sendMessage(chatId, "Write a task after /task.");
      return;
    }
    const plan = await askAI(
      chatId,
      `Create a safe, practical task plan. Do not claim you executed anything. Task: ${task}`
    );
    await sendMessage(chatId, `Task plan:\n\n${plan}`);
    return;
  }

  if (text.startsWith("/do")) {
    await queueBuiltinAction(message, text);
    return;
  }

  if (text.startsWith("/run")) {
    await queueConnectorAction(message, text);
    return;
  }

  const cleaned = (routed?.type === "ask" ? routed.text : text)
    .replace(botUsername, "")
    .replace(/^\/ask(@\w+)?/i, "")
    .trim();

  if (!cleaned) {
    await sendMessage(chatId, "Write a question after /ask or tag me with a message.");
    return;
  }

  const answer = await askAI(chatId, cleaned);
  await sendMessage(chatId, answer);
}

async function askAI(chatId, userText) {
  return askGroq(userText, buildContext(chatId));
}

async function askGroq(userText, context = "") {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: "system",
          content: [SYSTEM_PROMPT, context].filter(Boolean).join("\n\n"),
        },
        {
          role: "user",
          content: userText,
        },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Groq request failed");
  }

  return data.choices?.[0]?.message?.content?.trim() || "I could not generate an answer.";
}

async function askOpenAI(chatId, userText) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [SYSTEM_PROMPT, buildContext(chatId)].filter(Boolean).join("\n\n"),
        },
        {
          role: "user",
          content: userText,
        },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI request failed");
  }

  return data.output_text || "I could not generate an answer.";
}

async function queueConnectorAction(message, text) {
  const chatId = message.chat.id;
  const match = text.match(/^\/run(?:@\w+)?\s+([a-zA-Z0-9_-]+)\s+([\s\S]+)/);
  if (!match) {
    await sendMessage(chatId, "Use: /run connector_name task description");
    return;
  }

  const [, connectorName, task] = match;
  const connector = CONNECTORS.find((item) => item.name === connectorName);
  if (!connector) {
    await sendMessage(chatId, `Unknown connector: ${connectorName}\n\n${connectorsText()}`);
    return;
  }

  const action = {
    id: createActionId(),
    type: "connector",
    connectorName,
    task: task.trim(),
    chatId,
    requestedBy: message.from?.id,
    requestedByName: message.from?.username || message.from?.first_name || "unknown",
    createdAt: new Date().toISOString(),
  };
  pendingActions.set(action.id, action);

  if (connector.requiresApproval === false) {
    await executeConnectorAction(action);
    return;
  }

  await sendMessage(
    chatId,
    [
      "Approval required before I call an external server.",
      "",
      `Action id: ${action.id}`,
      `Connector: ${connectorName}`,
      `Task: ${action.task}`,
      "",
      `Approve: /approve ${action.id}`,
      `Reject: /reject ${action.id}`,
    ].join("\n")
  );
}

async function queueBuiltinAction(message, text) {
  const chatId = message.chat.id;
  const match = text.match(/^\/do(?:@\w+)?\s+([a-zA-Z0-9_-]+)\s+([\s\S]+)/);
  if (!match) {
    await sendMessage(chatId, builtinHelpText());
    return;
  }

  const [, actionName, task] = match;
  const allowed = ["draft", "summarize", "translate", "checklist", "note"];
  if (!allowed.includes(actionName)) {
    await sendMessage(chatId, builtinHelpText());
    return;
  }

  const action = {
    id: createActionId(),
    type: "builtin",
    actionName,
    task: task.trim(),
    chatId,
    requestedBy: message.from?.id,
    requestedByName: message.from?.username || message.from?.first_name || "unknown",
    createdAt: new Date().toISOString(),
  };
  pendingActions.set(action.id, action);

  await sendMessage(
    chatId,
    [
      "Approval required before I execute this task.",
      "",
      `Action id: ${action.id}`,
      `Action: ${actionName}`,
      `Task: ${action.task}`,
      "",
      `Approve: /approve ${action.id}`,
      `Reject: /reject ${action.id}`,
    ].join("\n")
  );
}

async function queueBuiltinActionFromParts(message, actionName, task) {
  await queueBuiltinAction(message, `/do ${actionName} ${task}`);
}

async function toolCommand(message, text) {
  const chatId = message.chat.id;
  const match = text.match(/^\/tool(?:@\w+)?\s+([a-zA-Z0-9_-]+)\s*([\s\S]*)/);

  if (!match) {
    await sendMessage(chatId, toolsText());
    return;
  }

  const [, toolName, input] = match;
  await runToolFromParts(message, toolName, input.trim());
}

async function runToolFromParts(message, toolName, input) {
  const chatId = message.chat.id;
  const normalizedTool = String(toolName).toLowerCase();

  if (!input) {
    await sendMessage(chatId, `Write input after /tool ${normalizedTool}.\n\n${toolsText()}`);
    return;
  }

  await sendChatAction(chatId, "typing");

  try {
    let result = "";

    if (normalizedTool === "dns" || normalizedTool === "domain") {
      result = await checkDnsTool(input);
    } else if (normalizedTool === "website" || normalizedTool === "site") {
      result = await checkWebsiteTool(input);
    } else if (normalizedTool === "github" || normalizedTool === "repo") {
      result = await checkGitHubTool(input);
    } else {
      await sendMessage(chatId, toolsText());
      return;
    }

    await sendMessage(chatId, result);
  } catch (error) {
    await sendMessage(chatId, `Tool ${normalizedTool} failed: ${error.message}`);
  }
}

async function approveAction(message, text) {
  const chatId = message.chat.id;
  const id = text.replace(/^\/approve(@\w+)?/i, "").trim();
  const action = pendingActions.get(id);

  if (!action) {
    await sendMessage(chatId, "I could not find that pending action.");
    return;
  }

  if (!canApprove(message.from?.id, action)) {
    await sendMessage(chatId, "You are not allowed to approve this action.");
    return;
  }

  if (action.type === "builtin") {
    await executeBuiltinAction(action);
    return;
  }

  if (action.type === "writeTool") {
    await executeWriteToolAction(action);
    return;
  }

  await executeConnectorAction(action);
}

async function rejectAction(message, text) {
  const chatId = message.chat.id;
  const id = text.replace(/^\/reject(@\w+)?/i, "").trim();
  const action = pendingActions.get(id);

  if (!action) {
    await sendMessage(chatId, "I could not find that pending action.");
    return;
  }

  if (!canApprove(message.from?.id, action)) {
    await sendMessage(chatId, "You are not allowed to reject this action.");
    return;
  }

  pendingActions.delete(id);
  await sendMessage(chatId, `Rejected action ${id}.`);
}

async function executeConnectorAction(action) {
  const connector = CONNECTORS.find((item) => item.name === action.connectorName);
  if (!connector) {
    await sendMessage(action.chatId, `Connector ${action.connectorName} is no longer configured.`);
    pendingActions.delete(action.id);
    return;
  }

  try {
    const response = await fetch(connector.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(connector.token ? { Authorization: `Bearer ${connector.token}` } : {}),
      },
      body: JSON.stringify({
        actionId: action.id,
        task: action.task,
        chatId: action.chatId,
        requestedBy: action.requestedBy,
        requestedByName: action.requestedByName,
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(body || `Connector returned ${response.status}`);
    }

    pendingActions.delete(action.id);
    await sendMessage(
      action.chatId,
      `Done. Connector ${action.connectorName} accepted action ${action.id}.\n\n${body.slice(0, 1200)}`
    );
  } catch (error) {
    await sendMessage(
      action.chatId,
      `Connector call failed for ${action.id}: ${error.message}`
    );
  }
}

async function executeBuiltinAction(action) {
  try {
    let result = "";

    if (action.actionName === "note") {
      result = await saveNote(action);
    } else {
      result = await askAI(action.chatId, builtinPrompt(action.actionName, action.task));
    }

    pendingActions.delete(action.id);
    await sendMessage(action.chatId, `Done: ${action.actionName}\n\n${result}`);
  } catch (error) {
    await sendMessage(action.chatId, `Built-in action failed for ${action.id}: ${error.message}`);
  }
}

async function queueWriteToolAction(message, text) {
  const chatId = message.chat.id;
  const match = text.match(/^\/act(?:@\w+)?\s+([a-zA-Z0-9_-]+)\s*([\s\S]*)/);

  if (!match) {
    await sendMessage(chatId, actionsText());
    return;
  }

  const [, actionNameRaw, rawInput] = match;
  const actionName = actionNameRaw.toLowerCase();
  const allowed = ["github-issue", "cloudflare-cname", "cloudflare-a", "railway-deploy"];

  if (!allowed.includes(actionName)) {
    await sendMessage(chatId, actionsText());
    return;
  }

  const input = rawInput.trim();
  if (!input && actionName !== "railway-deploy") {
    await sendMessage(chatId, actionsText());
    return;
  }

  const action = {
    id: createActionId(),
    type: "writeTool",
    actionName,
    input,
    chatId,
    requestedBy: message.from?.id,
    requestedByName: message.from?.username || message.from?.first_name || "unknown",
    createdAt: new Date().toISOString(),
  };

  try {
    action.preview = previewWriteToolAction(action);
  } catch (error) {
    await sendMessage(chatId, `I cannot queue that action yet: ${error.message}\n\n${actionsText()}`);
    return;
  }

  pendingActions.set(action.id, action);

  await sendMessage(
    chatId,
    [
      "Approval required before I change an external service.",
      "",
      `Action id: ${action.id}`,
      `Action: ${action.actionName}`,
      action.preview,
      "",
      `Approve: /approve ${action.id}`,
      `Reject: /reject ${action.id}`,
    ].join("\n")
  );
}

function previewWriteToolAction(action) {
  if (action.actionName === "github-issue") {
    const { repo, title } = parseGitHubIssueInput(action.input);
    return [`GitHub repo: ${repo}`, `Issue title: ${title}`].join("\n");
  }

  if (action.actionName === "cloudflare-cname" || action.actionName === "cloudflare-a") {
    const parsed = parseCloudflareDnsInput(action);
    return [
      `Zone: ${parsed.zone}`,
      `Record: ${parsed.type} ${parsed.fullName}`,
      `Target: ${parsed.content}`,
      `Proxied: ${parsed.proxied ? "true" : "false"}`,
    ].join("\n");
  }

  if (action.actionName === "railway-deploy") {
    return `Railway deploy hook: ${action.input || "manual redeploy"}`;
  }

  throw new Error("Unknown action.");
}

async function executeWriteToolAction(action) {
  try {
    let result = "";

    if (action.actionName === "github-issue") {
      result = await createGitHubIssueAction(action);
    } else if (action.actionName === "cloudflare-cname" || action.actionName === "cloudflare-a") {
      result = await upsertCloudflareDnsAction(action);
    } else if (action.actionName === "railway-deploy") {
      result = await triggerRailwayDeployHookAction(action);
    } else {
      throw new Error(`Unknown write action: ${action.actionName}`);
    }

    pendingActions.delete(action.id);
    await sendMessage(action.chatId, `Done: ${action.actionName}\n\n${result}`);
  } catch (error) {
    await sendMessage(action.chatId, `Write action failed for ${action.id}: ${error.message}`);
  }
}

async function createGitHubIssueAction(action) {
  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN in Railway variables.");
  }

  const { repo, title, body } = parseGitHubIssueInput(action.input);
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": `${BOT_NAME.replace(/\s+/g, "-")}/1.0`,
    },
    body: JSON.stringify({ title, body }),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `GitHub returned ${response.status}`);
  }

  return `Created issue: ${data.html_url || `${repo}#${data.number || ""}`}`;
}

async function upsertCloudflareDnsAction(action) {
  if (!CLOUDFLARE_API_TOKEN) {
    throw new Error("Missing CLOUDFLARE_API_TOKEN in Railway variables.");
  }

  const parsed = parseCloudflareDnsInput(action);
  const zoneId = await getCloudflareZoneId(parsed.zone);
  const query = new URLSearchParams({
    type: parsed.type,
    name: parsed.fullName,
  });
  const existing = await cloudflareRequest(
    `/zones/${zoneId}/dns_records?${query.toString()}`
  );
  const found = Array.isArray(existing.result) ? existing.result[0] : null;
  const payload = {
    type: parsed.type,
    name: parsed.fullName,
    content: parsed.content,
    proxied: parsed.proxied,
  };

  const result = found
    ? await cloudflareRequest(`/zones/${zoneId}/dns_records/${found.id}`, "PUT", payload)
    : await cloudflareRequest(`/zones/${zoneId}/dns_records`, "POST", payload);

  const record = result.result || payload;
  return [
    `${found ? "Updated" : "Created"} Cloudflare DNS record.`,
    `${record.type || parsed.type} ${record.name || parsed.fullName} -> ${record.content || parsed.content}`,
    `Proxied: ${record.proxied ? "true" : "false"}`,
  ].join("\n");
}

async function triggerRailwayDeployHookAction() {
  if (!RAILWAY_DEPLOY_HOOK_URL) {
    throw new Error(
      "Missing RAILWAY_DEPLOY_HOOK_URL in Railway variables. Create a Deploy Hook in Railway and add it first."
    );
  }

  const response = await fetch(RAILWAY_DEPLOY_HOOK_URL, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(body || `Railway deploy hook returned ${response.status}`);
  }

  return body ? `Railway deploy hook accepted the request.\n${body.slice(0, 800)}` : "Railway deploy hook accepted the request.";
}

function parseGitHubIssueInput(input) {
  const parts = parsePipeArgs(input);
  if (parts.length < 2) {
    throw new Error("Use: /act github-issue owner/repo | title | body");
  }

  return {
    repo: parseGitHubRepo(parts[0]),
    title: parts[1],
    body: parts[2] || `Created by ${BOT_NAME} after Telegram approval.`,
  };
}

function parseCloudflareDnsInput(action) {
  const parts = parsePipeArgs(action.input);
  if (parts.length < 3) {
    throw new Error(
      `Use: /act ${action.actionName} bysymbat.com | @ or www | target | false`
    );
  }

  const zone = normalizeDomain(parts[0]);
  const shortName = parts[1].trim();
  const content = parts[2].trim();
  const proxied = String(parts[3] || "false").trim().toLowerCase() === "true";
  const type = action.actionName === "cloudflare-a" ? "A" : "CNAME";
  const fullName = fullDnsName(shortName, zone);

  if (!content) throw new Error("DNS target cannot be empty.");
  if (type === "A" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(content)) {
    throw new Error("A record target must be an IPv4 address.");
  }

  return { zone, type, fullName, content, proxied };
}

function fullDnsName(name, zone) {
  const clean = String(name).trim().toLowerCase().replace(/\.$/, "");
  if (!clean || clean === "@") return zone;
  if (clean === zone || clean.endsWith(`.${zone}`)) return clean;
  return `${clean}.${zone}`;
}

function parsePipeArgs(input) {
  return String(input)
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function getCloudflareZoneId(zone) {
  if (CLOUDFLARE_ZONE_ID) return CLOUDFLARE_ZONE_ID;

  const query = new URLSearchParams({ name: zone });
  const data = await cloudflareRequest(`/zones?${query.toString()}`);
  const found = Array.isArray(data.result) ? data.result[0] : null;
  if (!found?.id) {
    throw new Error(
      "Cloudflare zone was not found. Add CLOUDFLARE_ZONE_ID to Railway variables."
    );
  }

  return found.id;
}

async function cloudflareRequest(path, method = "GET", body = null) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    const message = data.errors?.[0]?.message || data.message || `Cloudflare returned ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function saveNote(action) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const note = {
    id: action.id,
    text: action.task,
    requestedBy: action.requestedBy,
    requestedByName: action.requestedByName,
    createdAt: action.createdAt,
  };
  fs.appendFileSync("data/notes.jsonl", `${JSON.stringify(note)}\n`, "utf8");
  return `Saved note ${action.id}.`;
}

async function rememberCommand(message, text) {
  const chatId = message.chat.id;
  const fact = text.replace(/^\/remember(@\w+)?/i, "").trim();

  if (!fact) {
    await sendMessage(chatId, "Write what I should remember after /remember.");
    return;
  }

  await rememberFact(message, fact);
}

async function rememberFact(message, fact) {
  const chatId = message.chat.id;
  const item = {
    id: createActionId(),
    chatId,
    text: fact,
    createdBy: message.from?.id,
    createdByName: message.from?.username || message.from?.first_name || "unknown",
    createdAt: new Date().toISOString(),
  };
  const memory = readMemory();
  memory.push(item);
  writeMemory(memory);

  await sendMessage(chatId, `Remembered (${item.id}): ${fact}`);
}

function maybeAutoRemember(message, text) {
  if (!AUTO_MEMORY) return;
  if (!text || text.startsWith("/")) return;
  if (looksSensitive(text)) return;

  const fact = extractAutoMemoryFact(text);
  if (!fact) return;

  const chatId = message.chat.id;
  const memory = readMemory();
  const exists = memory.some(
    (item) => String(item.chatId) === String(chatId) && normalize(item.text) === normalize(fact)
  );
  if (exists) return;

  memory.push({
    id: createActionId(),
    chatId,
    text: fact,
    auto: true,
    createdBy: message.from?.id,
    createdByName: message.from?.username || message.from?.first_name || "unknown",
    createdAt: new Date().toISOString(),
  });
  writeMemory(memory);
}

function extractAutoMemoryFact(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  const lower = clean.toLowerCase();
  const hasUrl = /https?:\/\/|[a-z0-9-]+\.[a-z]{2,}/i.test(clean);
  const importantWords = [
    "мой ",
    "моя ",
    "мое ",
    "моё ",
    "наш ",
    "наша ",
    "проект",
    "домен",
    "github",
    "repo",
    "repository",
    "портфолио",
    "сайт",
    "бот",
    "люблю",
    "предпочитаю",
    "стиль",
    "remember",
  ];
  const important = importantWords.some((word) => lower.includes(word));

  if (!hasUrl && !important) return "";
  if (clean.length < 12 || clean.length > 360) return "";
  if (clean.endsWith("?")) return "";

  return clean;
}

function looksSensitive(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("token") ||
    lower.includes("api key") ||
    lower.includes("apikey") ||
    lower.includes("password") ||
    lower.includes("пароль") ||
    lower.includes("секрет") ||
    /sk-[a-z0-9_-]{20,}/i.test(text) ||
    /gsk_[a-z0-9_-]{20,}/i.test(text) ||
    /github_pat_[a-z0-9_]{20,}/i.test(text) ||
    /\d{7,}:[a-z0-9_-]{20,}/i.test(text)
  );
}

function normalize(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, " ");
}

async function memoryCommand(chatId) {
  const items = readMemory().filter((item) => String(item.chatId) === String(chatId));

  if (!items.length) {
    await sendMessage(chatId, "I do not have saved memory for this chat yet.");
    return;
  }

  await sendMessage(
    chatId,
    [
      "Saved memory for this chat:",
      "",
      ...items.slice(-20).map((item) => `- ${item.id}: ${item.text}`),
    ].join("\n")
  );
}

async function historyCommand(chatId) {
  const items = readRecentHistory(chatId, 10);

  if (!items.length) {
    await sendMessage(chatId, "No recent history saved for this chat yet.");
    return;
  }

  await sendMessage(
    chatId,
    [
      "Recent history:",
      "",
      ...items.map((item) => `${item.role}: ${item.text}`),
    ].join("\n")
  );
}

async function forgetCommand(message, text) {
  const chatId = message.chat.id;
  const target = text.replace(/^\/forget(@\w+)?/i, "").trim();

  if (!target) {
    await sendMessage(chatId, "Use /forget MEMORY_ID or /forget all");
    return;
  }

  const memory = readMemory();
  let next = memory;
  let removed = 0;

  if (target.toLowerCase() === "all") {
    next = memory.filter((item) => String(item.chatId) !== String(chatId));
    removed = memory.length - next.length;
  } else {
    next = memory.filter((item) => {
      const match = String(item.chatId) === String(chatId) && item.id === target;
      if (match) removed += 1;
      return !match;
    });
  }

  writeMemory(next);
  await sendMessage(chatId, removed ? `Forgot ${removed} memory item(s).` : "I did not find that memory item.");
}

async function todoCommand(message, text) {
  const chatId = message.chat.id;
  const taskText = text.replace(/^\/todo(@\w+)?/i, "").trim();

  if (!taskText) {
    await sendMessage(chatId, "Write a task after /todo.");
    return;
  }

  await addTask(message, taskText);
}

async function addTask(message, taskText) {
  const chatId = message.chat.id;

  if (taskText.length < 4) {
    await sendMessage(chatId, "Task is too short. Please write a clearer task.");
    return;
  }

  const task = {
    id: createActionId(),
    chatId,
    text: taskText,
    done: false,
    createdBy: message.from?.id,
    createdByName: message.from?.username || message.from?.first_name || "unknown",
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  const tasks = readTasks();
  tasks.push(task);
  writeTasks(tasks);

  await sendMessage(chatId, `Added task ${task.id}: ${task.text}`);
}

async function todosCommand(chatId) {
  const tasks = readTasks().filter((task) => String(task.chatId) === String(chatId));

  if (!tasks.length) {
    await sendMessage(chatId, "No tasks saved for this chat yet.");
    return;
  }

  const open = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done).slice(-8);
  const lines = [];

  if (open.length) {
    lines.push("Open tasks:");
    lines.push(...open.map((task) => `- ${task.id}: ${task.text}`));
  } else {
    lines.push("Open tasks: none");
  }

  if (done.length) {
    lines.push("", "Recently done:");
    lines.push(...done.map((task) => `- ${task.id}: ${task.text}`));
  }

  await sendMessage(chatId, lines.join("\n"));
}

async function updateTaskStatusCommand(message, text, done) {
  const chatId = message.chat.id;
  const id = text.replace(done ? /^\/done(@\w+)?/i : /^\/undone(@\w+)?/i, "").trim();

  if (!id) {
    await sendMessage(chatId, `Use ${done ? "/done" : "/undone"} TASK_ID`);
    return;
  }

  const tasks = readTasks();
  const task = tasks.find(
    (item) => String(item.chatId) === String(chatId) && item.id === id
  );

  if (!task) {
    await sendMessage(chatId, "I did not find that task.");
    return;
  }

  task.done = done;
  task.completedAt = done ? new Date().toISOString() : null;
  writeTasks(tasks);

  await sendMessage(chatId, `${done ? "Completed" : "Reopened"} task ${task.id}: ${task.text}`);
}

async function deleteTaskCommand(message, text) {
  const chatId = message.chat.id;
  const id = text.replace(/^\/delete(@\w+)?/i, "").trim();

  if (!id) {
    await sendMessage(chatId, "Use /delete TASK_ID");
    return;
  }

  await deleteTaskById(message, id);
}

async function deleteTaskById(message, id) {
  const chatId = message.chat.id;
  const tasks = readTasks();
  const next = tasks.filter(
    (item) => !(String(item.chatId) === String(chatId) && item.id === id)
  );

  if (next.length === tasks.length) {
    await sendMessage(chatId, "I did not find that task.");
    return;
  }

  writeTasks(next);
  await sendMessage(chatId, `Deleted task ${id}.`);
}

async function checkDnsTool(input) {
  const domain = normalizeDomain(input);
  const [a, cname, ns] = await Promise.all([
    resolveDns(domain, "A"),
    resolveDns(domain, "CNAME"),
    resolveDns(domain, "NS"),
  ]);

  return [
    `DNS check for ${domain}:`,
    "",
    formatDnsAnswer("A", a),
    formatDnsAnswer("CNAME", cname),
    formatDnsAnswer("NS", ns),
  ].join("\n");
}

async function checkWebsiteTool(input) {
  const url = normalizeUrl(input);
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
    headers: {
      "User-Agent": `${BOT_NAME.replace(/\s+/g, "-")}/1.0`,
    },
  });
  const elapsed = Date.now() - startedAt;
  const contentType = response.headers.get("content-type") || "unknown";
  const body = contentType.includes("text/html") ? await response.text() : "";
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();

  return [
    `Website check: ${url}`,
    `Status: ${response.status} ${response.statusText}`,
    `Final URL: ${response.url}`,
    `Content-Type: ${contentType}`,
    `Response time: ${elapsed}ms`,
    title ? `Title: ${title}` : "Title: not found",
  ].join("\n");
}

async function checkGitHubTool(input) {
  const repo = parseGitHubRepo(input);
  const repoResponse = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `${BOT_NAME.replace(/\s+/g, "-")}/1.0`,
    },
    signal: AbortSignal.timeout(12000),
  });

  if (!repoResponse.ok) {
    throw new Error(`GitHub returned ${repoResponse.status}. If this repo is private, add a safe connector or GitHub token later.`);
  }

  const repoData = await repoResponse.json();
  const commitResponse = await fetch(
    `https://api.github.com/repos/${repo}/commits?per_page=1&sha=${encodeURIComponent(repoData.default_branch)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${BOT_NAME.replace(/\s+/g, "-")}/1.0`,
      },
      signal: AbortSignal.timeout(12000),
    }
  );
  const commits = commitResponse.ok ? await commitResponse.json() : [];
  const latest = Array.isArray(commits) ? commits[0] : null;

  return [
    `GitHub repo check: ${repoData.full_name}`,
    `Visibility: ${repoData.private ? "private" : "public"}`,
    `Default branch: ${repoData.default_branch}`,
    `Open issues: ${repoData.open_issues_count}`,
    `Last push: ${repoData.pushed_at || "unknown"}`,
    latest?.sha ? `Latest commit: ${latest.sha.slice(0, 7)} - ${latest.commit?.message?.split("\n")[0] || "no message"}` : "Latest commit: not available",
  ].join("\n");
}

async function resolveDns(domain, type) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${encodeURIComponent(type)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) {
    throw new Error(`DNS resolver returned ${response.status}`);
  }

  return response.json();
}

function formatDnsAnswer(label, data) {
  const answers = Array.isArray(data.Answer) ? data.Answer : [];
  if (!answers.length) return `${label}: no records found`;
  return `${label}:\n${answers.map((item) => `- ${item.data}`).join("\n")}`;
}

function normalizeDomain(input) {
  const raw = String(input).trim();
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    const domain = raw.replace(/^https?:\/\//i, "").split("/")[0].replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      throw new Error("Please provide a valid domain, for example bysymbat.com");
    }
    return domain;
  }
}

function normalizeUrl(input) {
  const raw = String(input).trim();
  const url = raw.includes("://") ? raw : `https://${raw}`;
  try {
    return new URL(url).toString();
  } catch {
    throw new Error("Please provide a valid URL, for example https://bysymbat.com");
  }
}

function parseGitHubRepo(input) {
  const clean = String(input).trim();
  const githubMatch = clean.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  const slashMatch = clean.match(/^([^/\s]+)\/([^/\s#?]+)$/);
  const match = githubMatch || slashMatch;
  if (!match) {
    throw new Error("Please provide a GitHub repo like koldeybekova-tech/portfolio-website");
  }
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
}

function routeNaturalMessage(text, options = {}) {
  if (!options.isPrivate && !options.mentioned && !options.addressedByName) {
    return null;
  }

  const clean = stripNaturalAddress(text);
  const lower = clean.toLowerCase();

  const memory = prefixed(clean, lower, [
    "запомни, что ",
    "запомни что ",
    "запомни ",
    "remember that ",
    "remember ",
  ]);
  if (memory) return { type: "memory", text: memory };

  const todo = prefixed(clean, lower, [
    "добавь задачу ",
    "создай задачу ",
    "запиши задачу ",
    "добавь в задачи ",
    "add task ",
    "create task ",
    "todo ",
  ]);
  if (todo) return { type: "todo", text: todo };

  const deleteTask = prefixed(clean, lower, [
    "удали задачу ",
    "удалить задачу ",
    "убери задачу ",
    "delete task ",
    "remove task ",
  ]);
  if (deleteTask) return { type: "deleteTask", id: deleteTask };

  if (
    lower === "задачи" ||
    lower === "список задач" ||
    lower.includes("покажи задачи") ||
    lower.includes("какие задачи") ||
    lower.includes("открытые задачи") ||
    lower.includes("show tasks") ||
    lower.includes("my tasks")
  ) {
    return { type: "todos" };
  }

  const toolRoutes = [
    {
      toolName: "dns",
      prefixes: ["проверь домен ", "проверь dns ", "check domain ", "check dns "],
    },
    {
      toolName: "website",
      prefixes: ["проверь сайт ", "проверь url ", "check website ", "check site ", "check url "],
    },
    {
      toolName: "github",
      prefixes: ["проверь github ", "проверь репозиторий ", "check github ", "check repo "],
    },
  ];

  for (const route of toolRoutes) {
    const input = prefixed(clean, lower, route.prefixes);
    if (input) return { type: "tool", toolName: route.toolName, input };
  }

  const builtins = [
    {
      actionName: "translate",
      prefixes: ["переведи ", "translate "],
    },
    {
      actionName: "summarize",
      prefixes: ["суммируй ", "кратко перескажи ", "summarize "],
    },
    {
      actionName: "checklist",
      prefixes: ["сделай чеклист ", "создай чеклист ", "make checklist ", "create checklist "],
    },
    {
      actionName: "draft",
      prefixes: ["напиши текст ", "напиши сообщение ", "напиши письмо ", "draft ", "write "],
    },
    {
      actionName: "note",
      prefixes: ["сохрани заметку ", "save note "],
    },
  ];

  for (const route of builtins) {
    const task = prefixed(clean, lower, route.prefixes);
    if (task) return { type: "builtin", actionName: route.actionName, text: task };
  }

  return { type: "ask", text: clean };
}

function stripNaturalAddress(text) {
  return text
    .replace(botUsername, "")
    .replace(/^бот[,:\s]*/i, "")
    .replace(/^bot[,:\s]*/i, "")
    .trim();
}

function prefixed(clean, lower, prefixes) {
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return clean.slice(prefix.length).trim();
    }
  }
  return "";
}

function builtinPrompt(actionName, task) {
  const prompts = {
    draft:
      "Write the requested draft. Make it polished, useful, and ready to send. Request:",
    summarize:
      "Summarize the following clearly. Include key points and next steps if useful. Text:",
    translate:
      "Translate the following naturally. Preserve meaning and tone. Text:",
    checklist:
      "Turn the following into a practical checklist with clear action items. Task:",
  };
  return `${prompts[actionName] || "Complete this task:"}\n\n${task}`;
}

async function telegramCall(method, payload = {}) {
  const response = await fetch(telegram(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

async function sendMessage(chatId, text) {
  const sent = await telegramCall("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 3900),
  });
  recordHistory({ chat: { id: chatId } }, "assistant", text);
  return sent;
}

async function sendChatAction(chatId, action) {
  return telegramCall("sendChatAction", {
    chat_id: chatId,
    action,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helpText() {
  return [
    `${BOT_NAME} commands:`,
    "",
    "/ask question - ask the AI",
    "/remember fact - save memory for this chat",
    "/memory - show saved memory",
    "/history - show recent chat context",
    "/forget memory_id - delete one memory item",
    "/todo task - add a task",
    "/todos - show tasks",
    "/done task_id - mark task done",
    "/undone task_id - reopen task",
    "/delete task_id - delete task",
    "/task task - get a safe task plan",
    "/tools - show built-in read-only tools",
    "/tool dns bysymbat.com - check DNS records",
    "/tool website https://bysymbat.com - check a website",
    "/tool github owner/repo - check a GitHub repo",
    "/actions - show approved write-action tools",
    "/act action input - queue GitHub, Cloudflare, or Railway changes",
    "/do action task - execute a safe built-in action after approval",
    "/connectors - show allowed external servers",
    "/run connector_name task - request work through a connector",
    "/approve action_id - approve external work",
    "/reject action_id - reject external work",
    "/whoami - show your Telegram user id",
    "",
    "Natural phrases also work:",
    "запомни, что мой домен bysymbat.com",
    "добавь задачу проверить DNS",
    "покажи задачи",
    "удали задачу TASK_ID",
    "проверь домен bysymbat.com",
    "проверь сайт https://bysymbat.com",
    "проверь github koldeybekova-tech/portfolio-website",
    "переведи на английский: сайт готов",
    "",
    "In private chats, normal messages are questions.",
    "In group chats, tag me, say 'бот,' first, or use /ask, /task, or /run.",
  ].join("\n");
}

function toolsText() {
  return [
    "Built-in read-only tools:",
    "",
    "/tool dns bysymbat.com - check A, CNAME, and NS records",
    "/tool website https://bysymbat.com - check HTTP status, final URL, and title",
    "/tool github koldeybekova-tech/portfolio-website - check repo status and latest commit",
    "",
    "Natural phrases:",
    "проверь домен bysymbat.com",
    "проверь сайт https://bysymbat.com",
    "проверь github koldeybekova-tech/portfolio-website",
    "",
    "These tools only read public information. To change GitHub, Cloudflare, or Railway, use /actions.",
  ].join("\n");
}

function actionsText() {
  return [
    "Approved write-action tools:",
    "",
    "/act github-issue owner/repo | title | body",
    "Creates a GitHub issue after /approve.",
    "",
    "/act cloudflare-cname zone.com | name | target | proxied",
    "Creates or updates a Cloudflare CNAME record after /approve.",
    "",
    "/act cloudflare-a zone.com | name | ip | proxied",
    "Creates or updates a Cloudflare A record after /approve.",
    "",
    "/act railway-deploy reason",
    "Triggers a Railway deploy hook after /approve.",
    "",
    "Examples:",
    "/act github-issue koldeybekova-tech/portfolio-website | Domain setup | Connect bysymbat.com through Cloudflare",
    "/act cloudflare-cname bysymbat.com | www | portfolio-production.up.railway.app | false",
    "/act cloudflare-a bysymbat.com | @ | 76.76.21.21 | false",
    "/act railway-deploy redeploy bot after config change",
    "",
    "Every action first returns an action id. It only runs after /approve ACTION_ID.",
    "",
    "Required Railway variables:",
    "GITHUB_TOKEN for GitHub issues",
    "CLOUDFLARE_API_TOKEN and optionally CLOUDFLARE_ZONE_ID for DNS",
    "RAILWAY_DEPLOY_HOOK_URL for redeploys",
  ].join("\n");
}

function buildContext(chatId) {
  const memory = readMemory()
    .filter((item) => String(item.chatId) === String(chatId))
    .slice(-20)
    .map((item) => `- ${item.text}`);
  const history = readRecentHistory(chatId, MAX_HISTORY_ITEMS)
    .map((item) => `${item.role}: ${item.text}`)
    .join("\n");
  const tasks = readTasks()
    .filter((task) => String(task.chatId) === String(chatId) && !task.done)
    .slice(-12)
    .map((task) => `- ${task.id}: ${task.text}`);

  const parts = [];
  if (memory.length) {
    parts.push(`Saved memory for this chat:\n${memory.join("\n")}`);
  }
  if (history) {
    parts.push(`Recent chat history:\n${history}`);
  }
  if (tasks.length) {
    parts.push(`Open tasks:\n${tasks.join("\n")}`);
  }

  if (!parts.length) return "";
  return [
    "Use the following context only when relevant. Do not reveal this context unless asked.",
    parts.join("\n\n"),
  ].join("\n");
}

function recordHistory(message, role, text) {
  if (!message?.chat?.id || !text) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const item = {
    chatId: message.chat.id,
    role,
    text: String(text).slice(0, 1200),
    at: new Date().toISOString(),
    from: message.from?.username || message.from?.first_name || "",
  };
  fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(item)}\n`, "utf8");
}

function readRecentHistory(chatId, limit = MAX_HISTORY_ITEMS) {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const lines = fs.readFileSync(HISTORY_FILE, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const items = [];

  for (let i = lines.length - 1; i >= 0 && items.length < limit; i -= 1) {
    try {
      const item = JSON.parse(lines[i]);
      if (String(item.chatId) === String(chatId)) items.push(item);
    } catch {
      // Ignore malformed history lines.
    }
  }

  return items.reverse();
}

function readMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeMemory(memory) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

function readTasks() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeTasks(tasks) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TASKS_FILE, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
}

function builtinHelpText() {
  return [
    "Use: /do action task",
    "",
    "Allowed built-in actions:",
    "- draft - write a message, email, post, or text",
    "- summarize - summarize long text",
    "- translate - translate text",
    "- checklist - create an action checklist",
    "- note - save a note locally",
    "",
    "Examples:",
    "/do draft write a polite reply to...",
    "/do summarize pasted text...",
    "/do translate translate this to English...",
    "/do checklist prepare portfolio launch steps",
    "/do note remember to update the domain tomorrow",
  ].join("\n");
}

function connectorsText() {
  if (!CONNECTORS.length) {
    return "No connectors configured yet. Add CONNECTORS_JSON to .env.";
  }

  return [
    "Configured connectors:",
    ...CONNECTORS.map((item) => {
      const approval = item.requiresApproval === false ? "no approval" : "approval required";
      return `- ${item.name}: ${approval}`;
    }),
  ].join("\n");
}

function canApprove(userId, action) {
  if (!userId) return false;
  if (APPROVER_USER_IDS.length) return APPROVER_USER_IDS.includes(String(userId));
  return String(userId) === String(action.requestedBy);
}

function createActionId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function parseCsv(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseConnectors(value = "[]") {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && item.name && item.url)
      .map((item) => ({
        name: String(item.name),
        url: String(item.url),
        token: item.token ? String(item.token) : "",
        requiresApproval: item.requiresApproval !== false,
      }));
  } catch {
    console.warn("CONNECTORS_JSON is invalid. No connectors loaded.");
    return [];
  }
}

function loadEnv() {
  if (!fs.existsSync(".env")) return;

  const env = fs.readFileSync(".env", "utf8");
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    process.env[key] = value;
  }
}

main();
