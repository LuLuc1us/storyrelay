import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBridgeSegmentResult,
  createEndingSegmentResult,
  createOpeningOptions,
  createRequirement,
  createStoryTitle,
  checkAIConnection,
  getAIStatusSnapshot,
  getRoomStoryText,
  polishSegment
} from "./aiHost.js";
import { deleteRoom, getStorageStatusSnapshot, restoreRooms, saveRoom } from "./storage.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "..", "public");
const projectDir = join(__dirname, "..");

loadEnvFile(join(projectDir, ".env"));

const rooms = new Map();
const streams = new Map();
const actionLocks = new Map();
const openingAutoTimers = new Map();
const orderSpinTimers = new Map();
const startedAt = Date.now();
const OPENING_AUTO_PICK_MS = 8000;
const ORDER_SPIN_MS = 5500;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? roomCode() : code;
}

function shufflePlayers(players) {
  const next = [...players];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next.map((player, turnOrder) => ({ ...player, turnOrder }));
}

function now() {
  return new Date().toISOString();
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rawValue] = trimmed.split("=");
    const key = rawKey.trim();
    const value = rawValue.join("=").trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function publicRoom(room) {
  return {
    openingRerollVotes: [],
    openingAutoPickAt: null,
    openingAutoPickId: null,
    orderSpinEndsAt: null,
    requirementRerollVotes: [],
    storyStyle: "suspense",
    styleVotes: {},
    events: [],
    ...room,
    clients: undefined
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  const payload = `data: ${JSON.stringify(publicRoom(room))}\n\n`;
  for (const client of streams.get(code) ?? []) {
    try {
      client.res.write(payload);
    } catch {
      removeStream(code, client);
    }
  }
}

async function saveAndBroadcast(room) {
  await saveRoom(publicRoom(room));
  broadcast(room.code);
}

async function deleteAndBroadcast(room) {
  clearOpeningAutoPick(room);
  clearOrderSpin(room);
  room.deletedAt = now();
  broadcast(room.code);
  const deleted = await deleteRoom(room.code);
  if (!deleted) throw new Error("Supabase 暂时没有清理成功，请稍后再试。");
  rooms.delete(room.code);
}

function removeStream(code, client) {
  clearInterval(client.heartbeat);
  streams.get(code)?.delete(client);
  if (streams.get(code)?.size === 0) streams.delete(code);
}

function streamCount() {
  let count = 0;
  for (const clients of streams.values()) count += clients.size;
  return count;
}

async function withActionLock(key, task) {
  if (actionLocks.has(key)) {
    const error = new Error("上一项操作还在处理中，请稍等一下。");
    error.statusCode = 409;
    throw error;
  }
  actionLocks.set(key, true);
  try {
    return await task();
  } finally {
    actionLocks.delete(key);
  }
}

function addSegment(room, segment) {
  room.story.segments.push({
    id: uid("seg"),
    createdAt: now(),
    ...segment
  });
}

function addRoomEvent(room, type, message, playerId = null) {
  room.events = [
    ...(room.events || []),
    {
      id: uid("event"),
      type,
      message,
      playerId,
      createdAt: now()
    }
  ].slice(-60);
}

function getStoryTextBeforeSegment(room, segmentId) {
  const lines = [room.story.openingText].filter(Boolean);
  for (const segment of room.story.segments) {
    if (segment.id === segmentId) break;
    lines.push(segment.text);
  }
  return lines.join("\n");
}

function playerLabel(room, playerId) {
  return room.players.find((player) => player.id === playerId)?.name || "未知玩家";
}

function validatePlayerSegment(text, room) {
  if (/https?:\/\/|www\./i.test(text)) return "故事段落里先不要放链接。";
  if (/(.)\1{8,}/u.test(text)) return "这一段里有太长的重复字符，稍微整理一下再提交。";
  if (/```|<\/?[a-z][\s\S]*?>/i.test(text)) return "这里请提交故事正文，不要放代码或网页标签。";
  if (/^(作为|以下是|我将|当然可以|Sure|Here)/i.test(text.trim())) {
    return "这一段看起来像说明文字，请改成故事正文再提交。";
  }
  if (text.length < Math.min(8, room.wordLimit)) return "这一段有点太短了，至少写成一个完整动作或画面。";
  return "";
}

async function maybeAddBridge(room) {
  if (!room.enableAIBridge) return;
  if (room.playerTurnsCompleted === 0) return;
  if (room.playerTurnsCompleted % 2 !== 0) return;

  const bridge = await createBridgeSegmentResult(getRoomStoryText(room), room.storyStyle);
  addSegment(room, {
    authorType: "system",
    authorId: null,
    authorName: bridge.sourceLabel,
    sourceLabel: bridge.sourceLabel,
    text: bridge.text,
    roundNumber: room.currentRound,
    requirement: null
  });
  addRoomEvent(room, "system", `${bridge.sourceLabel}插入了一段中间衔接。`);
}

async function advanceTurn(room) {
  room.playerTurnsCompleted += 1;
  await maybeAddBridge(room);

  if (room.playerTurnsCompleted >= room.maxRounds) {
    room.status = "ending";
    room.currentTurnPlayerId = null;
    room.currentRequirement = null;
    room.requirementRerollVotes = [];
    return;
  }

  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.currentRound = room.playerTurnsCompleted + 1;
  room.currentTurnPlayerId = room.players[room.turnIndex].id;
  room.currentRequirement = await createRequirement(room.currentRound, getRoomStoryText(room), room.storyStyle);
  room.requirementRerollVotes = [];
}

async function refreshStoryTitle(room, reason = "auto") {
  if (!room?.story?.openingText) return;
  const playerSegmentCount = room.story.segments.filter((segment) => segment.authorType === "player").length;
  if (playerSegmentCount < 1 && reason !== "ending") return;
  if (room.story.titleLocked) return;

  const title = await createStoryTitle(getRoomStoryText(room), room.storyStyle);
  if (title && title !== room.story.title) {
    room.story.title = title;
    room.story.titleSource = reason;
    room.story.titleUpdatedAt = now();
  }
}

function exportMarkdown(room) {
  const lines = [
    `# ${room.story.title || "未命名故事"}`,
    "",
    `参与玩家：${room.players.map((player) => player.name).join("、")}`,
    "",
    "## 故事正文",
    "",
    `> ${room.story.openingText}`,
    ""
  ];

  for (const segment of room.story.segments) {
    const label = segment.authorType === "system" ? segment.sourceLabel || segment.authorName || "系统段落" : segment.authorName;
    lines.push(`### ${label}`);
    if (segment.requirement) {
      lines.push(
        `要求：关键词「${segment.requirement.keyword}」；情绪「${segment.requirement.emotion}」；转折「${segment.requirement.twist}」`
      );
      lines.push("");
    }
    lines.push(segment.text);
    lines.push("");
  }

  return lines.join("\n");
}

function createRoom({ name, settings }) {
  const code = roomCode();
  const host = {
    id: uid("player"),
    roomId: code,
    name: name || "房主",
    ready: true,
    turnOrder: 0
  };
  const room = {
    id: uid("room"),
    code,
    status: "lobby",
    players: [host],
    hostId: host.id,
    currentTurnPlayerId: null,
    currentRound: 0,
    maxRounds: Number(settings?.maxRounds || 6),
    wordLimit: Number(settings?.wordLimit || 120),
    timeLimit: settings?.timeLimit || "none",
    enableAIBridge: settings?.enableAIBridge !== false,
    enableAIEnding: settings?.enableAIEnding !== false,
    storyStyle: settings?.storyStyle || "suspense",
    styleVotes: {},
    openingOptions: [],
    selectedOpeningId: null,
    openingRerollVotes: [],
    currentRequirement: null,
    requirementRerollVotes: [],
    endVotes: [],
    turnIndex: 0,
    playerTurnsCompleted: 0,
    createdAt: now(),
    events: [],
    story: {
      id: uid("story"),
      roomId: code,
      title: "未命名故事",
      openingText: "",
      segments: []
    }
  };

  rooms.set(code, room);
  addRoomEvent(room, "room", `${host.name} 创建了房间。`, host.id);
  return { room, player: host };
}

async function refreshOpeningOptions(room) {
  clearOpeningAutoPick(room);
  const openingTexts = await createOpeningOptions(3, room.storyStyle);
  room.openingOptions = openingTexts.map((text) => ({
    id: uid("opening"),
    roomId: room.code,
    text,
    votes: []
  }));
  room.selectedOpeningId = null;
  room.openingRerollVotes = [];
}

function neededVotes(room) {
  return Math.floor(room.players.length / 2) + 1;
}

function clearOpeningAutoPick(room) {
  if (!room?.code) return;
  const timer = openingAutoTimers.get(room.code);
  if (timer) clearTimeout(timer);
  openingAutoTimers.delete(room.code);
  room.openingAutoPickAt = null;
  room.openingAutoPickId = null;
}

function clearOrderSpin(room) {
  if (!room?.code) return;
  const timer = orderSpinTimers.get(room.code);
  if (timer) clearTimeout(timer);
  orderSpinTimers.delete(room.code);
  room.orderSpinEndsAt = null;
}

function getUnanimousOpening(room) {
  if (room.status !== "selecting_opening") return null;
  if (room.players.length < 2) return null;
  if ((room.openingRerollVotes || []).length > 0) return null;
  const playerIds = room.players.map((player) => player.id);
  return room.openingOptions.find((option) => playerIds.every((id) => option.votes.includes(id))) || null;
}

async function chooseOpening(room, picked, playerId = null, auto = false) {
  clearOpeningAutoPick(room);
  clearOrderSpin(room);
  const orderedPlayers = shufflePlayers(room.players);
  room.players = orderedPlayers;
  room.selectedOpeningId = picked.id;
  room.story.openingText = picked.text;
  room.story.title = picked.text.replace(/[，。！？：].*$/, "").slice(0, 18) || "故事接龙";
  room.story.titleSource = "opening";
  room.status = "spinning_order";
  room.turnIndex = 0;
  room.playerTurnsCompleted = 0;
  room.endVotes = [];
  room.openingRerollVotes = [];
  room.requirementRerollVotes = [];
  room.currentRequirement = null;
  room.currentRound = 1;
  room.currentTurnPlayerId = orderedPlayers[0].id;
  room.orderSpinEndsAt = new Date(Date.now() + ORDER_SPIN_MS).toISOString();
  addRoomEvent(room, "story", `${auto ? "全员投票通过，" : ""}本局开头已确定：${picked.text}`, playerId);
  addRoomEvent(room, "turn", `本局顺序已随机决定：${orderedPlayers.map((player) => player.name).join(" → ")}。`, playerId);
  scheduleOrderSpin(room);
}

function scheduleOrderSpin(room) {
  if (!room?.code || room.status !== "spinning_order") return;
  clearTimeout(orderSpinTimers.get(room.code));
  const delay = Math.max(500, new Date(room.orderSpinEndsAt || Date.now()).getTime() - Date.now());
  orderSpinTimers.set(
    room.code,
    setTimeout(() => {
      withActionLock(`${room.code}:order-spin`, async () => {
        const currentRoom = rooms.get(room.code);
        if (!currentRoom || currentRoom.status !== "spinning_order") return;
        currentRoom.status = "playing";
        currentRoom.orderSpinEndsAt = null;
        currentRoom.currentRequirement = await createRequirement(1, getRoomStoryText(currentRoom), currentRoom.storyStyle);
        addRoomEvent(currentRoom, "turn", `第一位落笔的是 ${playerLabel(currentRoom, currentRoom.currentTurnPlayerId)}。`);
        await saveAndBroadcast(currentRoom);
      }).catch((error) => {
        console.warn(`Order spin failed for ${room.code}: ${error.message}`);
      });
    }, delay)
  );
}

function scheduleOpeningAutoPick(room) {
  const picked = getUnanimousOpening(room);
  if (!picked) {
    clearOpeningAutoPick(room);
    return false;
  }

  if (room.openingAutoPickId === picked.id && room.openingAutoPickAt) return true;
  clearOpeningAutoPick(room);
  room.openingAutoPickId = picked.id;
  room.openingAutoPickAt = new Date(Date.now() + OPENING_AUTO_PICK_MS).toISOString();
  openingAutoTimers.set(
    room.code,
    setTimeout(() => {
      withActionLock(`${room.code}:opening`, async () => {
        const currentRoom = rooms.get(room.code);
        if (!currentRoom || currentRoom.status !== "selecting_opening") return;
        const currentPick = getUnanimousOpening(currentRoom);
        if (!currentPick || currentPick.id !== picked.id) {
          clearOpeningAutoPick(currentRoom);
          await saveAndBroadcast(currentRoom);
          return;
        }
        await chooseOpening(currentRoom, currentPick, null, true);
        await saveAndBroadcast(currentRoom);
      }).catch((error) => {
        console.warn(`Opening auto-pick failed for ${room.code}: ${error.message}`);
      });
    }, OPENING_AUTO_PICK_MS)
  );
  return true;
}

function resolveStoryStyle(room) {
  const entries = Object.entries(room.styleVotes || {});
  if (!entries.length) return room.storyStyle || "suspense";
  const [winningStyle] = entries.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  return winningStyle || room.storyStyle || "suspense";
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        rooms: rooms.size,
        streams: streamCount(),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        ...getStorageStatusSnapshot(),
        ...getAIStatusSnapshot()
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/ai-check") {
      sendJson(res, 200, await checkAIConnection());
      return;
    }

    if (req.method === "POST" && req.url === "/api/rooms") {
      const body = await readJson(req);
      const result = createRoom(body);
      await saveRoom(publicRoom(result.room));
      sendJson(res, 200, { room: publicRoom(result.room), player: result.player });
      return;
    }

    if (req.method === "POST" && req.url === "/api/join") {
      const body = await readJson(req);
      const code = String(body.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return sendJson(res, 404, { error: "没有找到这个房间。" });
      if (room.status !== "lobby") return sendJson(res, 409, { error: "游戏已经开始。" });
      if (room.players.length >= 6) return sendJson(res, 409, { error: "房间人数已满。" });

      const player = {
        id: uid("player"),
        roomId: code,
        name: body.name || `玩家${room.players.length + 1}`,
        ready: false,
        turnOrder: room.players.length
      };
      room.players.push(player);
      addRoomEvent(room, "player", `${player.name} 加入了房间。`, player.id);
      await saveAndBroadcast(room);
      sendJson(res, 200, { room: publicRoom(room), player });
      return;
    }

    const roomRead = req.url.match(/^\/api\/rooms\/([A-Z0-9]+)$/);
    if (req.method === "GET" && roomRead) {
      const room = rooms.get(roomRead[1]);
      if (!room) return sendJson(res, 404, { error: "房间不存在。" });
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const roomAction = req.url.match(/^\/api\/rooms\/([A-Z0-9]+)\/(.+)$/);
    if (roomAction) {
      const [, code, action] = roomAction;
      const room = rooms.get(code);
      if (!room) return sendJson(res, 404, { error: "房间不存在。" });
      const body = req.method === "POST" ? await readJson(req) : {};
      const playerId = body.playerId;

      if (req.method === "GET" && action === "events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.write(`data: ${JSON.stringify(publicRoom(room))}\n\n`);
        res.write(": connected\n\n");
        if (!streams.has(code)) streams.set(code, new Set());
        const client = {
          res,
          heartbeat: setInterval(() => {
            try {
              res.write("event: ping\ndata: {}\n\n");
            } catch {
              removeStream(code, client);
            }
          }, 25000)
        };
        streams.get(code).add(client);
        req.on("close", () => removeStream(code, client));
        return;
      }

      if (req.method === "POST" && action === "settings") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以修改设置。" });
        if (room.status !== "lobby") return sendJson(res, 409, { error: "游戏开始后不能修改设置。" });
        room.maxRounds = Number(body.maxRounds || room.maxRounds);
        room.wordLimit = Number(body.wordLimit || room.wordLimit);
        room.timeLimit = body.timeLimit || room.timeLimit;
        room.enableAIBridge = Boolean(body.enableAIBridge);
        room.enableAIEnding = Boolean(body.enableAIEnding);
        addRoomEvent(room, "room", `${playerLabel(room, playerId)} 更新了本局设置。`, playerId);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "vote-style") {
        if (room.status !== "lobby") return sendJson(res, 409, { error: "游戏开始后不能修改风格投票。" });
        if (!room.players.some((player) => player.id === playerId)) {
          return sendJson(res, 404, { error: "玩家不存在。" });
        }
        const style = String(body.storyStyle || "").trim();
        const allowedStyles = new Set(["suspense", "fantasy", "warm", "absurd", "sciFi"]);
        if (!allowedStyles.has(style)) return sendJson(res, 400, { error: "这个故事风格不存在。" });

        room.styleVotes = room.styleVotes || {};
        for (const key of Object.keys(room.styleVotes)) {
          room.styleVotes[key] = room.styleVotes[key].filter((id) => id !== playerId);
        }
        room.styleVotes[style] = [...(room.styleVotes[style] || []), playerId];
        room.storyStyle = resolveStoryStyle(room);
        addRoomEvent(room, "vote", `${playerLabel(room, playerId)} 投票选择了故事风格。`, playerId);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "ready") {
        const player = room.players.find((item) => item.id === playerId);
        if (!player) return sendJson(res, 404, { error: "玩家不存在。" });
        player.ready = Boolean(body.ready);
        addRoomEvent(room, "player", `${player.name}${player.ready ? "准备好了" : "取消了准备"}。`, player.id);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "start") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以开始游戏。" });
        if (room.players.length < 2) return sendJson(res, 409, { error: "至少需要2名玩家。" });
        room.storyStyle = resolveStoryStyle(room);
        await refreshOpeningOptions(room);
        room.status = "selecting_opening";
        clearOpeningAutoPick(room);
        addRoomEvent(room, "room", "游戏开始，进入故事开头选择。", playerId);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "reroll-openings") {
        if (!room.players.some((player) => player.id === playerId)) {
          return sendJson(res, 404, { error: "玩家不存在。" });
        }
        if (room.status !== "selecting_opening") return sendJson(res, 409, { error: "当前不能重抽开头。" });

        room.openingRerollVotes = (room.openingRerollVotes || []).filter((id) => id !== playerId);
        if (body.vote !== false) room.openingRerollVotes.push(playerId);

        if (room.openingRerollVotes.length >= neededVotes(room)) {
          await refreshOpeningOptions(room);
          addRoomEvent(room, "vote", "重抽开头投票通过，系统换了一批开头。");
        } else {
          scheduleOpeningAutoPick(room);
        }

        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "vote-opening") {
        const option = room.openingOptions.find((item) => item.id === body.openingId);
        if (!option) return sendJson(res, 404, { error: "开头不存在。" });
        for (const item of room.openingOptions) item.votes = item.votes.filter((id) => id !== playerId);
        option.votes.push(playerId);
        const previousAutoPickId = room.openingAutoPickId;
        const willAutoPick = scheduleOpeningAutoPick(room);
        if (willAutoPick && previousAutoPickId !== option.id) {
          addRoomEvent(room, "vote", "所有玩家选中了同一个开头，倒计时后自动开始。", playerId);
        }
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "choose-opening") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以确定开头。" });
        const picked =
          room.openingOptions.find((item) => item.id === body.openingId) ||
          [...room.openingOptions].sort((a, b) => b.votes.length - a.votes.length)[0];
        if (!picked) return sendJson(res, 409, { error: "还没有可选开头。" });

        await chooseOpening(room, picked, playerId, false);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "vote-ending") {
        if (room.status !== "playing") return sendJson(res, 409, { error: "当前不能投票结束。" });
        if (!room.players.some((player) => player.id === playerId)) {
          return sendJson(res, 404, { error: "玩家不存在。" });
        }

        room.endVotes = (room.endVotes || []).filter((id) => id !== playerId);
        if (body.vote !== false) room.endVotes.push(playerId);

        if (room.endVotes.length >= neededVotes(room)) {
          room.status = "ending";
          room.currentTurnPlayerId = null;
          room.currentRequirement = null;
          room.requirementRerollVotes = [];
          addRoomEvent(room, "vote", "结尾投票通过，故事进入收束阶段。");
        }

        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "submit-segment") {
        await withActionLock(`${code}:submit`, async () => {
          if (room.status !== "playing") return sendJson(res, 409, { error: "当前不能提交段落。" });
          if (playerId !== room.currentTurnPlayerId) return sendJson(res, 403, { error: "还没有轮到你。" });

          const player = room.players.find((item) => item.id === playerId);
          const text = String(body.text || "").trim();
          if (!text) return sendJson(res, 400, { error: "段落不能为空。" });
          if (text.length > room.wordLimit) return sendJson(res, 400, { error: `不能超过 ${room.wordLimit} 字。` });
          const validationError = validatePlayerSegment(text, room);
          if (validationError) return sendJson(res, 400, { error: validationError });
          if (room.currentRequirement?.keyword && !text.includes(room.currentRequirement.keyword)) {
            return sendJson(res, 400, { error: `这一段需要包含关键词「${room.currentRequirement.keyword}」。` });
          }

          addSegment(room, {
            authorType: "player",
            authorId: player.id,
            authorName: player.name,
            text,
            roundNumber: room.currentRound,
            requirement: room.currentRequirement
          });
          addRoomEvent(room, "story", `${player.name} 提交了第 ${room.currentRound} 轮段落。`, player.id);
          await refreshStoryTitle(room, "story");
          await advanceTurn(room);
          await saveAndBroadcast(room);
          sendJson(res, 200, { room: publicRoom(room) });
        });
        return;
      }

      if (req.method === "POST" && action === "reroll-requirement") {
        if (room.status !== "playing") return sendJson(res, 409, { error: "当前不能重抽写作要求。" });
        if (!room.players.some((player) => player.id === playerId)) {
          return sendJson(res, 404, { error: "玩家不存在。" });
        }

        room.requirementRerollVotes = (room.requirementRerollVotes || []).filter((id) => id !== playerId);
        if (body.vote !== false) room.requirementRerollVotes.push(playerId);

        if (room.requirementRerollVotes.length >= neededVotes(room)) {
          room.currentRequirement = await createRequirement(room.currentRound, getRoomStoryText(room), room.storyStyle);
          room.requirementRerollVotes = [];
          addRoomEvent(room, "vote", "换题投票通过，系统更新了本轮写作要求。");
        }

        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "polish-segment") {
        if (room.status !== "playing") return sendJson(res, 409, { error: "当前不能润色段落。" });
        if (playerId !== room.currentTurnPlayerId) return sendJson(res, 403, { error: "还没有轮到你。" });

        const text = String(body.text || "").trim();
        if (!text) return sendJson(res, 400, { error: "先写一小段，再让 AI 主持人润色。" });
        if (text.length > room.wordLimit) return sendJson(res, 400, { error: `不能超过 ${room.wordLimit} 字。` });

        sendJson(res, 200, {
          polish: await polishSegment(text, room.currentRequirement, getRoomStoryText(room))
        });
        return;
      }

      if (req.method === "POST" && action === "generate-ending") {
        if (room.status !== "ending") return sendJson(res, 409, { error: "还没有进入结尾阶段。" });
        if (room.enableAIEnding) {
          const ending = await createEndingSegmentResult(getRoomStoryText(room), room.storyStyle);
          addSegment(room, {
            authorType: "system",
            authorId: null,
            authorName: ending.sourceLabel,
            sourceLabel: ending.sourceLabel,
            text: ending.text,
            roundNumber: room.currentRound,
            requirement: null
          });
        }
        room.status = "finished";
        room.requirementRerollVotes = [];
        await refreshStoryTitle(room, "ending");
        addRoomEvent(room, "story", "系统生成了最终结尾，故事完成。", playerId);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "rename-story") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以修改标题。" });
        const title = String(body.title || "").trim().replace(/^["“”《]+|["“”》]+$/g, "").slice(0, 16);
        if (title.length < 2) return sendJson(res, 400, { error: "标题至少需要两个字。" });
        room.story.title = title;
        room.story.titleLocked = true;
        room.story.titleSource = "host";
        room.story.titleUpdatedAt = now();
        addRoomEvent(room, "story", `${playerLabel(room, playerId)} 修改了故事标题。`, playerId);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "suggest-title") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以生成标题。" });
        room.story.title = await createStoryTitle(getRoomStoryText(room), room.storyStyle);
        room.story.titleLocked = false;
        room.story.titleSource = "suggested";
        room.story.titleUpdatedAt = now();
        addRoomEvent(room, "story", `${playerLabel(room, playerId)} 生成了新的故事标题。`, playerId);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "delete-room") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以清理房间。" });
        addRoomEvent(room, "room", `${playerLabel(room, playerId)} 清理了这个房间。`, playerId);
        await deleteAndBroadcast(room);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && action === "rewrite-system-segment") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以重写系统段落。" });
        if (!["playing", "ending", "finished"].includes(room.status)) {
          return sendJson(res, 409, { error: "当前不能重写系统段落。" });
        }

        const segment = room.story.segments.find((item) => item.id === body.segmentId);
        if (!segment) return sendJson(res, 404, { error: "没有找到这段系统段落。" });
        if (segment.authorType !== "system") return sendJson(res, 400, { error: "只能重写系统段落。" });

        const tone = ["balanced", "restrained", "dramatic"].includes(body.tone) ? body.tone : "balanced";
        const contextText = getStoryTextBeforeSegment(room, segment.id);
        const isEndingSegment = room.status === "finished" && room.story.segments.at(-1)?.id === segment.id;
        const result = isEndingSegment
          ? await createEndingSegmentResult(contextText, room.storyStyle, tone)
          : await createBridgeSegmentResult(contextText, room.storyStyle, tone);

        segment.text = result.text;
        segment.authorName = result.sourceLabel;
        segment.sourceLabel = result.sourceLabel;
        segment.rewriteCount = Number(segment.rewriteCount || 0) + 1;
        segment.updatedAt = now();

        addRoomEvent(room, "system", `${result.sourceLabel}重写了一段系统内容。`, playerId);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "continue-round") {
        if (room.status !== "ending") return sendJson(res, 409, { error: "当前不能继续加写。" });
        room.maxRounds += room.players.length;
        room.status = "playing";
        room.endVotes = [];
        room.requirementRerollVotes = [];
        room.turnIndex = 0;
        room.currentRound = room.playerTurnsCompleted + 1;
        room.currentTurnPlayerId = room.players[room.turnIndex].id;
        room.currentRequirement = await createRequirement(room.currentRound, getRoomStoryText(room), room.storyStyle);
        addRoomEvent(room, "room", "玩家选择继续加写一轮。", playerId);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "GET" && action === "export.md") {
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="story-relay-${code}.md"`
        });
        res.end(exportMarkdown(room));
        return;
      }
    }

    sendJson(res, 404, { error: "接口不存在。" });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "服务器错误。" });
  }
}

async function handleStatic(req, res) {
  const path = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const safePath = path.replace(/\.\./g, "");
  try {
    const staticPath = extname(safePath) ? safePath : "/index.html";
    const file = await readFile(join(publicDir, staticPath));
    res.writeHead(200, { "Content-Type": mimeTypes[extname(staticPath)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  handleStatic(req, res);
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
await restoreRooms(rooms);
await Promise.all(
  [...rooms.values()]
    .filter((room) => room.status === "selecting_opening" || room.status === "spinning_order")
    .map(async (room) => {
      if (room.status === "selecting_opening") scheduleOpeningAutoPick(room);
      if (room.status === "spinning_order") scheduleOrderSpin(room);
      await saveRoom(publicRoom(room));
    })
);
server.listen(port, host, () => {
  console.log(`Story Relay is running at http://${host}:${port}`);
});
