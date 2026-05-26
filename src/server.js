import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBridgeSegment,
  createEndingSegment,
  createOpeningOptions,
  createRequirement,
  checkAIConnection,
  getAIStatusSnapshot,
  getRoomStoryText,
  polishSegment
} from "./aiHost.js";
import { getStorageStatusSnapshot, restoreRooms, saveRoom } from "./storage.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "..", "public");
const projectDir = join(__dirname, "..");

loadEnvFile(join(projectDir, ".env"));

const rooms = new Map();
const streams = new Map();
const startedAt = Date.now();

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

function addSegment(room, segment) {
  room.story.segments.push({
    id: uid("seg"),
    createdAt: now(),
    ...segment
  });
}

async function maybeAddBridge(room) {
  if (!room.enableAIBridge) return;
  if (room.playerTurnsCompleted === 0) return;
  if (room.playerTurnsCompleted % 2 !== 0) return;

  addSegment(room, {
    authorType: "system",
    authorId: null,
    authorName: "系统主持人",
    text: await createBridgeSegment(getRoomStoryText(room)),
    roundNumber: room.currentRound,
    requirement: null
  });
}

async function advanceTurn(room) {
  room.playerTurnsCompleted += 1;
  await maybeAddBridge(room);

  if (room.playerTurnsCompleted >= room.maxRounds) {
    room.status = "ending";
    room.currentTurnPlayerId = null;
    room.currentRequirement = null;
    return;
  }

  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.currentRound = room.playerTurnsCompleted + 1;
  room.currentTurnPlayerId = room.players[room.turnIndex].id;
  room.currentRequirement = await createRequirement(room.currentRound, getRoomStoryText(room));
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
    const label = segment.authorType === "system" ? "系统段落" : segment.authorName;
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
    openingOptions: [],
    selectedOpeningId: null,
    currentRequirement: null,
    endVotes: [],
    turnIndex: 0,
    playerTurnsCompleted: 0,
    createdAt: now(),
    story: {
      id: uid("story"),
      roomId: code,
      title: "未命名故事",
      openingText: "",
      segments: []
    }
  };

  rooms.set(code, room);
  return { room, player: host };
}

async function refreshOpeningOptions(room) {
  const openingTexts = await createOpeningOptions(3);
  room.openingOptions = openingTexts.map((text) => ({
    id: uid("opening"),
    roomId: room.code,
    text,
    votes: []
  }));
  room.selectedOpeningId = null;
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
              res.write(": ping\n\n");
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
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "ready") {
        const player = room.players.find((item) => item.id === playerId);
        if (!player) return sendJson(res, 404, { error: "玩家不存在。" });
        player.ready = Boolean(body.ready);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "start") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以开始游戏。" });
        if (room.players.length < 2) return sendJson(res, 409, { error: "至少需要2名玩家。" });
        await refreshOpeningOptions(room);
        room.status = "selecting_opening";
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "reroll-openings") {
        if (playerId !== room.hostId) return sendJson(res, 403, { error: "只有房主可以重抽开头。" });
        if (room.status !== "selecting_opening") return sendJson(res, 409, { error: "当前不能重抽开头。" });
        await refreshOpeningOptions(room);
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "vote-opening") {
        const option = room.openingOptions.find((item) => item.id === body.openingId);
        if (!option) return sendJson(res, 404, { error: "开头不存在。" });
        for (const item of room.openingOptions) item.votes = item.votes.filter((id) => id !== playerId);
        option.votes.push(playerId);
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

        room.selectedOpeningId = picked.id;
        room.story.openingText = picked.text;
        room.story.title = picked.text.replace(/[，。！？：].*$/, "").slice(0, 18) || "故事接龙";
        room.status = "playing";
        room.turnIndex = 0;
        room.playerTurnsCompleted = 0;
        room.endVotes = [];
        room.currentRound = 1;
        room.currentTurnPlayerId = room.players[0].id;
        room.currentRequirement = await createRequirement(1, getRoomStoryText(room));
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

        const needed = Math.floor(room.players.length / 2) + 1;
        if (room.endVotes.length >= needed) {
          room.status = "ending";
          room.currentTurnPlayerId = null;
          room.currentRequirement = null;
        }

        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "submit-segment") {
        if (room.status !== "playing") return sendJson(res, 409, { error: "当前不能提交段落。" });
        if (playerId !== room.currentTurnPlayerId) return sendJson(res, 403, { error: "还没有轮到你。" });

        const player = room.players.find((item) => item.id === playerId);
        const text = String(body.text || "").trim();
        if (!text) return sendJson(res, 400, { error: "段落不能为空。" });
        if (text.length > room.wordLimit) return sendJson(res, 400, { error: `不能超过 ${room.wordLimit} 字。` });
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
        await advanceTurn(room);
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
          addSegment(room, {
            authorType: "system",
            authorId: null,
            authorName: "系统主持人",
            text: await createEndingSegment(getRoomStoryText(room)),
            roundNumber: room.currentRound,
            requirement: null
          });
        }
        room.status = "finished";
        await saveAndBroadcast(room);
        sendJson(res, 200, { room: publicRoom(room) });
        return;
      }

      if (req.method === "POST" && action === "continue-round") {
        if (room.status !== "ending") return sendJson(res, 409, { error: "当前不能继续加写。" });
        room.maxRounds += room.players.length;
        room.status = "playing";
        room.endVotes = [];
        room.turnIndex = 0;
        room.currentRound = room.playerTurnsCompleted + 1;
        room.currentTurnPlayerId = room.players[0].id;
        room.currentRequirement = await createRequirement(room.currentRound, getRoomStoryText(room));
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
    sendJson(res, 500, { error: error.message || "服务器错误。" });
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
server.listen(port, host, () => {
  console.log(`Story Relay is running at http://${host}:${port}`);
});
