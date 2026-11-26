"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const STATIC_ROOT = path.join(__dirname, "dashboard");
const MAX_PROXY_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
// A corporation logo upload: six base64 PNGs, 32 to 1024 pixels.
const MAX_LOGO_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_CORPORATION_LOGO_BYTES = 2 * 1024 * 1024;
const CORPORATION_LOGO_SIZES = new Set([32, 64, 128, 256, 512, 1024]);
const MAX_SHIP_RENDER_BYTES = 512 * 1024;
const MAX_CHARACTER_PORTRAIT_BYTES = 2 * 1024 * 1024;
const SHIP_RENDER_SIZES = new Set([32, 64, 128, 256, 512]);
const CHARACTER_PORTRAIT_SIZES = new Set([32, 64, 128, 256, 512, 1024]);
const CHARACTER_PORTRAIT_TYPES = new Set(["image/jpeg", "image/png"]);
const SHIP_RENDER_CACHE_MS = 6 * 60 * 60 * 1000;
const MIN_DASHBOARD_API_TIMEOUT_MS = 10_000;
const MAX_DASHBOARD_API_TIMEOUT_MS = 30_000;
const DEFAULT_READ_CACHE_MS = 2_000;
// Tells EveJS when the dashboard stops waiting for a read (epoch milliseconds).
const DEADLINE_HEADER = "x-playerbots-deadline";

function positiveInteger(value, fallback, maximum) {
  const parsed = Math.trunc(Number(value));
  return Number.isSafeInteger(parsed) ? Math.max(0, Math.min(maximum, parsed)) : fallback;
}

function defaultLocalPortraitFinder() {
  let store;
  try {
    store = require("../src/services/character/portraitImageStore");
  } catch (_) {
    return () => null;
  }
  return (id, size) => store.findCharacterPortraitPath(id, size);
}

function createDashboardServer(options = {}) {
  const host = String(options.host || process.env.EVEJS_PLAYER_BOTS_DASHBOARD_HOST || "0.0.0.0").trim();
  const portValue = Number(options.port ?? process.env.EVEJS_PLAYER_BOTS_DASHBOARD_CONTAINER_PORT ?? 8080);
  const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65_535 ? portValue : 8080;
  const apiURL = String(options.apiURL || process.env.EVEJS_PLAYER_BOTS_ADDON_URL || "http://127.0.0.1:26004").replace(/\/+$/, "");
  const imageServerURL = String(options.imageServerURL || process.env.EVEJS_PLAYER_BOTS_IMAGE_SERVER_URL || process.env.EVEJS_IMAGE_SERVER_URL || "http://127.0.0.1:26001/").replace(/\/+$/, "");
  const token = String(options.token ?? process.env.EVEJS_PLAYER_BOTS_ADDON_TOKEN ?? "");
  const fetchImpl = options.fetch || fetch;
  const timeoutSignal = options.timeoutSignal || AbortSignal.timeout;
  // The Windows build runs inside the EveJS server tree and can read saved
  // portraits directly; the Docker add-on cannot and always proxies.
  const findLocalPortrait = options.findLocalPortrait || defaultLocalPortraitFinder();
  const staticRoot = options.staticRoot || STATIC_ROOT;
  const logger = options.logger || { info() {}, warn() {} };
  const shipRenderCache = new Map();
  const readCacheMs = positiveInteger(options.readCacheMs ?? process.env.EVEJS_PLAYER_BOTS_DASHBOARD_CACHE_MS, DEFAULT_READ_CACHE_MS, 30_000);
  let server = null;

  function proxyTimeoutMs() {
    let configured = MAX_DASHBOARD_API_TIMEOUT_MS;
    try {
      configured = Number(typeof options.getProxyTimeoutMs === "function"
        ? options.getProxyTimeoutMs()
        : options.proxyTimeoutMs ?? process.env.EVEJS_PLAYER_BOTS_DASHBOARD_API_TIMEOUT_MS);
    } catch {
      configured = MAX_DASHBOARD_API_TIMEOUT_MS;
    }
    if (!Number.isFinite(configured) || configured <= 0) configured = MAX_DASHBOARD_API_TIMEOUT_MS;
    return Math.max(MIN_DASHBOARD_API_TIMEOUT_MS,
      Math.min(MAX_DASHBOARD_API_TIMEOUT_MS, Math.trunc(configured)));
  }

  function send(response, statusCode, contentType, payload, extraHeaders = {}) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    response.writeHead(statusCode, {
      "cache-control": "no-store",
      "content-length": body.length,
      "content-type": contentType,
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...extraHeaders,
    });
    response.end(body);
  }

  // Every open page polls on a timer, and each view asks for the summary and
  // its own data. Identical reads that arrive together share one request to
  // EveJS, and a successful answer is reused for a moment, so two tabs or a
  // page and the watch panel do not multiply the work the game server does.
  const readCache = new Map();
  let readGeneration = 0;

  function invalidateReads() {
    readGeneration += 1;
    readCache.clear();
  }

  function fetchRead(target) {
    const now = Date.now();
    const cached = readCache.get(target);
    if (cached && (cached.pending || now - cached.at < readCacheMs)) return cached.pending || Promise.resolve(cached.result);
    const generation = readGeneration;
    const startedAtMs = now;
    const timeoutMs = proxyTimeoutMs();
    const entry = { at: now, result: null, pending: null };
    entry.pending = (async () => {
      try {
        const upstream = await fetchImpl(`${apiURL}${target}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            // EveJS skips the work for a read nobody is still waiting for.
            [DEADLINE_HEADER]: String(startedAtMs + timeoutMs),
          },
          signal: timeoutSignal(timeoutMs),
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.length > MAX_PROXY_BYTES) {
          return { status: 502, body: Buffer.from(JSON.stringify({ error: "Dashboard response exceeded its size limit." })) };
        }
        return { status: upstream.status, body };
      } catch (error) {
        logger.warn(`[PlayerBotsDashboard] Private API request failed after ${Date.now() - startedAtMs}ms (timeout=${timeoutMs}ms): ${String(error && error.message || error).slice(0, 180)}`);
        return { status: 503, body: Buffer.from(JSON.stringify({ error: "PLAYERBOTS_DASHBOARD_BUSY" })) };
      }
    })().then((result) => {
      entry.pending = null;
      entry.at = Date.now();
      entry.result = result;
      // Only successful answers are reused; a failure is retried at once.
      if (result.status !== 200 || generation !== readGeneration || readCacheMs <= 0) {
        if (readCache.get(target) === entry) readCache.delete(target);
      }
      return result;
    });
    readCache.set(target, entry);
    if (readCache.size > 256) readCache.delete(readCache.keys().next().value);
    return entry.pending;
  }

  async function proxyApi(response, pathname, query = "") {
    const result = await fetchRead(`${pathname}${query}`);
    send(response, result.status, "application/json; charset=utf-8", result.body);
  }

  async function proxyMutation(response, pathname, method, body) {
    const startedAtMs = Date.now();
    const timeoutMs = proxyTimeoutMs();
    try {
      const upstream = await fetchImpl(`${apiURL}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: timeoutSignal(timeoutMs),
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      // An order changes what the next read should show.
      invalidateReads();
      if (payload.length > MAX_PROXY_BYTES) {
        send(response, 502, "application/json; charset=utf-8", JSON.stringify({ error: "Dashboard response exceeded its size limit." }));
        return;
      }
      send(response, upstream.status, "application/json; charset=utf-8", payload);
    } catch (error) {
      logger.warn(`[PlayerBotsDashboard] Private API update failed after ${Date.now() - startedAtMs}ms (timeout=${timeoutMs}ms): ${String(error && error.message || error).slice(0, 180)}`);
      send(response, 503, "application/json; charset=utf-8", JSON.stringify({ error: "EveJS dashboard update is temporarily unavailable." }));
    }
  }

  async function proxyCorporationLogo(response, request, url) {
    const rawCorporationID = Number(url.searchParams.get("corporationID"));
    const rawSize = Number(url.searchParams.get("size") || 64);
    const corporationID = Math.trunc(rawCorporationID);
    const size = Math.trunc(rawSize);
    if (!Number.isSafeInteger(rawCorporationID) || corporationID <= 0 || corporationID > 10_000_000_000 ||
        !Number.isSafeInteger(rawSize) || !CORPORATION_LOGO_SIZES.has(size)) {
      send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "A valid corporation and logo size are required." }));
      return;
    }
    try {
      const query = new URLSearchParams({ corporationID: String(corporationID), size: String(size) });
      const upstream = await fetchImpl(`${apiURL}/v1/dashboard/corporation-logo?${query}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "image/png" },
        signal: timeoutSignal(proxyTimeoutMs()),
      });
      const contentType = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!upstream.ok || contentType !== "image/png") {
        send(response, upstream.status === 404 ? 404 : 502, "application/json; charset=utf-8", "");
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (!body.length || body.length > MAX_CORPORATION_LOGO_BYTES) {
        send(response, 502, "application/json; charset=utf-8", "");
        return;
      }
      // The page asks with ?v=<file time>, so a new upload gets a new URL.
      send(response, 200, "image/png", request.method === "HEAD" ? Buffer.alloc(0) : body, {
        "cache-control": "private, max-age=86400",
        "content-length": body.length,
      });
    } catch (error) {
      logger.warn(`[PlayerBotsDashboard] Corporation logo request failed for ${corporationID}: ${String(error && error.message || error).slice(0, 180)}`);
      send(response, 503, "application/json; charset=utf-8", "");
    }
  }

  async function proxyShipRender(response, request, url) {
    const rawTypeID = Number(url.searchParams.get("typeID"));
    const rawSize = Number(url.searchParams.get("size") || 64);
    const typeID = Math.trunc(rawTypeID);
    const size = Math.trunc(rawSize);
    if (!Number.isSafeInteger(rawTypeID) || typeID <= 0 || typeID > 10_000_000 ||
        !Number.isSafeInteger(rawSize) || !SHIP_RENDER_SIZES.has(size)) {
      send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "A valid ship type and render size are required." }));
      return;
    }
    const cacheKey = `${typeID}:${size}`;
    const cached = shipRenderCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      send(response, 200, cached.contentType, request.method === "HEAD" ? Buffer.alloc(0) : cached.body, {
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      });
      return;
    }
    try {
      const upstream = await fetchImpl(`https://images.evetech.net/types/${typeID}/render?size=${size}`, {
        method: "GET",
        headers: { accept: "image/jpeg, image/png" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!upstream.ok) {
        send(response, upstream.status === 404 ? 404 : 502, "image/svg+xml; charset=utf-8", "");
        return;
      }
      const contentType = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!new Set(["image/jpeg", "image/png"]).has(contentType)) {
        send(response, 502, "image/svg+xml; charset=utf-8", "");
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (!body.length || body.length > MAX_SHIP_RENDER_BYTES) {
        send(response, 502, "image/svg+xml; charset=utf-8", "");
        return;
      }
      if (shipRenderCache.size >= 256) shipRenderCache.delete(shipRenderCache.keys().next().value);
      shipRenderCache.set(cacheKey, { body, contentType, expiresAt: Date.now() + SHIP_RENDER_CACHE_MS });
      send(response, 200, contentType, request.method === "HEAD" ? Buffer.alloc(0) : body, {
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      });
    } catch (error) {
      logger.warn(`[PlayerBotsDashboard] Official ship render request failed: ${String(error && error.message || error).slice(0, 180)}`);
      send(response, 503, "image/svg+xml; charset=utf-8", "", { "cache-control": "no-store" });
    }
  }

  async function proxyCharacterPortrait(response, request, url) {
    const rawCharacterID = Number(url.searchParams.get("characterID"));
    const rawSize = Number(url.searchParams.get("size") || 64);
    const characterID = Math.trunc(rawCharacterID);
    const size = Math.trunc(rawSize);
    const extension = String(url.searchParams.get("ext") || "jpg").toLowerCase();
    if (!Number.isSafeInteger(rawCharacterID) || characterID <= 0 || characterID > 10_000_000_000 ||
        !Number.isSafeInteger(rawSize) || !CHARACTER_PORTRAIT_SIZES.has(size) ||
        (extension !== "jpg" && extension !== "png")) {
      send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "A valid character and portrait size are required." }));
      return;
    }
    const head = request.method === "HEAD";
    try {
      const localPath = findLocalPortrait(characterID, size);
      if (localPath) {
        const stat = await fs.promises.stat(localPath);
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_CHARACTER_PORTRAIT_BYTES) {
          const body = head ? Buffer.alloc(0) : await fs.promises.readFile(localPath);
          const type = path.extname(localPath) === ".png" ? "image/png" : "image/jpeg";
          send(response, 200, type, body, {
            "cache-control": "public, max-age=300",
            "content-length": head ? stat.size : body.length,
          });
          return;
        }
      }
    } catch (_) {
      // Runtime images may be migrating or served by another image edge.
    }
    try {
      const upstream = await fetchImpl(`${imageServerURL}/Character/${characterID}_${size}.${extension}`, {
        method: request.method,
        headers: { accept: "image/jpeg, image/png" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!upstream.ok) {
        send(response, upstream.status === 404 ? 404 : 502, "application/json; charset=utf-8", "");
        return;
      }
      const contentType = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!CHARACTER_PORTRAIT_TYPES.has(contentType)) {
        send(response, 502, "application/json; charset=utf-8", "");
        return;
      }
      const body = head ? Buffer.alloc(0) : Buffer.from(await upstream.arrayBuffer());
      const length = head ? Number(upstream.headers.get("content-length")) : body.length;
      if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_CHARACTER_PORTRAIT_BYTES) {
        send(response, 502, "application/json; charset=utf-8", "");
        return;
      }
      send(response, 200, contentType, body, {
        "cache-control": "public, max-age=300",
        "content-length": length,
      });
    } catch (error) {
      logger.warn(`[PlayerBotsDashboard] Character portrait request failed for ${characterID}: ${String(error && error.message || error).slice(0, 180)}`);
      send(response, 503, "application/json; charset=utf-8", "");
    }
  }

  async function readJsonBody(request, maxBytes = MAX_REQUEST_BYTES) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
      const error = new Error("Settings must be submitted as JSON.");
      error.statusCode = 415;
      throw error;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("Request body exceeds the dashboard size limit.");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      const error = new Error("Request body must be valid JSON.");
      error.statusCode = 400;
      throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const error = new Error("Request body must be a JSON object.");
      error.statusCode = 400;
      throw error;
    }
    return value;
  }

  function isSameOriginRequest(request) {
    const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
    const origin = String(request.headers.origin || "");
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.host.toLowerCase() === String(request.headers.host || "").toLowerCase();
    } catch {
      return false;
    }
  }

  async function route(request, response) {
    // Bound to loopback, only loopback host names are accepted, so a web page
    // cannot reach the dashboard through a rebound DNS name.
    if (host === "127.0.0.1") {
      const port = server.address().port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(request.headers.host || "").toLowerCase())) {
        send(response, 403, "text/plain; charset=utf-8", `Open the dashboard at http://127.0.0.1:${port}/.`);
        return;
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, HEAD, POST" });
      return;
    }
    const url = new URL(request.url || "/", "http://playerbots-dashboard.local");
    if (url.pathname === "/api/ship-render") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, HEAD" });
        return;
      }
      return proxyShipRender(response, request, url);
    }
    if (url.pathname === "/api/character-portrait") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, HEAD" });
        return;
      }
      return proxyCharacterPortrait(response, request, url);
    }
    if (url.pathname === "/api/corporation-logos") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/corporation-logos");
    }
    if (url.pathname === "/api/corporation-logo") {
      if (request.method === "GET" || request.method === "HEAD") return proxyCorporationLogo(response, request, url);
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard updates are blocked." }));
        return;
      }
      const body = await readJsonBody(request, MAX_LOGO_REQUEST_BYTES);
      const images = body.images && typeof body.images === "object" && !Array.isArray(body.images) ? body.images : null;
      return proxyMutation(response, "/v1/dashboard/corporation-logo", "POST", body.remove === true
        ? { corporationID: body.corporationID, remove: true }
        : { corporationID: body.corporationID, images });
    }
    if (url.pathname === "/api/summary") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/summary");
    }
    if (url.pathname === "/api/kills") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/kills");
    }
    if (url.pathname === "/api/corporation-priorities") {
      if (request.method !== "POST") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "POST" });
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard updates are blocked." }));
        return;
      }
      return proxyMutation(response, "/v1/dashboard/corporation-priorities", "POST", await readJsonBody(request));
    }
    if (url.pathname === "/api/operations") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      const offset = positiveInteger(url.searchParams.get("offset"), 0, 10_000_000);
      const limit = positiveInteger(url.searchParams.get("limit"), 50, 100) || 50;
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      for (const key of ["status", "kind", "search"]) {
        const value = String(url.searchParams.get(key) || "").trim().slice(0, 80);
        if (value) query.set(key, value);
      }
      return proxyApi(response, "/v1/dashboard/operations", `?${query}`);
    }
    if (url.pathname === "/api/operation" && request.method === "GET") {
      const operationID = String(url.searchParams.get("operationID") || "").trim().slice(0, 100);
      if (!/^(?:OP|IC)[0-9]+-[0-9]+(?:-[a-z0-9-]+)?$/i.test(operationID)) {
        send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "A valid operation ID is required." }));
        return;
      }
      const query = new URLSearchParams({ operationID });
      return proxyApi(response, "/v1/dashboard/operation", `?${query}`);
    }
    if (url.pathname === "/api/name-library") {
      if (request.method === "GET") return proxyApi(response, "/v1/dashboard/name-library");
      if (request.method !== "POST") {
        send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "Method not allowed." }));
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard updates are blocked." }));
        return;
      }
      return proxyMutation(response, "/v1/dashboard/name-library", "POST", await readJsonBody(request));
    }
    if (url.pathname === "/api/settings") {
      if (request.method === "GET") return proxyApi(response, "/v1/dashboard/settings");
      if (request.method !== "POST") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, POST" });
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard updates are blocked." }));
        return;
      }
      const body = await readJsonBody(request);
      return proxyMutation(response, "/v1/dashboard/settings", "PATCH", body);
    }
    if (url.pathname === "/api/roster-reset") {
      if (request.method === "GET") return proxyApi(response, "/v1/dashboard/roster-reset");
      if (request.method !== "POST") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, POST" });
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard updates are blocked." }));
        return;
      }
      const body = await readJsonBody(request);
      return proxyMutation(response, "/v1/dashboard/roster-reset", "POST", body);
    }
    if (url.pathname === "/api/seed-status") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/seed-status");
    }
    if (url.pathname === "/api/telemetry") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/telemetry");
    }
    if (url.pathname === "/api/bots") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      const offset = positiveInteger(url.searchParams.get("offset"), 0, 10_000_000);
      const limit = positiveInteger(url.searchParams.get("limit"), 50, 100) || 50;
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      for (const key of ["specialty", "corporationID", "search", "state", "activity", "reason", "sort"]) {
        const value = String(url.searchParams.get(key) || "").trim().slice(0, 80);
        if (value) query.set(key, value);
      }
      return proxyApi(response, "/v1/dashboard/bots", `?${query}`);
    }
    if (url.pathname === "/api/activity") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/activity");
    }
    if (url.pathname === "/api/bot" || url.pathname === "/api/corporation") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      const key = url.pathname === "/api/bot" ? "characterID" : "corporationID";
      const id = positiveInteger(url.searchParams.get(key), 0, 9_000_000_000);
      if (!id) {
        send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: `A valid ${key} is required.` }));
        return;
      }
      return proxyApi(response, `/v1/dashboard/${url.pathname.slice(5)}`, `?${new URLSearchParams({ [key]: String(id) })}`);
    }
    if (url.pathname === "/api/fleets") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/fleets");
    }
    if (url.pathname === "/api/fleet-command") {
      if (request.method !== "POST") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "POST" });
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard commands are blocked." }));
        return;
      }
      const body = await readJsonBody(request);
      return proxyMutation(response, "/v1/dashboard/fleet-command", "POST", {
        commanderID: body.commanderID,
        action: body.action,
        args: body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {},
      });
    }
    if (url.pathname === "/api/alliances") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/alliances");
    }
    if (url.pathname === "/api/alliance-command") {
      if (request.method !== "POST") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "POST" });
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard commands are blocked." }));
        return;
      }
      const body = await readJsonBody(request, MAX_LOGO_REQUEST_BYTES);
      return proxyMutation(response, "/v1/dashboard/alliance-command", "POST", {
        action: String(body.action || "").slice(0, 12),
        id: String(body.id || "").slice(0, 64),
        name: String(body.name || "").slice(0, 50),
        ticker: String(body.ticker || "").slice(0, 5),
        description: String(body.description || "").slice(0, 1000),
        founderCorporationID: Number(body.founderCorporationID) || 0,
        memberCorporationIDs: Array.isArray(body.memberCorporationIDs) ? body.memberCorporationIDs.slice(0, 10).map(Number) : [],
        logo: typeof body.logo === "string" ? body.logo.slice(0, 600_000) : "",
      });
    }
    if (url.pathname === "/api/reputation") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/reputation");
    }
    if (url.pathname === "/api/reputation-command") {
      if (request.method !== "POST") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "POST" });
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard commands are blocked." }));
        return;
      }
      const body = await readJsonBody(request);
      return proxyMutation(response, "/v1/dashboard/reputation-command", "POST", {
        corporationID: Number(body.corporationID) || 0,
        targetCorporationID: Number(body.targetCorporationID) || 0,
        action: String(body.action || "").slice(0, 12),
      });
    }
    if (url.pathname === "/api/corp-command" || url.pathname === "/api/bot-command") {
      if (request.method !== "POST") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "POST" });
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard commands are blocked." }));
        return;
      }
      return proxyMutation(response, `/v1/dashboard/${url.pathname.slice(5)}`, "POST", await readJsonBody(request));
    }

    // Static files: index.html, styles, the favicon and the ES modules under
    // js/. Names are restricted so no request can leave the dashboard folder.
    const contentTypes = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml" };
    const assetMatch = url.pathname === "/" ? ["/index.html", "index.html", "html"] : url.pathname.match(/^\/((?:js\/)?[a-z0-9][a-z0-9-]*\.(html|js|css|svg))$/);
    const asset = assetMatch ? [assetMatch[1], contentTypes[assetMatch[2]]] : null;
    if (!asset) {
      send(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }
    let body;
    try {
      body = fs.readFileSync(path.join(staticRoot, asset[0]));
    } catch (error) {
      if (error && error.code === "ENOENT" && asset[0] !== "index.html") {
        send(response, 404, "text/plain; charset=utf-8", "Not found.");
        return;
      }
      send(response, 503, "text/plain; charset=utf-8", "Dashboard assets are missing from this add-on package.");
      return;
    }
    send(response, 200, asset[1], request.method === "HEAD" ? Buffer.alloc(0) : body);
  }

  return Object.freeze({
    async start() {
      if (server && server.listening) return this.getDiagnostics();
      server = http.createServer((request, response) => {
        void route(request, response).catch((error) => {
          logger.warn(`[PlayerBotsDashboard] Request failed: ${String(error && error.message || error).slice(0, 180)}`);
          if (!response.headersSent) {
            send(response, Number(error && error.statusCode) || 500, "application/json; charset=utf-8", JSON.stringify({ error: String(error && error.message || "Dashboard request failed.") }));
          }
          else response.destroy();
        });
      });
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 5_000;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      logger.info(`[PlayerBotsDashboard] Dashboard listening on ${host}:${server.address().port}`);
      return this.getDiagnostics();
    },
    async shutdown() {
      if (!server || !server.listening) return;
      const current = server;
      server = null;
      await new Promise((resolve) => current.close(() => resolve()));
    },
    getDiagnostics() {
      return { listening: Boolean(server && server.listening), host, port: server && server.address() && server.address().port || null };
    },
  });
}

module.exports = { createDashboardServer };
