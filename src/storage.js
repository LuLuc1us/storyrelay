let lastStorageError = null;
let lastStorageCleanup = null;

const DEFAULT_ACTIVE_ROOM_HOURS = 72;
const DEFAULT_FINISHED_ROOM_DAYS = 14;
const DEFAULT_ABANDONED_LOBBY_HOURS = 12;

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return {
    url: url.replace(/\/+$/, ""),
    key,
    table: process.env.SUPABASE_ROOMS_TABLE || "story_rooms"
  };
}

export function getStorageStatusSnapshot() {
  return {
    storage: supabaseConfig() ? "supabase" : "memory",
    storageReady: Boolean(supabaseConfig()),
    storageLastError: lastStorageError,
    storageLastCleanup: lastStorageCleanup
  };
}

export async function restoreRooms(rooms) {
  const config = supabaseConfig();
  if (!config) return;

  try {
    const response = await fetch(`${config.url}/rest/v1/${config.table}?select=code,data`, {
      headers: supabaseHeaders(config)
    });

    if (!response.ok) {
      await recordStorageError("restore", response);
      return;
    }

    const rows = await response.json();
    let restored = 0;
    let skipped = 0;
    for (const row of rows) {
      if (!row?.code || !row?.data) continue;
      if (shouldRestoreRoom(row.data)) {
        rooms.set(row.code, normalizeRoomForStorage(row.data));
        restored += 1;
      } else {
        skipped += 1;
        await deleteRoom(row.code, { silent: true });
      }
    }
    lastStorageCleanup = {
      restored,
      skipped,
      at: new Date().toISOString()
    };
    lastStorageError = null;
    console.log(`Restored ${restored} room(s) from Supabase. Skipped ${skipped} stale room(s).`);
  } catch (error) {
    recordStorageException("restore", error);
  }
}

export async function saveRoom(room) {
  const config = supabaseConfig();
  if (!config || !room?.code) return;

  try {
    const response = await fetch(`${config.url}/rest/v1/${config.table}`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(config),
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        code: room.code,
        data: normalizeRoomForStorage(room),
        updated_at: new Date().toISOString()
      })
    });

    if (!response.ok) {
      await recordStorageError("save", response);
      return;
    }

    lastStorageError = null;
  } catch (error) {
    recordStorageException("save", error);
  }
}

export async function deleteRoom(code, options = {}) {
  const config = supabaseConfig();
  if (!config || !code) return true;

  try {
    const response = await fetch(`${config.url}/rest/v1/${config.table}?code=eq.${encodeURIComponent(code)}`, {
      method: "DELETE",
      headers: supabaseHeaders(config)
    });

    if (!response.ok) {
      if (!options.silent) await recordStorageError("delete", response);
      return false;
    }

    lastStorageError = null;
    return true;
  } catch (error) {
    if (!options.silent) recordStorageException("delete", error);
    return false;
  }
}

function normalizeRoomForStorage(room) {
  return {
    ...room,
    updatedAt: new Date().toISOString()
  };
}

function roomAgeHours(room, nowMs = Date.now()) {
  const updatedAt = Date.parse(room?.updatedAt || room?.createdAt || "");
  if (!Number.isFinite(updatedAt)) return 0;
  return (nowMs - updatedAt) / 36e5;
}

function shouldRestoreRoom(room) {
  if (!room || room.archivedAt || room.deletedAt) return false;
  const ageHours = roomAgeHours(room);
  const status = room.status || "lobby";
  const activeRoomHours = Number(process.env.ROOM_ACTIVE_RETENTION_HOURS || DEFAULT_ACTIVE_ROOM_HOURS);
  const finishedRoomHours = Number(process.env.ROOM_FINISHED_RETENTION_DAYS || DEFAULT_FINISHED_ROOM_DAYS) * 24;
  const abandonedLobbyHours = Number(process.env.ROOM_ABANDONED_LOBBY_HOURS || DEFAULT_ABANDONED_LOBBY_HOURS);

  if (status === "finished") return ageHours <= finishedRoomHours;
  if (status === "lobby" || status === "selecting_opening") return ageHours <= abandonedLobbyHours;
  return ageHours <= activeRoomHours;
}

function supabaseHeaders(config) {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json"
  };
}

async function recordStorageError(action, response) {
  const message = await response.text();
  lastStorageError = {
    action,
    status: response.status,
    message: message.slice(0, 500),
    at: new Date().toISOString()
  };
  console.warn(`Supabase ${action} failed: ${response.status} ${message}`);
}

function recordStorageException(action, error) {
  lastStorageError = {
    action,
    status: "NETWORK",
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString()
  };
  console.warn(`Supabase ${action} failed: ${error.message || error}`);
}
