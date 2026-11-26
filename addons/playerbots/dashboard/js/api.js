// Same-origin JSON helpers for the dashboard's /api routes.

// Plain-language text for the EveJS API's error codes.
const ERROR_TEXT = {
  PLAYERBOT_NOT_FOUND: "This character is not a playerbot, or it has been deleted.",
  PLAYERBOT_CORPORATION_NOT_FOUND: "No bot corporation has this ID. It may have been emptied or dissolved.",
  PLAYERBOT_OPERATION_NOT_FOUND: "This operation is no longer in the archive.",
  PLAYERBOTS_ADDON_ROUTE_NOT_FOUND: "The EveJS server does not offer this dashboard feature yet. Rebuild and restart the server so it runs this version of the add-on's integration files.",
  PLAYERBOTS_ADDON_UNAUTHORIZED: "EveJS refused the dashboard's API token. Check that the server and the add-on use the same EVEJS_PLAYER_BOTS_ADDON_TOKEN.",
  PLAYERBOTS_ADDON_API_ERROR: "EveJS reported an internal error. Check the server log.",
  PLAYERBOTS_DASHBOARD_BUSY: "EveJS did not answer within 30 seconds. The game server is busy; the dashboard keeps trying.",
  PLAYERBOTS_DASHBOARD_REQUEST_EXPIRED: "EveJS was too busy to answer in time. The dashboard keeps trying.",
  PLAYERBOT_SETTINGS_INVALID: "EveJS rejected these settings.",
};

export function errorText(code, fallback) {
  const text = String(code || "");
  return ERROR_TEXT[text] || text || fallback;
}

// Throws an Error with a readable message, the HTTP status and the raw code.
export async function getJSON(path) {
  const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) {
    let code = "";
    try { code = (await response.json()).error || ""; } catch { /* keep generic */ }
    const error = new Error(errorText(code, `Request failed (${response.status}).`));
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return response.json();
}

// Returns the parsed body; throws with the server's message on 4xx/5xx.
export async function postJSON(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || errorText(data.error, `Request failed (${response.status}).`));
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

// Large selections go in chunks of 500 pilots to stay under the request size
// limit; the server merges each chunk into the running order.
export async function corpCommand(corporationID, action, args = {}) {
  const ids = Array.isArray(args.characterIDs) ? [...args.characterIDs] : null;
  if (!ids || ids.length <= 500) return postJSON("/api/corp-command", { corporationID, action, args });
  let last = null;
  let sent = 0;
  while (ids.length) {
    const chunk = ids.splice(0, 500);
    last = await postJSON("/api/corp-command", { corporationID, action, args: { ...args, characterIDs: chunk } });
    sent += chunk.length;
  }
  return { ...last, message: `${action === "recall" ? "Recall" : "Order"} sent for ${sent.toLocaleString("en-US")} pilot(s). ${last.message}` };
}

// Sends pilot orders in batches of 50, the server's per-request limit.
export async function botCommand(characterIDs, action, args = {}) {
  const ids = [...characterIDs];
  const results = [];
  let message = "";
  while (ids.length) {
    const chunk = ids.splice(0, 50);
    try {
      const data = await postJSON("/api/bot-command", { characterIDs: chunk, action, args });
      results.push(...(data.results || []));
      message = data.message;
    } catch (error) {
      results.push(...((error.data && error.data.results) || chunk.map((characterID) => ({ characterID, success: false, message: error.message }))));
      message = error.message;
    }
  }
  const ok = results.filter((row) => row.success).length;
  return { ok, total: results.length, results, message: results.length === 1 ? (results[0].message || message) : `${ok} of ${results.length} pilot(s) accepted.` };
}
