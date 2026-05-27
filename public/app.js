const app = document.querySelector("#app");
const storyPathMatch = location.pathname.match(/^\/story\/([A-Z0-9]{5})\/?$/i);
const REQUEST_TIMEOUT_MS = 70000;

const state = {
  room: null,
  player: JSON.parse(localStorage.getItem("storyRelayPlayer") || "null"),
  lastRoomCode: localStorage.getItem("storyRelayRoomCode") || "",
  storyViewCode: storyPathMatch?.[1]?.toUpperCase() || "",
  eventSource: null,
  error: "",
  draft: "",
  polish: null,
  isPolishing: false,
  pendingAction: "",
  systemStatus: null,
  systemStatusLoading: false,
  connectionStatus: "idle",
  draftRestoredKey: "",
  lastSyncAt: "",
  isRefreshingRoom: false,
  clockNow: Date.now(),
  uiClock: null
};

const styleOptions = [
  ["suspense", "悬疑怪谈"],
  ["fantasy", "奇幻冒险"],
  ["warm", "温暖治愈"],
  ["absurd", "荒诞日常"],
  ["sciFi", "轻科幻"]
];

const api = {
  async get(path) {
    return request(path);
  },
  async post(path, body = {}) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
};

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || "操作失败。");
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("服务器这次响应太久了。请稍等几秒再试，刚唤醒的免费实例可能会慢一点。");
    }
    if (error instanceof SyntaxError) throw new Error("服务器返回了异常内容，请刷新页面再试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function savePlayer(player) {
  state.player = player;
  state.lastRoomCode = player?.roomId || state.lastRoomCode;
  localStorage.setItem("storyRelayPlayer", JSON.stringify(player));
  if (state.lastRoomCode) localStorage.setItem("storyRelayRoomCode", state.lastRoomCode);
}

function saveRoomCode(code) {
  state.lastRoomCode = code;
  localStorage.setItem("storyRelayRoomCode", code);
}

function clearSavedRoom() {
  if (state.eventSource) state.eventSource.close();
  stopUiClock();
  localStorage.removeItem("storyRelayPlayer");
  localStorage.removeItem("storyRelayRoomCode");
  clearSavedDrafts();
  state.player = null;
  state.room = null;
  state.lastRoomCode = "";
  state.draft = "";
  state.polish = null;
  state.isPolishing = false;
  state.connectionStatus = "idle";
  state.draftRestoredKey = "";
}

function setError(message) {
  state.error = message || "";
  render();
}

function setFormBusy(form, busy, label = "处理中…") {
  const buttons = form.querySelectorAll("button");
  buttons.forEach((button) => {
    if (busy) {
      button.dataset.idleText = button.textContent;
      button.textContent = label;
    } else if (button.dataset.idleText) {
      button.textContent = button.dataset.idleText;
      delete button.dataset.idleText;
    }
    button.disabled = busy;
  });
}

async function withButtonPending(button, label, task) {
  if (!button || button.disabled) return;
  const originalText = button.textContent;
  button.textContent = label;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await task();
  } finally {
    if (button.isConnected) {
      button.textContent = originalText;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

async function loadSystemStatus() {
  state.systemStatusLoading = true;
  try {
    state.systemStatus = await api.get("/api/health");
  } catch (error) {
    state.systemStatus = { ok: false, message: error.message };
  } finally {
    state.systemStatusLoading = false;
    render();
  }
}

function connect(code) {
  if (state.eventSource) state.eventSource.close();
  saveRoomCode(code);
  state.connectionStatus = "connecting";
  state.eventSource = new EventSource(`/api/rooms/${code}/events`);
  state.eventSource.onopen = () => {
    state.connectionStatus = "online";
    state.lastSyncAt = new Date().toISOString();
    if (state.error === "同步连接暂时断开，浏览器会自动重连。") state.error = "";
    render();
  };
  state.eventSource.onmessage = (event) => {
    state.connectionStatus = "online";
    state.lastSyncAt = new Date().toISOString();
    state.room = JSON.parse(event.data);
    if (state.room?.deletedAt) {
      clearSavedRoom();
      history.replaceState(null, "", "/");
      setError("这个房间已经被房主清理。");
      return;
    }
    syncUiClock();
    render();
  };
  state.eventSource.addEventListener("ping", () => {
    state.lastSyncAt = new Date().toISOString();
    if (state.connectionStatus !== "online") {
      state.connectionStatus = "online";
      render();
    }
  });
  state.eventSource.onerror = () => {
    state.connectionStatus = "reconnecting";
    state.error = "同步连接暂时断开，浏览器会自动重连。";
    render();
  };
}

async function refreshCurrentRoom() {
  if (state.isRefreshingRoom || !state.room?.code || state.storyViewCode) return;
  state.isRefreshingRoom = true;
  try {
    const { room } = await api.get(`/api/rooms/${state.room.code}`);
    state.room = room;
    state.connectionStatus = "online";
    state.lastSyncAt = new Date().toISOString();
    syncUiClock();
    render();
  } catch {
    if (state.connectionStatus === "online") state.connectionStatus = "reconnecting";
  } finally {
    state.isRefreshingRoom = false;
  }
}

async function resumeRoom(code = state.lastRoomCode) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) return;
  try {
    const { room } = await api.get(`/api/rooms/${normalizedCode}`);
    const playerStillInRoom = room.players.some((player) => player.id === state.player?.id);
    if (!playerStillInRoom) {
      localStorage.removeItem("storyRelayPlayer");
      localStorage.removeItem("storyRelayRoomCode");
      state.player = null;
      state.lastRoomCode = "";
      state.room = null;
      renderHome();
      return;
    }
    state.room = room;
    connect(room.code);
    setError("");
  } catch (error) {
    localStorage.removeItem("storyRelayRoomCode");
    state.lastRoomCode = "";
    setError(error.message);
  }
}

async function openStoryView(code = state.storyViewCode) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) return;
  try {
    const { room } = await api.get(`/api/rooms/${normalizedCode}`);
    state.room = room;
    state.storyViewCode = normalizedCode;
    if (state.eventSource) state.eventSource.close();
    setError("");
  } catch (error) {
    setError(error.message);
  }
}

function storyShareUrl(code) {
  return `${location.origin}/story/${code}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function playerName(id) {
  return state.room?.players.find((player) => player.id === id)?.name || "未知玩家";
}

function isHost() {
  return state.player?.id && state.room?.hostId === state.player.id;
}

function isCurrentPlayer() {
  return state.player?.id && state.room?.currentTurnPlayerId === state.player.id;
}

function storyStyleLabel(value) {
  return styleOptions.find(([key]) => key === value)?.[1] || "悬疑怪谈";
}

function turnOrderedPlayers(room = state.room) {
  return [...(room?.players || [])].sort((a, b) => Number(a.turnOrder || 0) - Number(b.turnOrder || 0));
}

function needsUiClock() {
  return Boolean(
    (state.room?.status === "selecting_opening" && state.room?.openingAutoPickAt) ||
      (state.room?.status === "spinning_order" && state.room?.orderSpinEndsAt)
  );
}

function stopUiClock() {
  if (!state.uiClock) return;
  clearInterval(state.uiClock);
  state.uiClock = null;
}

function syncUiClock() {
  if (needsUiClock()) {
    state.clockNow = Date.now();
    if (!state.uiClock) {
      state.uiClock = setInterval(() => {
        state.clockNow = Date.now();
        if (!needsUiClock()) {
          stopUiClock();
          return;
        }
        updateLiveClock();
      }, 1000);
    }
    return;
  }
  stopUiClock();
}

function updateLiveClock() {
  if (state.room?.status === "spinning_order") {
    const spinMs = state.room.orderSpinEndsAt ? new Date(state.room.orderSpinEndsAt).getTime() - state.clockNow : 0;
    const shouldReveal = spinMs <= 1800;
    const revealNode = document.querySelector(".spin-panel");
    if (shouldReveal && revealNode && !revealNode.classList.contains("is-revealed")) {
      render();
    }
    return;
  }
  const countdown = document.querySelector("[data-countdown]");
  if (!countdown || !state.room?.openingAutoPickAt) return;
  const ms = new Date(state.room.openingAutoPickAt).getTime() - state.clockNow;
  countdown.textContent = String(Math.max(1, Math.ceil(ms / 1000)));
}

function showCopied(button, label = "已复制") {
  if (!button) return;
  const original = button.textContent;
  button.textContent = label;
  button.disabled = true;
  setTimeout(() => {
    if (!button.isConnected) return;
    button.textContent = original;
    button.disabled = false;
  }, 1200);
}

function clearDraftAssist() {
  state.draft = "";
  state.polish = null;
  state.isPolishing = false;
}

function draftKey(room = state.room) {
  if (!room || !state.player?.id || !room.currentTurnPlayerId) return "";
  return `storyRelayDraft:${room.code}:${state.player.id}:${room.currentRound}:${room.currentTurnPlayerId}`;
}

function saveDraftToDevice() {
  const key = draftKey();
  if (!key) return;
  const value = state.draft.trim() ? state.draft : "";
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

function restoreDraftForCurrentTurn(room) {
  const key = draftKey(room);
  if (!key || state.draft || state.draftRestoredKey === key) return;
  const saved = localStorage.getItem(key);
  if (saved) {
    state.draft = saved;
    state.draftRestoredKey = key;
  }
}

function clearCurrentDraft() {
  const key = draftKey();
  if (key) localStorage.removeItem(key);
  state.draftRestoredKey = "";
  clearDraftAssist();
}

function clearSavedDrafts() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("storyRelayDraft:")) localStorage.removeItem(key);
  }
}

function actionBody(extra = {}) {
  return { ...extra, playerId: state.player?.id };
}

function layout(content, toolbar = "") {
  const syncTime = state.lastSyncAt
    ? new Date(state.lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : "";
  const connectionLabel = {
    idle: "",
    connecting: "连接中",
    online: syncTime ? `已同步 ${syncTime}` : "已同步",
    reconnecting: "重连中"
  }[state.connectionStatus] || "";
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">Story Relay</span>
          <h1>故事接龙工坊</h1>
          <span>多人轮流写作游戏 · 投票开局 · AI 主持</span>
        </div>
        <div class="toolbar">
          ${connectionLabel ? `<span class="connection ${state.connectionStatus}">${connectionLabel}</span>` : ""}
          ${toolbar}
        </div>
      </header>
      ${state.error ? `<div class="panel error">${escapeHtml(state.error)}</div>` : ""}
      ${content}
    </div>
  `;
}

function renderHome() {
  const resumeCard =
    state.lastRoomCode && !state.storyViewCode
      ? `
        <section class="panel resume-card">
          <div>
            <h2>继续上次房间</h2>
            <p class="muted">找到本机最近进入的房间 ${escapeHtml(state.lastRoomCode)}。</p>
          </div>
          <div class="row">
            <button id="resumeRoom" type="button">继续</button>
            <button id="forgetRoom" class="secondary" type="button">忘记这个房间</button>
          </div>
        </section>
      `
      : "";

  layout(`
    ${resumeCard}
    <section class="home-intro">
      <div>
        <p class="eyebrow">ONLINE STORY GAME</p>
        <h2>开一个房间，把故事交给下一位玩家。</h2>
        <p>投票选开头，轮流接一小段，主持人给要求、补中间段，最后导出完整故事。</p>
      </div>
      <div class="feature-strip">
        <span>2-6 人</span>
        <span>轮流写作</span>
        <span>AI 主持</span>
      </div>
    </section>
    <section class="grid home-grid">
      <form class="panel stack entry-card" id="createForm">
        <h2>创建房间</h2>
        <label>昵称<input name="name" maxlength="16" placeholder="例如：阿九" required /></label>
        <div class="split">
          <label>每人每轮字数
            <select name="wordLimit">
              <option value="80">80 字</option>
              <option value="120" selected>120 字</option>
              <option value="200">200 字</option>
            </select>
          </label>
          <label>总轮数
            <select name="maxRounds">
              <option value="6" selected>6 轮</option>
              <option value="8">8 轮</option>
              <option value="10">10 轮</option>
            </select>
          </label>
        </div>
        <label>时间限制
          <select name="timeLimit">
            <option value="none" selected>不限时</option>
            <option value="3">3 分钟</option>
            <option value="5">5 分钟</option>
          </select>
        </label>
        <label class="row"><input name="enableAIBridge" type="checkbox" checked /> 启用系统中间段</label>
        <label class="row"><input name="enableAIEnding" type="checkbox" checked /> 启用系统结尾</label>
        <button type="submit">创建房间</button>
      </form>

      <form class="panel stack entry-card" id="joinForm">
        <h2>加入房间</h2>
        <label>昵称<input name="name" maxlength="16" placeholder="例如：小林" required /></label>
        <label>房间码<input name="code" maxlength="5" placeholder="ABCDE" required /></label>
        <button type="submit">加入房间</button>
      </form>
    </section>
  `);

  document.querySelector("#resumeRoom")?.addEventListener("click", () => {
    resumeRoom();
  });

  document.querySelector("#forgetRoom")?.addEventListener("click", () => {
    clearSavedRoom();
    setError("");
  });

  document.querySelector("#createForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.pendingAction) return;
    const form = new FormData(event.currentTarget);
    state.pendingAction = "create";
    setFormBusy(event.currentTarget, true, "创建中…");
    try {
      const { room, player } = await api.post("/api/rooms", {
        name: form.get("name"),
        settings: {
          wordLimit: Number(form.get("wordLimit")),
          maxRounds: Number(form.get("maxRounds")),
          timeLimit: form.get("timeLimit"),
          enableAIBridge: form.has("enableAIBridge"),
          enableAIEnding: form.has("enableAIEnding")
        }
      });
      state.room = room;
      savePlayer(player);
      history.replaceState(null, "", "/");
      connect(room.code);
      setError("");
    } catch (error) {
      setError(error.message);
    } finally {
      state.pendingAction = "";
      if (!state.room) setFormBusy(event.currentTarget, false);
    }
  });

  document.querySelector("#joinForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.pendingAction) return;
    const form = new FormData(event.currentTarget);
    state.pendingAction = "join";
    setFormBusy(event.currentTarget, true, "加入中…");
    try {
      const { room, player } = await api.post("/api/join", {
        name: form.get("name"),
        code: form.get("code")
      });
      state.room = room;
      savePlayer(player);
      history.replaceState(null, "", "/");
      connect(room.code);
      setError("");
    } catch (error) {
      setError(error.message);
    } finally {
      state.pendingAction = "";
      if (!state.room) setFormBusy(event.currentTarget, false);
    }
  });
}

function renderPlayers() {
  return `
    <ul class="player-list">
      ${state.room.players
        .map(
          (player) => `
            <li class="player">
              <span>${escapeHtml(player.name)}</span>
              <span class="pill">${player.id === state.room.hostId ? "房主" : player.ready ? "已准备" : "未准备"}</span>
            </li>
          `
        )
        .join("")}
    </ul>
  `;
}

function renderEventLog(limit = 8) {
  const events = (state.room?.events || []).slice(-limit).reverse();
  if (!events.length) return "";
  return `
    <div class="event-log">
      <div class="row">
        <strong>事件日志</strong>
        <span class="pill">${events.length}</span>
      </div>
      <ul>
        ${events
          .map(
            (event) => `
              <li>
                <span>${escapeHtml(event.message)}</span>
                <time>${new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
              </li>
            `
          )
          .join("")}
      </ul>
    </div>
  `;
}

function renderStyleVote() {
  const votes = state.room.styleVotes || {};
  const votedStyle = styleOptions.find(([value]) => (votes[value] || []).includes(state.player?.id))?.[0];
  return `
    <div class="style-vote">
      <div class="row">
        <h3>投票选择故事风格</h3>
        <span class="pill">当前：${storyStyleLabel(state.room.storyStyle)}</span>
      </div>
      <div class="style-grid">
        ${styleOptions
          .map(([value, label]) => {
            const count = (votes[value] || []).length;
            const selected = votedStyle === value;
            return `
              <button class="style-option ${selected ? "selected" : ""}" data-style="${value}" type="button">
                <span>${label}</span>
                <small>${count} 票</small>
              </button>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderHostDiagnostics() {
  if (!isHost()) return "";
  const status = state.systemStatus;
  const aiLabel = status
    ? status.ai
      ? `AI 主持在线 · ${status.provider || "unknown"} / ${status.model || "unknown"}`
      : "工坊主持模式"
    : "尚未检查";
  const storageLabel = status
    ? status.storageReady
      ? `${status.storage || "storage"} 已连接`
      : "存储未连接"
    : "尚未检查";
  const lastError =
    status?.lastError?.message ||
    (typeof status?.storageLastError === "string" ? status.storageLastError : status?.storageLastError?.message) ||
    status?.message ||
    "";
  const lastGeneration = status?.lastGeneration;
  const generationLine = lastGeneration
    ? `最近生成：${lastGeneration.action || "AI 生成"} · ${lastGeneration.sourceLabel || "主持人"} · ${Math.round(lastGeneration.durationMs || 0)}ms`
    : "最近生成：暂无记录";

  return `
    <div class="diagnostics">
      <div class="row">
        <strong>主持状态</strong>
        <span class="pill">${state.systemStatusLoading ? "检查中" : aiLabel}</span>
      </div>
      <p class="muted">${storageLabel}${lastError ? ` · 最近提示：${escapeHtml(String(lastError).slice(0, 120))}` : ""}</p>
      <p class="muted">${escapeHtml(generationLine)}</p>
      <button id="refreshSystemStatus" class="secondary" type="button">
        ${state.systemStatusLoading ? "检查中…" : "刷新状态"}
      </button>
    </div>
  `;
}

function renderTitleTools(room) {
  if (!isHost() || !room.story?.openingText) return "";
  return `
    <div class="title-tools">
      <label>故事标题
        <input id="storyTitleInput" maxlength="16" value="${escapeHtml(room.story.title || "")}" />
      </label>
      <div class="row">
        <button id="saveStoryTitle" class="secondary" type="button">保存标题</button>
        <button id="suggestStoryTitle" class="secondary" type="button">生成标题</button>
      </div>
    </div>
  `;
}

function renderRoomCleanup(room) {
  if (!isHost()) return "";
  return `
    <div class="cleanup-box">
      <div>
        <strong>房间清理</strong>
        <p class="muted">测试结束后可以清理这个房间，避免下次又恢复到旧局。</p>
      </div>
      <button id="deleteRoom" class="warning" type="button">清理房间</button>
    </div>
  `;
}

function renderLobby() {
  const room = state.room;
  layout(
    `
      <section class="grid lobby-grid">
        <div class="panel stack room-card">
          <h2>房间码</h2>
          <div class="code">${room.code}</div>
          <p class="muted">把这个房间码发给朋友。当前支持 2–6 人。</p>
          ${renderPlayers()}
        </div>
        <div class="panel stack settings-card">
          <h2>本局设置</h2>
          ${
            isHost()
              ? `
                <div class="split">
                  <label>每人每轮字数
                    <select id="wordLimit">
                      ${[80, 120, 200].map((value) => `<option value="${value}" ${room.wordLimit === value ? "selected" : ""}>${value} 字</option>`).join("")}
                    </select>
                  </label>
                  <label>总轮数
                    <select id="maxRounds">
                      ${[6, 8, 10].map((value) => `<option value="${value}" ${room.maxRounds === value ? "selected" : ""}>${value} 轮</option>`).join("")}
                    </select>
                  </label>
                </div>
                <label>时间限制
                  <select id="timeLimit">
                    <option value="none" ${room.timeLimit === "none" ? "selected" : ""}>不限时</option>
                    <option value="3" ${room.timeLimit === "3" ? "selected" : ""}>3 分钟</option>
                    <option value="5" ${room.timeLimit === "5" ? "selected" : ""}>5 分钟</option>
                  </select>
                </label>
                <label class="row"><input id="enableAIBridge" type="checkbox" ${room.enableAIBridge ? "checked" : ""} /> 启用系统中间段</label>
                <label class="row"><input id="enableAIEnding" type="checkbox" ${room.enableAIEnding ? "checked" : ""} /> 启用系统结尾</label>
                <button id="saveSettings" class="secondary">保存设置</button>
                <button id="startGame" ${room.players.length < 2 ? "disabled" : ""}>开始游戏</button>
              `
              : `
                <p>每轮 ${room.wordLimit} 字以内，合计 ${room.maxRounds} 轮。</p>
                <p class="muted">风格：${storyStyleLabel(room.storyStyle)} · 系统中间段：${room.enableAIBridge ? "开启" : "关闭"} · 系统结尾：${room.enableAIEnding ? "开启" : "关闭"}</p>
                <button id="readyToggle">${state.player?.ready ? "取消准备" : "准备"}</button>
              `
          }
        </div>
        <div class="panel stack lobby-side">
          ${renderHostDiagnostics()}
          ${renderStyleVote()}
          ${renderRoomCleanup(room)}
          ${renderEventLog(6)}
        </div>
      </section>
    `,
    `<button class="secondary" id="leave">离开</button>`
  );

  document.querySelector("#leave").addEventListener("click", () => {
    clearSavedRoom();
    history.replaceState(null, "", "/");
    setError("");
  });

  document.querySelectorAll("[data-style]").forEach((button) => {
    button.addEventListener("click", async () => {
      await withButtonPending(button, "投票中…", async () => {
        try {
          await api.post(`/api/rooms/${room.code}/vote-style`, actionBody({ storyStyle: button.dataset.style }));
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
  });

  document.querySelector("#refreshSystemStatus")?.addEventListener("click", async (event) => {
    await withButtonPending(event.currentTarget, "检查中…", loadSystemStatus);
  });

  bindRoomCleanupAction();

  if (isHost() && !state.systemStatus && !state.systemStatusLoading) {
    loadSystemStatus();
  }

  if (isHost()) {
    document.querySelector("#saveSettings").addEventListener("click", async (event) => {
      await withButtonPending(event.currentTarget, "保存中…", async () => {
        try {
          await api.post(`/api/rooms/${room.code}/settings`, actionBody({
            wordLimit: Number(document.querySelector("#wordLimit").value),
            maxRounds: Number(document.querySelector("#maxRounds").value),
            timeLimit: document.querySelector("#timeLimit").value,
            enableAIBridge: document.querySelector("#enableAIBridge").checked,
            enableAIEnding: document.querySelector("#enableAIEnding").checked
          }));
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
    document.querySelector("#startGame").addEventListener("click", async (event) => {
      await withButtonPending(event.currentTarget, "生成开头中…", async () => {
        try {
          await api.post(`/api/rooms/${room.code}/start`, actionBody());
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
  } else {
    document.querySelector("#readyToggle").addEventListener("click", async (event) => {
      await withButtonPending(event.currentTarget, "同步中…", async () => {
        try {
          await api.post(`/api/rooms/${room.code}/ready`, actionBody({ ready: !state.player.ready }));
          state.player.ready = !state.player.ready;
          savePlayer(state.player);
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
  }
}

function renderOpeningSelection() {
  const votedId = state.room.openingOptions.find((option) => option.votes.includes(state.player?.id))?.id;
  const rerollVotes = state.room.openingRerollVotes || [];
  const rerollNeeded = Math.floor(state.room.players.length / 2) + 1;
  const hasRerollVoted = rerollVotes.includes(state.player?.id);
  const rerollNames = rerollVotes.map(playerName).join("、");
  const autoPickMs = state.room.openingAutoPickAt ? new Date(state.room.openingAutoPickAt).getTime() - state.clockNow : 0;
  const autoPickSeconds = Math.max(0, Math.ceil(autoPickMs / 1000));
  const autoPickOption = state.room.openingOptions.find((option) => option.id === state.room.openingAutoPickId);
  layout(`
    <section class="panel stack opening-panel">
      <div class="row">
        <h2>选择故事开头</h2>
        <span class="pill">房间 ${state.room.code}</span>
      </div>
      ${
        autoPickOption
          ? `
            <div class="countdown-box">
              <strong data-countdown>${autoPickSeconds || 1}</strong>
              <span>所有玩家已选中同一个开头，即将自动开始。</span>
            </div>
          `
          : `<p class="muted">所有玩家投到同一个开头后，会进入短倒计时并自动开始。</p>`
      }
      <div class="grid opening-grid">
        ${state.room.openingOptions
          .map(
            (option) => `
              <button class="option ${votedId === option.id ? "selected" : ""}" data-opening="${option.id}">
                <p>${escapeHtml(option.text)}</p>
                <span class="pill">${option.votes.length} 票</span>
              </button>
            `
          )
          .join("")}
      </div>
      ${
        isHost()
          ? `
            <div class="row">
              <button id="chooseOpening">确定开头</button>
            </div>
          `
          : `<p class="muted">投票后等待房主确定。</p>`
      }
      <div class="vote-box stack">
        <div class="row">
          <strong>重抽开头投票</strong>
          <span class="pill">${rerollVotes.length} / ${rerollNeeded}</span>
        </div>
        <p class="muted">觉得这批开头不够合适，可以投票换一批。超过半数同意后自动重抽，并清空开头票数。</p>
        ${rerollNames ? `<p class="muted">已投票：${escapeHtml(rerollNames)}</p>` : ""}
        <button id="rerollOpenings" class="${hasRerollVoted ? "secondary" : "warning"}" type="button">
          ${hasRerollVoted ? "撤回重抽投票" : "投票换一批开头"}
        </button>
      </div>
    </section>
  `);

  document.querySelectorAll("[data-opening]").forEach((button) => {
    button.addEventListener("click", async () => {
      await withButtonPending(button, "投票中…", async () => {
        try {
          await api.post(`/api/rooms/${state.room.code}/vote-opening`, actionBody({ openingId: button.dataset.opening }));
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
  });

  document.querySelector("#chooseOpening")?.addEventListener("click", async (event) => {
    await withButtonPending(event.currentTarget, "准备第一题…", async () => {
      try {
        await api.post(`/api/rooms/${state.room.code}/choose-opening`, actionBody({ openingId: votedId }));
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  });

  document.querySelector("#rerollOpenings")?.addEventListener("click", async (event) => {
    await withButtonPending(event.currentTarget, "处理中…", async () => {
      try {
        await api.post(`/api/rooms/${state.room.code}/reroll-openings`, actionBody({ vote: !hasRerollVoted }));
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  });
}

function renderOrderSpin() {
  const orderedPlayers = turnOrderedPlayers(state.room);
  const firstPlayer = orderedPlayers[0];
  const spinMs = state.room.orderSpinEndsAt ? new Date(state.room.orderSpinEndsAt).getTime() - state.clockNow : 0;
  const spinSeconds = Math.max(0, Math.ceil(spinMs / 1000));
  const revealResult = spinMs <= 1800;
  layout(`
    <section class="panel stack spin-panel ${revealResult ? "is-revealed" : ""}">
      <div class="row">
        <h2>抽取本局顺序</h2>
        <span class="pill">房间 ${state.room.code}</span>
      </div>
      <div class="spin-stage">
        <div class="wheel ${revealResult ? "settling" : ""}" aria-hidden="true">
          ${orderedPlayers
            .map((player, index) => `<span style="--i:${index};--n:${orderedPlayers.length}">${escapeHtml(player.name.slice(0, 2))}</span>`)
            .join("")}
        </div>
        ${
          revealResult
            ? `
              <div class="spin-result revealed">
                <span class="muted">第一位落笔</span>
                <strong>${escapeHtml(firstPlayer?.name || "即将揭晓")}</strong>
                <small>即将进入第一轮</small>
              </div>
            `
            : `
              <div class="spin-result drawing">
                <span class="muted">正在抽取</span>
                <strong>?</strong>
                <small>${Math.max(2, spinSeconds)} 秒后揭晓顺序</small>
              </div>
            `
        }
      </div>
      ${
        revealResult
          ? `
            <div class="turn-order-list revealed">
              ${orderedPlayers
                .map(
                  (player, index) => `
                    <div class="${index === 0 ? "selected" : ""}">
                      <span>${index + 1}</span>
                      <strong>${escapeHtml(player.name)}</strong>
                    </div>
                  `
                )
                .join("")}
            </div>
          `
          : `
            <div class="turn-order-list hidden-order">
              ${orderedPlayers.map((_, index) => `<div><span>${index + 1}</span><strong>抽取中</strong></div>`).join("")}
            </div>
          `
      }
    </section>
  `);
}

function renderStory() {
  const canRewriteSystem = isHost() && !state.storyViewCode;
  const segments = state.room.story.segments || [];
  return `
    <div class="story">
      <div class="opening">${escapeHtml(state.room.story.openingText || "故事还没有开始。")}</div>
      ${
        segments.length
          ? segments
              .map(
                (segment) => `
                  <article class="segment ${segment.authorType === "system" ? "system" : ""}">
                    <div class="segment-head">
                      <strong>${escapeHtml(segment.authorName)}</strong>
                      <span>第 ${segment.roundNumber || "-"} 轮</span>
                    </div>
                    <p>${escapeHtml(segment.text)}</p>
                    ${
                      canRewriteSystem && segment.authorType === "system"
                        ? `
                          <div class="segment-tools">
                            <button class="secondary" data-rewrite-segment="${segment.id}" data-tone="balanced" type="button">重写</button>
                            <button class="secondary" data-rewrite-segment="${segment.id}" data-tone="restrained" type="button">更克制</button>
                            <button class="secondary" data-rewrite-segment="${segment.id}" data-tone="dramatic" type="button">更戏剧</button>
                          </div>
                        `
                        : ""
                    }
                  </article>
                `
              )
              .join("")
          : `<div class="empty-story">故事还在等第一位玩家落笔。</div>`
      }
    </div>
  `;
}

function bindSystemSegmentActions() {
  document.querySelectorAll("[data-rewrite-segment]").forEach((button) => {
    button.addEventListener("click", async () => {
      await withButtonPending(button, "重写中…", async () => {
        try {
          await api.post(`/api/rooms/${state.room.code}/rewrite-system-segment`, actionBody({
            segmentId: button.dataset.rewriteSegment,
            tone: button.dataset.tone
          }));
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
  });
}

function bindTitleActions() {
  document.querySelector("#saveStoryTitle")?.addEventListener("click", async (event) => {
    await withButtonPending(event.currentTarget, "保存中…", async () => {
      try {
        const title = document.querySelector("#storyTitleInput")?.value || "";
        await api.post(`/api/rooms/${state.room.code}/rename-story`, actionBody({ title }));
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  });

  document.querySelector("#suggestStoryTitle")?.addEventListener("click", async (event) => {
    await withButtonPending(event.currentTarget, "生成中…", async () => {
      try {
        await api.post(`/api/rooms/${state.room.code}/suggest-title`, actionBody());
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  });
}

function bindRoomCleanupAction() {
  document.querySelector("#deleteRoom")?.addEventListener("click", async (event) => {
    const ok = window.confirm("确定清理这个房间吗？清理后房间码会失效，已导出的故事不受影响。");
    if (!ok) return;
    await withButtonPending(event.currentTarget, "清理中…", async () => {
      try {
        await api.post(`/api/rooms/${state.room.code}/delete-room`, actionBody());
        clearSavedRoom();
        history.replaceState(null, "", "/");
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  });
}

function renderStoryView() {
  const room = state.room;
  const title = room?.story?.title || "故事接龙";
  layout(
    `
      <section class="reader-layout">
        <div class="panel stack story-reader">
          <div class="row">
            <h2>${escapeHtml(title)}</h2>
            <span class="pill">房间 ${escapeHtml(room.code)}</span>
          </div>
          <p class="muted">参与玩家：${escapeHtml(room.players.map((player) => player.name).join("、") || "暂无")}</p>
          ${renderStory()}
        </div>
        <aside class="panel stack reader-actions">
          <h3>分享故事</h3>
          <label>阅读链接<input id="shareLink" readonly value="${escapeHtml(storyShareUrl(room.code))}" /></label>
          <button id="copyShareLink" type="button">复制链接</button>
          <a href="/api/rooms/${room.code}/export.md" download><button class="warning" type="button">导出 Markdown</button></a>
          <button id="backHome" class="secondary" type="button">回到首页</button>
        </aside>
      </section>
    `,
    `<button class="secondary" id="homeLink" type="button">首页</button>`
  );

  const goHome = () => {
    state.room = null;
    state.storyViewCode = "";
    history.replaceState(null, "", "/");
    renderHome();
  };

  document.querySelector("#copyShareLink")?.addEventListener("click", async (event) => {
    const link = storyShareUrl(room.code);
    await navigator.clipboard?.writeText(link);
    const input = document.querySelector("#shareLink");
    input?.select();
    showCopied(event.currentTarget);
  });
  document.querySelector("#backHome")?.addEventListener("click", goHome);
  document.querySelector("#homeLink")?.addEventListener("click", goHome);
}

function renderRequirement() {
  const req = state.room.currentRequirement;
  if (!req) return "";
  return `
    <div class="requirement">
      <div>关键词：<strong>${escapeHtml(req.keyword)}</strong></div>
      <div>情绪：<strong>${escapeHtml(req.emotion)}</strong></div>
      <div>转折：<strong>${escapeHtml(req.twist)}</strong></div>
    </div>
  `;
}

function renderRequirementRerollVote(room) {
  const votes = room.requirementRerollVotes || [];
  const needed = Math.floor(room.players.length / 2) + 1;
  const hasVoted = votes.includes(state.player?.id);
  const names = votes.map(playerName).join("、");

  return `
    <div class="action-strip">
      <div>
        <strong>换题</strong>
        <span class="muted">${votes.length}/${needed}${names ? ` · ${escapeHtml(names)}` : ""}</span>
      </div>
      <button id="requirementVote" class="${hasVoted ? "secondary" : "warning"}" type="button">
        ${hasVoted ? "撤回" : "投票"}
      </button>
    </div>
  `;
}

function renderEndingVote(room) {
  const votes = room.endVotes || [];
  const needed = Math.floor(room.players.length / 2) + 1;
  const hasVoted = votes.includes(state.player?.id);
  const names = votes.map(playerName).join("、");

  return `
    <div class="action-strip">
      <div>
        <strong>结尾</strong>
        <span class="muted">${votes.length}/${needed}${names ? ` · ${escapeHtml(names)}` : ""}</span>
      </div>
      <button id="endingVote" class="${hasVoted ? "secondary" : "warning"}" type="button">
        ${hasVoted ? "撤回" : "投票"}
      </button>
    </div>
  `;
}

function renderPolishPanel() {
  if (state.isPolishing) {
    return `<div class="assist-box muted">AI 主持人正在整理语句……</div>`;
  }

  if (!state.polish) {
    return `<button id="polishSegment" class="secondary" type="button">AI 帮我润色</button>`;
  }

  return `
    <div class="assist-box stack">
      <div class="row">
        <strong>AI 润色建议</strong>
        <span class="pill">提交前可选</span>
      </div>
      <p>${escapeHtml(state.polish.polished)}</p>
      <div class="notes">
        ${state.polish.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}
      </div>
      <div class="row">
        <button id="acceptPolish" type="button">采用润色版</button>
        <button id="discardPolish" class="secondary" type="button">保留原文</button>
      </div>
    </div>
  `;
}

function updateWordCounter(room) {
  const counter = document.querySelector("#wordCounter");
  if (!counter) return;
  counter.textContent = `${state.draft.length} / ${room.wordLimit} 字`;
  counter.className = state.draft.length > room.wordLimit ? "error" : "muted";
}

function refreshPolishArea() {
  const area = document.querySelector("#polishArea");
  if (!area) return;
  area.innerHTML = renderPolishPanel();
  bindPolishActions();
}

function bindPolishActions() {
  document.querySelector("#polishSegment")?.addEventListener("click", async () => {
    try {
      state.isPolishing = true;
      refreshPolishArea();
      const { polish } = await api.post(
        `/api/rooms/${state.room.code}/polish-segment`,
        actionBody({ text: state.draft })
      );
      state.polish = polish;
      state.isPolishing = false;
      state.error = "";
      refreshPolishArea();
    } catch (error) {
      state.isPolishing = false;
      setError(error.message);
    }
  });

  document.querySelector("#acceptPolish")?.addEventListener("click", () => {
    if (!state.polish) return;
    state.draft = state.polish.polished;
    state.polish = null;
    const draft = document.querySelector("#draft");
    if (draft) {
      draft.value = state.draft;
      draft.focus();
    }
    saveDraftToDevice();
    updateWordCounter(state.room);
    refreshPolishArea();
  });

  document.querySelector("#discardPolish")?.addEventListener("click", () => {
    state.polish = null;
    refreshPolishArea();
    document.querySelector("#draft")?.focus();
  });
}

function renderPlaying() {
  const room = state.room;
  if (isCurrentPlayer()) {
    restoreDraftForCurrentTurn(room);
  } else if (state.draft || state.polish || state.isPolishing) {
    clearDraftAssist();
  }
  const remaining = room.wordLimit - state.draft.length;
  layout(`
    <section class="game-grid">
      <div class="panel stack story-panel">
        <div class="row">
          <h2>${escapeHtml(room.story.title)}</h2>
          <span class="pill">第 ${room.currentRound} / ${room.maxRounds} 轮</span>
        </div>
        ${renderTitleTools(room)}
        ${renderStory()}
      </div>
      <aside class="panel stack turn-panel">
        <div class="turn-head">
          <h3>当前回合</h3>
          <span class="pill">${storyStyleLabel(room.storyStyle)}</span>
        </div>
        <p class="turn-player">轮到：<strong>${escapeHtml(playerName(room.currentTurnPlayerId))}</strong></p>
        <div class="row">
          ${turnOrderedPlayers(room)
            .map((player) => `<span class="pill ${player.id === room.currentTurnPlayerId ? "active-turn" : ""}">${escapeHtml(player.name)}</span>`)
            .join("")}
        </div>
        ${renderRequirement()}
        <div class="action-grid">
          ${renderRequirementRerollVote(room)}
          ${renderEndingVote(room)}
        </div>
        ${renderHostDiagnostics()}
        ${
          isCurrentPlayer()
            ? `
              <label>写下一小段
                <textarea id="draft" maxlength="${room.wordLimit}" placeholder="自然接上上一段，并记得包含关键词。">${escapeHtml(state.draft)}</textarea>
              </label>
              <div id="wordCounter" class="${remaining < 0 ? "error" : "muted"}">${state.draft.length} / ${room.wordLimit} 字</div>
              <div id="polishArea">${renderPolishPanel()}</div>
              <p class="draft-hint">${draftKey(room) && localStorage.getItem(draftKey(room)) ? "草稿已保存在这台设备上。" : "输入会自动保存在这台设备上。"}</p>
              <button id="submitSegment">提交段落</button>
            `
            : `
              <div class="waiting-box">
                <strong>等待 ${escapeHtml(playerName(room.currentTurnPlayerId))} 写作中</strong>
                <span>故事会在对方提交后自动同步。</span>
              </div>
            `
        }
        ${renderEventLog(7)}
      </aside>
    </section>
  `);

  const draft = document.querySelector("#draft");
  document.querySelector("#refreshSystemStatus")?.addEventListener("click", async (event) => {
    await withButtonPending(event.currentTarget, "检查中…", loadSystemStatus);
  });
  if (isHost() && !state.systemStatus && !state.systemStatusLoading) {
    loadSystemStatus();
  }
  if (draft) {
    draft.addEventListener("input", (event) => {
      state.draft = event.target.value;
      saveDraftToDevice();
      if (state.polish?.original !== state.draft) {
        state.polish = null;
        state.isPolishing = false;
        refreshPolishArea();
      }
      updateWordCounter(room);
    });
    bindPolishActions();
    document.querySelector("#endingVote")?.addEventListener("click", async (event) => {
      await withButtonPending(event.currentTarget, "同步中…", async () => {
        try {
          const hasVoted = (room.endVotes || []).includes(state.player?.id);
          await api.post(`/api/rooms/${room.code}/vote-ending`, actionBody({ vote: !hasVoted }));
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
    document.querySelector("#requirementVote")?.addEventListener("click", async (event) => {
      await withButtonPending(event.currentTarget, "换题中…", async () => {
        try {
          const hasVoted = (room.requirementRerollVotes || []).includes(state.player?.id);
          await api.post(`/api/rooms/${room.code}/reroll-requirement`, actionBody({ vote: !hasVoted }));
          state.polish = null;
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
    document.querySelector("#submitSegment").addEventListener("click", async (event) => {
      await withButtonPending(event.currentTarget, "提交中…", async () => {
        try {
          await api.post(`/api/rooms/${room.code}/submit-segment`, actionBody({ text: state.draft }));
          clearCurrentDraft();
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
  }

  if (!draft) {
    document.querySelector("#endingVote")?.addEventListener("click", async (event) => {
      await withButtonPending(event.currentTarget, "同步中…", async () => {
        try {
          const hasVoted = (room.endVotes || []).includes(state.player?.id);
          await api.post(`/api/rooms/${room.code}/vote-ending`, actionBody({ vote: !hasVoted }));
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
    document.querySelector("#requirementVote")?.addEventListener("click", async (event) => {
      await withButtonPending(event.currentTarget, "换题中…", async () => {
        try {
          const hasVoted = (room.requirementRerollVotes || []).includes(state.player?.id);
          await api.post(`/api/rooms/${room.code}/reroll-requirement`, actionBody({ vote: !hasVoted }));
          setError("");
        } catch (error) {
          setError(error.message);
        }
      });
    });
  }

  bindSystemSegmentActions();
  bindTitleActions();
  bindRoomCleanupAction();
}

function renderEnding() {
  const shareUrl = storyShareUrl(state.room.code);
  layout(`
    <section class="game-grid">
      <div class="panel stack story-panel">
        <div class="row">
          <h2>${escapeHtml(state.room.story.title)}</h2>
          <span class="pill">${state.room.status === "finished" ? "已完成" : "结尾阶段"}</span>
        </div>
        ${renderTitleTools(state.room)}
        ${renderStory()}
      </div>
      <aside class="panel stack turn-panel">
        <h3>收束故事</h3>
        ${
          state.room.status === "ending"
            ? `
              <p class="muted">已经达到设定轮数。可以生成一个系统结尾，或让大家继续加写一轮。</p>
              <button id="generateEnding">生成结尾</button>
              <button id="continueRound" class="secondary">继续一轮</button>
            `
            : `<p class="success">故事已经完成。</p>`
        }
        <label>分享阅读链接<input id="shareLink" readonly value="${escapeHtml(shareUrl)}" /></label>
        <button id="copyShareLink" class="secondary" type="button">复制分享链接</button>
        <a href="/api/rooms/${state.room.code}/export.md" download><button class="warning">导出 Markdown</button></a>
        ${renderRoomCleanup(state.room)}
      </aside>
    </section>
  `);

  document.querySelector("#generateEnding")?.addEventListener("click", async (event) => {
    await withButtonPending(event.currentTarget, "生成中…", async () => {
      try {
        await api.post(`/api/rooms/${state.room.code}/generate-ending`, actionBody());
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  });

  bindSystemSegmentActions();
  bindTitleActions();
  bindRoomCleanupAction();

  document.querySelector("#continueRound")?.addEventListener("click", async (event) => {
    await withButtonPending(event.currentTarget, "继续中…", async () => {
      try {
        await api.post(`/api/rooms/${state.room.code}/continue-round`, actionBody());
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  });

  document.querySelector("#copyShareLink")?.addEventListener("click", async (event) => {
    await navigator.clipboard?.writeText(shareUrl);
    document.querySelector("#shareLink")?.select();
    showCopied(event.currentTarget);
  });
}

function render() {
  if (state.storyViewCode) {
    if (state.room) renderStoryView();
    else {
      layout(`
        <section class="panel stack">
          <h2>正在打开故事</h2>
          <p class="muted">如果房间码不存在，稍后这里会显示错误提示。</p>
        </section>
      `);
    }
    return;
  }

  const activeDraft = document.activeElement?.id === "draft";
  const draftElement = activeDraft ? document.querySelector("#draft") : null;
  const draftSelection = draftElement
    ? {
        start: draftElement.selectionStart,
        end: draftElement.selectionEnd,
        scrollTop: draftElement.scrollTop,
        windowX: window.scrollX,
        windowY: window.scrollY
      }
    : null;

  if (!state.room) {
    renderHome();
    return;
  }

  if (state.room.status === "lobby") renderLobby();
  if (state.room.status === "selecting_opening") renderOpeningSelection();
  if (state.room.status === "spinning_order") renderOrderSpin();
  if (state.room.status === "playing") renderPlaying();
  if (state.room.status === "ending" || state.room.status === "finished") renderEnding();

  if (activeDraft && draftSelection) {
    const nextDraft = document.querySelector("#draft");
    if (nextDraft) {
      nextDraft.focus();
      nextDraft.setSelectionRange(draftSelection.start, draftSelection.end);
      nextDraft.scrollTop = draftSelection.scrollTop;
      window.scrollTo(draftSelection.windowX, draftSelection.windowY);
    }
  }
}

if (state.storyViewCode) {
  render();
  openStoryView();
} else {
  render();
}

window.addEventListener("online", refreshCurrentRoom);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshCurrentRoom();
});
