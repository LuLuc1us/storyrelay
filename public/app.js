const app = document.querySelector("#app");

const state = {
  room: null,
  player: JSON.parse(localStorage.getItem("storyRelayPlayer") || "null"),
  eventSource: null,
  error: "",
  draft: "",
  polish: null,
  isPolishing: false
};

const api = {
  async post(path, body = {}) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "操作失败。");
    return data;
  }
};

function savePlayer(player) {
  state.player = player;
  localStorage.setItem("storyRelayPlayer", JSON.stringify(player));
}

function setError(message) {
  state.error = message || "";
  render();
}

function connect(code) {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource(`/api/rooms/${code}/events`);
  state.eventSource.onmessage = (event) => {
    state.room = JSON.parse(event.data);
    render();
  };
  state.eventSource.onerror = () => {
    state.error = "同步连接暂时断开，浏览器会自动重连。";
    render();
  };
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

function clearDraftAssist() {
  state.draft = "";
  state.polish = null;
  state.isPolishing = false;
}

function actionBody(extra = {}) {
  return { ...extra, playerId: state.player?.id };
}

function layout(content, toolbar = "") {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <h1>故事接龙工坊</h1>
          <span>Story Relay · 多人轮流写作游戏</span>
        </div>
        <div class="toolbar">${toolbar}</div>
      </header>
      ${state.error ? `<div class="panel error">${escapeHtml(state.error)}</div>` : ""}
      ${content}
    </div>
  `;
}

function renderHome() {
  layout(`
    <section class="grid">
      <form class="panel stack" id="createForm">
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

      <form class="panel stack" id="joinForm">
        <h2>加入房间</h2>
        <label>昵称<input name="name" maxlength="16" placeholder="例如：小林" required /></label>
        <label>房间码<input name="code" maxlength="5" placeholder="ABCDE" required /></label>
        <button type="submit">加入房间</button>
      </form>
    </section>
  `);

  document.querySelector("#createForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
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
      connect(room.code);
      setError("");
    } catch (error) {
      setError(error.message);
    }
  });

  document.querySelector("#joinForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const { room, player } = await api.post("/api/join", {
        name: form.get("name"),
        code: form.get("code")
      });
      state.room = room;
      savePlayer(player);
      connect(room.code);
      setError("");
    } catch (error) {
      setError(error.message);
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

function renderLobby() {
  const room = state.room;
  layout(
    `
      <section class="grid">
        <div class="panel stack">
          <h2>房间码</h2>
          <div class="code">${room.code}</div>
          <p class="muted">把这个房间码发给朋友。当前支持 2–6 人。</p>
          ${renderPlayers()}
        </div>
        <div class="panel stack">
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
                <p class="muted">系统中间段：${room.enableAIBridge ? "开启" : "关闭"} · 系统结尾：${room.enableAIEnding ? "开启" : "关闭"}</p>
                <button id="readyToggle">${state.player?.ready ? "取消准备" : "准备"}</button>
              `
          }
        </div>
      </section>
    `,
    `<button class="secondary" id="leave">离开</button>`
  );

  document.querySelector("#leave").addEventListener("click", () => {
    localStorage.removeItem("storyRelayPlayer");
    location.reload();
  });

  if (isHost()) {
    document.querySelector("#saveSettings").addEventListener("click", async () => {
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
    document.querySelector("#startGame").addEventListener("click", async () => {
      try {
        await api.post(`/api/rooms/${room.code}/start`, actionBody());
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  } else {
    document.querySelector("#readyToggle").addEventListener("click", async () => {
      try {
        await api.post(`/api/rooms/${room.code}/ready`, actionBody({ ready: !state.player.ready }));
        state.player.ready = !state.player.ready;
        savePlayer(state.player);
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  }
}

function renderOpeningSelection() {
  const votedId = state.room.openingOptions.find((option) => option.votes.includes(state.player?.id))?.id;
  layout(`
    <section class="panel stack">
      <div class="row">
        <h2>选择故事开头</h2>
        <span class="pill">房间 ${state.room.code}</span>
      </div>
      <div class="grid">
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
          ? `<button id="chooseOpening">确定开头</button>`
          : `<p class="muted">投票后等待房主确定。</p>`
      }
    </section>
  `);

  document.querySelectorAll("[data-opening]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api.post(`/api/rooms/${state.room.code}/vote-opening`, actionBody({ openingId: button.dataset.opening }));
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  });

  document.querySelector("#chooseOpening")?.addEventListener("click", async () => {
    try {
      await api.post(`/api/rooms/${state.room.code}/choose-opening`, actionBody({ openingId: votedId }));
      setError("");
    } catch (error) {
      setError(error.message);
    }
  });
}

function renderStory() {
  return `
    <div class="story">
      <div class="opening">${escapeHtml(state.room.story.openingText || "故事还没有开始。")}</div>
      ${state.room.story.segments
        .map(
          (segment) => `
            <article class="segment ${segment.authorType === "system" ? "system" : ""}">
              <div class="segment-head">
                <strong>${escapeHtml(segment.authorName)}</strong>
                <span>第 ${segment.roundNumber || "-"} 轮</span>
              </div>
              <p>${escapeHtml(segment.text)}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
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
  const remaining = room.wordLimit - state.draft.length;
  layout(`
    <section class="game-grid">
      <div class="panel stack">
        <div class="row">
          <h2>${escapeHtml(room.story.title)}</h2>
          <span class="pill">第 ${room.currentRound} / ${room.maxRounds} 轮</span>
        </div>
        ${renderStory()}
      </div>
      <aside class="panel stack">
        <h3>当前回合</h3>
        <p>轮到：<strong>${escapeHtml(playerName(room.currentTurnPlayerId))}</strong></p>
        <div class="row">
          ${room.players.map((player) => `<span class="pill">${escapeHtml(player.name)}</span>`).join("")}
        </div>
        ${renderRequirement()}
        ${
          isCurrentPlayer()
            ? `
              <label>写下一小段
                <textarea id="draft" maxlength="${room.wordLimit}" placeholder="自然接上上一段，并记得包含关键词。">${escapeHtml(state.draft)}</textarea>
              </label>
              <div id="wordCounter" class="${remaining < 0 ? "error" : "muted"}">${state.draft.length} / ${room.wordLimit} 字</div>
              <div id="polishArea">${renderPolishPanel()}</div>
              <button id="submitSegment">提交段落</button>
            `
            : `<p class="muted">等待当前玩家写作中。</p>`
        }
      </aside>
    </section>
  `);

  const draft = document.querySelector("#draft");
  if (draft) {
    draft.addEventListener("input", (event) => {
      state.draft = event.target.value;
      if (state.polish?.original !== state.draft) {
        state.polish = null;
        state.isPolishing = false;
        refreshPolishArea();
      }
      updateWordCounter(room);
    });
    bindPolishActions();
    document.querySelector("#submitSegment").addEventListener("click", async () => {
      try {
        await api.post(`/api/rooms/${room.code}/submit-segment`, actionBody({ text: state.draft }));
        clearDraftAssist();
        setError("");
      } catch (error) {
        setError(error.message);
      }
    });
  }
}

function renderEnding() {
  layout(`
    <section class="game-grid">
      <div class="panel stack">
        <div class="row">
          <h2>${escapeHtml(state.room.story.title)}</h2>
          <span class="pill">${state.room.status === "finished" ? "已完成" : "结尾阶段"}</span>
        </div>
        ${renderStory()}
      </div>
      <aside class="panel stack">
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
        <a href="/api/rooms/${state.room.code}/export.md" download><button class="warning">导出 Markdown</button></a>
      </aside>
    </section>
  `);

  document.querySelector("#generateEnding")?.addEventListener("click", async () => {
    try {
      await api.post(`/api/rooms/${state.room.code}/generate-ending`, actionBody());
      setError("");
    } catch (error) {
      setError(error.message);
    }
  });

  document.querySelector("#continueRound")?.addEventListener("click", async () => {
    try {
      await api.post(`/api/rooms/${state.room.code}/continue-round`, actionBody());
      setError("");
    } catch (error) {
      setError(error.message);
    }
  });
}

function render() {
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

render();
