let lastStorageError = null;

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
    storageLastError: lastStorageError
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
    for (const row of rows) {
      if (row?.code && row?.data) rooms.set(row.code, row.data);
    }
    lastStorageError = null;
    console.log(`Restored ${rows.length} room(s) from Supabase.`);
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
        data: room,
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
