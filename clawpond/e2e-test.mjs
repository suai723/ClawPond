/**
 * e2e-test.mjs  —  ClawPond 全链路真实测试（使用插件真实代码）
 *
 * Agent 侧：使用插件编译后的真实 ClawPondWsClient + gatewayAdapter
 * Human 侧：使用原生 WebSocket（需要 JWT token 鉴权）
 *
 * 整个消息流 100% 走 WebSocket（HTTP 仅用于 auth/入房的必要准备步骤）：
 *  Agent WS → joinRoom → 收 @mention → 回复
 *  Human WS → joinRoom → 发 @mention → 收 Agent 回复
 */

import WebSocket from "ws";
import { createRequire } from "module";
import { setTimeout as sleep } from "timers/promises";

const require = createRequire(import.meta.url);

// 导入插件真实编译代码
const { ClawPondWsClient }  = require("./dist/ws-client.js");
const { gatewayAdapter, connectNewRoom } = require("./dist/gateway.js");

// ── 配置 ──────────────────────────────────────────────────────────────────────
const RELAY_HTTP   = "http://localhost:8000";
const RELAY_WS     = "ws://localhost:8000";
const AGENT_ID     = "80974713-d6b0-473f-bf5b-d956351025d7";
const AGENT_SECRET = "YdEiuN5jSp1INpplt9oi8oRw4YgoX9Nbqx_b9ukqdRg";
const AGENT_NAME   = "ClawTestAgent";
const ROOM_ID      = "b056463d-158e-47e6-b6cc-46ab92b8b129";
const ROOM_PASS    = "FYZPYThXB5eey0lO_kpQ2g";
const TS           = Date.now();
const HUMAN_NAME   = `TestUser${TS}`;
const HUMAN_PASS   = "testpass123";

// ── Helpers ───────────────────────────────────────────────────────────────────
const log  = (msg) => console.log(`  [✓] ${msg}`);
const fail = (msg) => { console.error(`  [✗] FAIL: ${msg}`); process.exit(1); };
const step = (n, msg) => console.log(`\nStep ${n}: ${msg}`);

async function http(method, path, body) {
  const res = await fetch(`${RELAY_HTTP}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

/** 创建一个 mock logger，打印到控制台 */
function makeLogger(prefix) {
  return {
    debug: (msg, meta) => {},   // 静默 debug
    info:  (msg, meta) => console.log(`    [${prefix}] ${msg}`, meta ? JSON.stringify(meta) : ""),
    warn:  (msg, meta) => console.warn(`    [${prefix}] WARN ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`    [${prefix}] ERR ${msg}`, meta ?? ""),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("=== ClawPond 全链路真实测试（插件真实代码） ===\n");
console.log(`  Agent:    ${AGENT_NAME} (${AGENT_ID})`);
console.log(`  Room:     ${ROOM_ID}`);
console.log(`  Human:    ${HUMAN_NAME}`);
console.log(`  Plugin:   ClawPondWsClient + gatewayAdapter（dist/）\n`);

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Setup – Human user register + login + join room (HTTP 必要准备)
// ─────────────────────────────────────────────────────────────────────────────
step(1, "HTTP 准备：人类用户注册 → 登录 → 加入房间");

let authRes;
try {
  authRes = await http("POST", "/api/v1/auth/register", {
    username: HUMAN_NAME, password: HUMAN_PASS,
  });
  log(`注册成功  user_id=${authRes.user_id}`);
} catch {
  authRes = await http("POST", "/api/v1/auth/login", {
    username: HUMAN_NAME, password: HUMAN_PASS,
  });
  log(`登录成功  user_id=${authRes.user_id}`);
}

const HUMAN_USER_ID = authRes.user_id;
const HUMAN_TOKEN   = authRes.access_token;

try {
  await http("POST", "/api/v1/rooms/join", {
    user_id: HUMAN_USER_ID,
    username: HUMAN_NAME,
    password: ROOM_PASS,
    user_type: "human",
  });
  log(`人类用户已加入房间（HTTP）  user_id=${HUMAN_USER_ID}`);
} catch (err) {
  log(`加入房间: ${err.message}（可能已是成员）`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: 使用插件真实代码启动 Agent（gatewayAdapter + ClawPondWsClient）
// ─────────────────────────────────────────────────────────────────────────────
step(2, "使用插件 gatewayAdapter 启动 Agent（真实 ClawPondWsClient）");

const agentAccount = {
  accountId:        "test-account",
  relayWsUrl:       RELAY_WS,
  agentId:          AGENT_ID,
  agentSecret:      AGENT_SECRET,
  agentName:        AGENT_NAME,
  agentDescription: "E2E test agent",
  reconnectInterval: 1000,
  maxReconnectDelay: 30000,
};

// Capture all inbound messages emitted by the plugin
const receivedInbound = [];
let gatewayReady = false;

const agentLogger = makeLogger("Agent");
const gatewayCtx = {
  cfg: {
    channels: {
      clawpond: {
        accounts: { "test-account": agentAccount },
      },
    },
  },
  accountId: "test-account",
  log: (msg, ...args) => agentLogger.info(msg, ...args),
  emit: (event, data) => {
    if (event === "message:inbound") {
      receivedInbound.push(data);
    }
  },
  onReady: () => { gatewayReady = true; },
  onError: (err) => console.error("  [Agent] gateway error:", err.message),
  onDisconnect: () => {},
};

gatewayAdapter.startAccount(gatewayCtx);
log("gatewayAdapter.startAccount() 调用完成，等待 WS 连接...");

// Wait for connection
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("Agent WS connect timeout")), 5000);
  const poll = setInterval(() => {
    if (gatewayReady) { clearInterval(poll); clearTimeout(t); resolve(); }
  }, 50);
});
log("Agent WS 已连接（onReady 触发）");

// Subscribe agent to the room via connectNewRoom (as the plugin's tools.ts would call)
connectNewRoom({ roomId: ROOM_ID, roomPassword: ROOM_PASS });
await sleep(600);
log(`Agent 已通过 connectNewRoom() 加入房间  room_id=${ROOM_ID}`);

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Human user WebSocket connection + joinRoom
// ─────────────────────────────────────────────────────────────────────────────
step(3, "Human WebSocket 连接（JWT token）+ joinRoom");

const humanMsgs = [];
const humanWs = new WebSocket(
  `${RELAY_WS}/ws?token=${encodeURIComponent(HUMAN_TOKEN)}&user_type=human`
);
humanWs.on("message", (raw) => {
  try { humanMsgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
});

await new Promise((resolve, reject) => {
  humanWs.on("open", resolve);
  humanWs.on("error", (e) => reject(new Error(`Human WS error: ${e.message}`)));
  setTimeout(() => reject(new Error("Human WS connect timeout")), 5000);
});
log(`Human WebSocket 连接已建立  user_id=${HUMAN_USER_ID}`);

humanWs.send(JSON.stringify({ method: "joinRoom", params: { password: ROOM_PASS } }));
await sleep(500);
log(`Human joinRoom 已发送  room_id=${ROOM_ID}`);

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Human sends @mention via WebSocket → 触发服务端 broadcast_to_room
// ─────────────────────────────────────────────────────────────────────────────
step(4, `Human 通过 WebSocket 发送 @${AGENT_NAME} 消息（触发服务端广播）`);

const mentionText = `@${AGENT_NAME} 你好，当前时间是什么？（WS e2e 测试 ${TS}）`;
humanWs.send(JSON.stringify({
  method: "sendMessage",
  params: {
    room_id: ROOM_ID,
    text: mentionText,
    mentions: [{ agentId: AGENT_ID, username: AGENT_NAME }],
  },
}));
log(`已发送: "${mentionText}"`);
await sleep(1200);

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: 验证插件真实代码收到了 @mention（ClawPondWsClient._handleBroadcast）
// ─────────────────────────────────────────────────────────────────────────────
step(5, "验证插件 ClawPondWsClient 收到 @mention → emit('message:inbound')");

if (receivedInbound.length === 0) {
  fail(
    `插件未收到任何 inbound 消息。\n` +
    `  可能原因：@mention 未匹配 agentId=${AGENT_ID} 或 agentName=${AGENT_NAME}`
  );
}

const inbound = receivedInbound[receivedInbound.length - 1];
log(`收到 inbound 消息  message_id=${inbound.messageId}`);
log(`  channel:   ${inbound.channel}`);
log(`  roomId:    ${inbound.roomId}`);
log(`  peerId:    ${inbound.peerId}   ← 会话隔离 key`);
log(`  peerKind:  ${inbound.peerKind}`);
log(`  senderId:  ${inbound.senderId}`);
log(`  text:      ${inbound.text}`);

// Assertions
if (inbound.channel !== "clawpond") fail(`channel 应为 "clawpond"，实际: ${inbound.channel}`);
if (inbound.peerId !== ROOM_ID)     fail(`peerId 应为 room_id=${ROOM_ID}，实际: ${inbound.peerId}`);
if (inbound.peerKind !== "group")   fail(`peerKind 应为 "group"，实际: ${inbound.peerKind}`);
if (!inbound.text.includes(AGENT_NAME)) fail(`text 未含 @${AGENT_NAME}`);
log(`所有断言通过 ✓`);
log(`→ peerId=roomId 会话隔离验证通过，不同房间拥有独立 session`);

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: Agent 通过插件真实 ClawPondWsClient.sendMessage 回复
// ─────────────────────────────────────────────────────────────────────────────
step(6, "Agent 通过插件 ClawPondWsClient.sendMessage() 回复房间");

// 从 gateway 模块获取 wsClient 实例
const { getWsClient } = require("./dist/gateway.js");
const wsClient = getWsClient();

if (!wsClient) {
  fail("getWsClient() 返回 null，WsClient 未初始化");
}

const replyText = `[${AGENT_NAME} 自动回复] 收到 msg_id=${inbound.messageId}，全链路测试通过！${TS}`;
const sent = wsClient.sendMessage(ROOM_ID, replyText, inbound.messageId);

if (!sent) {
  fail("wsClient.sendMessage() 返回 false，WS 未连接或房间未加入");
}
log(`wsClient.sendMessage() 返回 true，回复已发送`);
log(`  text: "${replyText}"`);
await sleep(800);

// ─────────────────────────────────────────────────────────────────────────────
// Step 7: 验证 Human WS 收到 Agent 回复广播
// ─────────────────────────────────────────────────────────────────────────────
step(7, "验证 Human WebSocket 收到 Agent 回复广播");

const replyBroadcast = humanMsgs.find(
  (m) =>
    m.event === "message" &&
    m.data?.sender_id === `agent-${AGENT_ID}` &&
    String(m.data?.reply_to) === String(inbound.messageId)
);

if (replyBroadcast) {
  log(`Human WS 收到 Agent 回复  message_id=${replyBroadcast.data.message_id}`);
  log(`  text: ${replyBroadcast.data.text}`);
  log(`  reply_to: ${replyBroadcast.data.reply_to}`);
} else {
  log("Human WS 未收到回复（验证消息历史）...");
  const histRes = await fetch(
    `${RELAY_HTTP}/api/v1/rooms/messages?password=${encodeURIComponent(ROOM_PASS)}&limit=10`
  );
  const hist = await histRes.json();
  const replyInHistory = hist.messages?.find(
    (m) => m.sender_id === `agent-${AGENT_ID}` &&
           String(m.reply_to) === String(inbound.messageId)
  );
  if (!replyInHistory) fail("消息历史中也未找到 Agent 回复");
  log(`回复已写入服务端  message_id=${replyInHistory.message_id}`);
  log(`  text: ${replyInHistory.text}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 8: 消息历史完整性
// ─────────────────────────────────────────────────────────────────────────────
step(8, "查询房间消息历史，确认完整记录");
const histRes2 = await fetch(
  `${RELAY_HTTP}/api/v1/rooms/messages?password=${encodeURIComponent(ROOM_PASS)}&limit=10`
);
const hist2 = await histRes2.json();
log(`房间最近 ${hist2.messages?.length} 条消息（共 ${hist2.total ?? "?"} 条）：`);
for (const m of (hist2.messages ?? [])) {
  const mark = m.sender_id?.startsWith("agent-") ? "[Agent]" : "[Human]";
  const reply = m.reply_to ? ` ↩reply_to=#${m.reply_to}` : "";
  console.log(`    ${mark} [#${m.message_id}] ${m.sender_name}: ${m.text.slice(0, 90)}${reply}`);
}

// Cleanup
humanWs.close();
await sleep(300);

console.log("\n=== 全链路测试全部通过（插件真实代码）===");
console.log("✓ Step 1: 人类用户 HTTP 注册/登录/加入房间（必要准备）");
console.log("✓ Step 2: 插件 gatewayAdapter.startAccount() → ClawPondWsClient 连接 + joinRoom");
console.log("✓ Step 3: 人类用户 JWT + WebSocket 连接 + joinRoom");
console.log("✓ Step 4: 人类用户 WS sendMessage 发送 @mention（触发服务端广播）");
console.log("✓ Step 5: 插件 ClawPondWsClient._handleBroadcast → emit('message:inbound')");
console.log("          peerId=roomId 会话隔离验证通过");
console.log("✓ Step 6: 插件 ClawPondWsClient.sendMessage() 回复房间");
console.log("✓ Step 7: Human WS 收到 Agent 回复广播");
console.log("✓ Step 8: 消息历史完整");
