import { connectNewRoom } from "./gateway.js";
import type { ClawPondAccount, OpenClawConfig, PluginApi, ToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * Convert a WebSocket URL to its HTTP equivalent.
 * ws://host:port  → http://host:port
 * wss://host:port → https://host:port
 */
function wsUrlToHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws:\/\//i, "http://").replace(/^wss:\/\//i, "https://");
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json() as T;
  if (!res.ok) {
    const detail = (body as Record<string, unknown>).detail ?? res.statusText;
    throw new Error(`HTTP ${res.status}: ${String(detail)}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Tool 1: clawpond_register
// ---------------------------------------------------------------------------

interface RegisterParams {
  relayUrl: string;
  agentName: string;
  description?: string;
}

interface RegisterApiResponse {
  agent_id: string;
  agent_secret: string;
  name: string;
  message: string;
}

async function executeRegister(
  params: RegisterParams,
  api: PluginApi,
): Promise<ReturnType<typeof json>> {
  const { relayUrl, agentName, description } = params;

  const httpBase = wsUrlToHttpUrl(relayUrl.replace(/\/+$/, ""));

  let regData: RegisterApiResponse;
  try {
    regData = await fetchJson<RegisterApiResponse>(`${httpBase}/api/v1/agents/register`, {
      method: "POST",
      body: JSON.stringify({
        name: agentName,
        description: description ?? "OpenClaw Agent",
      }),
    });
  } catch (err) {
    return json({ ok: false, error: `Registration failed: ${String(err)}` });
  }

  const { agent_id, agent_secret } = regData;

  // Derive WS URL from the provided relayUrl (keep protocol, strip trailing slash)
  const relayWsUrl = relayUrl.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://").replace(/\/+$/, "");

  // Attempt to persist credentials via runtime API if available
  const configPatch: Record<string, unknown> = {
    accounts: {
      default: {
        relayWsUrl,
        agentId: agent_id,
        agentSecret: agent_secret,
        agentName,
        agentDescription: description ?? "OpenClaw Agent",
      },
    },
  };

  let configSaved = false;
  if (api.runtime?.updateChannelConfig) {
    try {
      await api.runtime.updateChannelConfig("clawpond", configPatch);
      configSaved = true;
    } catch (err) {
      api.runtime?.log?.(`clawpond_register: config update failed: ${String(err)}`);
    }
  }

  let gatewaRestarted = false;
  if (configSaved && api.runtime?.restartGateway) {
    try {
      await api.runtime.restartGateway("clawpond");
      gatewaRestarted = true;
    } catch (err) {
      api.runtime?.log?.(`clawpond_register: gateway restart failed: ${String(err)}`);
    }
  }

  return json({
    ok: true,
    agent_id,
    agent_secret,
    agent_name: agentName,
    relay_ws_url: relayWsUrl,
    config_saved: configSaved,
    gateway_restarted: gatewaRestarted,
    next_steps: configSaved
      ? gatewaRestarted
        ? "Gateway restarted. WebSocket connection will establish automatically."
        : "Config saved. Please restart the ClawPond gateway to apply changes."
      : [
          "Config auto-save is not available in this OpenClaw version.",
          "Add the following to your openclaw.json under channels.clawpond.accounts.default:",
          JSON.stringify(
            {
              relayWsUrl,
              agentId: agent_id,
              agentSecret: agent_secret,
              agentName,
            },
            null,
            2,
          ),
          "Then restart OpenClaw to establish the WebSocket connection.",
        ].join("\n"),
    warning: "agent_secret is shown only once. Save it before proceeding.",
  });
}

// ---------------------------------------------------------------------------
// Tool 2: clawpond_join_room
// ---------------------------------------------------------------------------

interface JoinRoomParams {
  roomPassword: string;
  accountId?: string;
}

interface ValidateApiResponse {
  valid: boolean;
  room_id: string | null;
}

interface JoinApiResponse {
  agent_id: string;
  user_id: string;
  username: string;
  room_id: string;
  message: string;
}

async function executeJoinRoom(
  params: JoinRoomParams,
  api: PluginApi,
): Promise<ReturnType<typeof json>> {
  const { roomPassword, accountId } = params;

  // Resolve current account config
  const config = api.runtime?.getConfig?.() as OpenClawConfig | undefined;
  const accounts = config?.channels?.clawpond?.accounts;
  const rawAccount = accounts?.[accountId ?? "default"] as Partial<ClawPondAccount> | undefined;

  if (!rawAccount?.relayWsUrl || !rawAccount?.agentId || !rawAccount?.agentSecret) {
    return json({
      ok: false,
      error:
        "ClawPond account is not configured. Run clawpond_register first or check openclaw.json.",
    });
  }

  const httpBase = wsUrlToHttpUrl(rawAccount.relayWsUrl.replace(/\/+$/, ""));
  const { agentId, agentSecret } = rawAccount as { agentId: string; agentSecret: string };

  // Step 1: Resolve room_id from password
  let validateData: ValidateApiResponse;
  try {
    validateData = await fetchJson<ValidateApiResponse>(`${httpBase}/api/v1/rooms/validate`, {
      method: "POST",
      body: JSON.stringify({ password: roomPassword }),
    });
  } catch (err) {
    return json({ ok: false, error: `Room validation failed: ${String(err)}` });
  }

  if (!validateData.valid || !validateData.room_id) {
    return json({ ok: false, error: "Invalid room password – room not found." });
  }

  const roomId = validateData.room_id;

  // Step 2: Join via HTTP API
  let joinData: JoinApiResponse;
  try {
    joinData = await fetchJson<JoinApiResponse>(`${httpBase}/api/v1/agents/join`, {
      method: "POST",
      body: JSON.stringify({
        agent_id: agentId,
        agent_secret: agentSecret,
        room_id: roomId,
        room_password: roomPassword,
      }),
    });
  } catch (err) {
    return json({ ok: false, error: `Join room failed: ${String(err)}` });
  }

  // Step 3: Subscribe the WsClient to the room (sends WS joinRoom message)
  connectNewRoom({ roomId, roomPassword });

  return json({
    ok: true,
    room_id: joinData.room_id,
    user_id: joinData.user_id,
    username: joinData.username,
    message: joinData.message,
    session_info:
      `Session established. Room ID "${roomId}" will be used as the session peer ID. ` +
      "All messages in this room are now isolated in their own conversation context.",
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const registerTool: ToolDefinition = {
  name: "clawpond_register",
  label: "ClawPond Register",
  description:
    "Register this OpenClaw agent with a ClawPond relay server. " +
    "Use this when the agent has not been registered yet or when agentId/agentSecret are missing. " +
    "Returns agent credentials and attempts to save them to the config automatically.",
  parameters: {
    type: "object",
    properties: {
      relayUrl: {
        type: "string",
        description:
          "ClawPond relay server base URL. Accepts http:// or ws:// prefix, e.g. http://localhost:8000 or ws://localhost:8000",
      },
      agentName: {
        type: "string",
        description: "Display name for this agent (used for @mention matching)",
      },
      description: {
        type: "string",
        description: "Optional human-readable description of this agent",
      },
    },
    required: ["relayUrl", "agentName"],
    additionalProperties: false,
  },
  async execute(_toolCallId, params) {
    return executeRegister(params as RegisterParams, _toolCallId as unknown as PluginApi);
  },
};

const joinRoomTool: ToolDefinition = {
  name: "clawpond_join_room",
  label: "ClawPond Join Room",
  description:
    "Join a ClawPond chatroom using the room password provided by the user. " +
    "Handles the full flow: validates the password, calls the join API, and subscribes the WebSocket. " +
    "After joining, the room gets its own isolated session context.",
  parameters: {
    type: "object",
    properties: {
      roomPassword: {
        type: "string",
        description: "The room access token (password) provided by the user",
      },
      accountId: {
        type: "string",
        description: 'ClawPond account to use (default: "default")',
      },
    },
    required: ["roomPassword"],
    additionalProperties: false,
  },
  async execute(_toolCallId, params) {
    return executeJoinRoom(params as JoinRoomParams, _toolCallId as unknown as PluginApi);
  },
};

/**
 * Register ClawPond tools with the OpenClaw plugin API.
 * The api reference is captured in closure so tools can call runtime methods.
 */
export function registerClawPondTools(api: PluginApi): void {
  if (!api.registerTool) {
    api.runtime?.log?.(
      "clawpond: api.registerTool not available – skipping tool registration",
    );
    return;
  }

  // Rebind execute to capture the api reference in closure
  const boundRegisterTool: ToolDefinition = {
    ...registerTool,
    execute: (_toolCallId, params) => executeRegister(params as RegisterParams, api),
  };

  const boundJoinRoomTool: ToolDefinition = {
    ...joinRoomTool,
    execute: (_toolCallId, params) => executeJoinRoom(params as JoinRoomParams, api),
  };

  api.registerTool(boundRegisterTool, { name: "clawpond_register" });
  api.registerTool(boundJoinRoomTool, { name: "clawpond_join_room" });

  api.runtime?.log?.("clawpond: registered tools: clawpond_register, clawpond_join_room");
}
