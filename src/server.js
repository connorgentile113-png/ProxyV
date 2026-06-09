"use strict";

const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const ngrok = require("@ngrok/ngrok");
const addStaticDirToProxy = require("rammerhead/src/util/addStaticDirToProxy");
const RammerheadLogging = require("rammerhead/src/classes/RammerheadLogging");
const RammerheadProxy = require("rammerhead/src/classes/RammerheadProxy");
const RammerheadSessionFileCache = require("rammerhead/src/classes/RammerheadSessionFileCache");
const setupPipeline = require("rammerhead/src/server/setupPipeline");
const setupRoutes = require("rammerhead/src/server/setupRoutes");

const root = join(__dirname, "..");
const publicDir = join(root, "public");
const sessionDir = join(root, "sessions");
const port = Number.parseInt(process.env.PORT || "8080", 10);
const host = process.env.HOST || "0.0.0.0";

mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(root, "node_modules", "rammerhead", "cache-js"), { recursive: true });

const rammerheadConfig = require("rammerhead/src/config");

rammerheadConfig.password = null;
rammerheadConfig.restrictSessionToIP = false;
rammerheadConfig.getIP = getRequestIp;
rammerheadConfig.getServerInfo = getServerInfoForRequest;

const logger = new RammerheadLogging({
  logLevel: process.env.PROXYV_LOG_LEVEL || "info",
  generatePrefix: (level) => `[${new Date().toISOString()}] [${level.toUpperCase()}] `
});

const proxyServer = new RammerheadProxy({
  logger,
  loggerGetIP: getRequestIp,
  bindingAddress: host,
  port,
  crossDomainPort: null,
  dontListen: false,
  ssl: null,
  getServerInfo: getServerInfoForRequest,
  disableLocalStorageSync: false,
  jsCache: undefined,
  disableHttp2: false
});

Object.assign(proxyServer.rewriteServerHeaders, {
  "content-security-policy": null,
  "content-security-policy-report-only": null,
  "cross-origin-embedder-policy": null,
  "cross-origin-opener-policy": null,
  "cross-origin-resource-policy": null,
  "origin-agent-cluster": null,
  "x-frame-options": null
});

addStaticDirToProxy(proxyServer, publicDir);

const sessionStore = new RammerheadSessionFileCache({
  logger,
  saveDirectory: sessionDir,
  cacheTimeout: 1000 * 60 * 20,
  cacheCheckInterval: 1000 * 60 * 10,
  deleteUnused: true,
  deleteCorruptedSessions: true,
  staleCleanupOptions: {
    staleTimeout: 1000 * 60 * 60 * 24 * 3,
    maxToLive: null,
    staleCheckInterval: 1000 * 60 * 60 * 6
  }
});

sessionStore.attachToProxy(proxyServer);
setupPipeline(proxyServer, sessionStore);
setupRoutes(proxyServer, sessionStore, logger);

proxyServer.GET("/api/status", (req, res) => {
  sendJson(res, {
    mode: ngrokUrl ? "ngrok tunnel online" : `ngrok ${ngrokState}`,
    ngrokUrl,
    ngrokError,
    ngrokAttempts,
    publicUrl: getRequestOrigin(req)
  });
});

let ngrokListener = null;
let ngrokUrl = "";
let ngrokState = "not started";
let ngrokError = "";
let ngrokAttempts = 0;

const onListening = () => {
  console.log(`ProxyV is listening on ${host}:${port}`);
  startNgrok().catch((error) => {
    console.error(`ngrok start failed: ${error.message}`);
  });
};

if (proxyServer.server1.listening) {
  onListening();
} else {
  proxyServer.server1.once("listening", onListening);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function startNgrok() {
  if (!process.env.NGROK_AUTHTOKEN) {
    ngrokState = "disabled";
    ngrokError = "NGROK_AUTHTOKEN is not set.";
    console.warn("NGROK_AUTHTOKEN is not set; no ngrok URL will be generated.");
    return;
  }

  ngrokAttempts += 1;
  ngrokState = "starting";
  ngrokError = "";
  const addr = `localhost:${port}`;
  console.log(`Starting ngrok tunnel to ${addr} (attempt ${ngrokAttempts}).`);

  try {
    const options = {
      addr,
      authtoken_from_env: true,
      proto: "http",
      schemes: ["HTTPS"]
    };

    if (process.env.NGROK_DOMAIN) options.domain = process.env.NGROK_DOMAIN;

    ngrokListener = await withTimeout(
      ngrok.forward(options),
      Number.parseInt(process.env.NGROK_START_TIMEOUT_MS || "30000", 10),
      "ngrok startup timed out"
    );
    ngrokUrl = ngrokListener.url();
    ngrokState = "online";
    console.log(`ngrok URL: ${ngrokUrl}`);
  } catch (error) {
    ngrokState = "failed";
    ngrokError = error && error.message ? error.message : String(error);
    console.error(`ngrok failed to start: ${ngrokError}`);

    const retryDelay = Number.parseInt(process.env.NGROK_RETRY_DELAY_MS || "15000", 10);
    setTimeout(() => {
      void startNgrok();
    }, retryDelay).unref();
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function sendJson(response, data) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(data));
}

function getRequestOrigin(request) {
  const proto = request.headers["x-forwarded-proto"] || "http";
  const hostHeader = request.headers["x-forwarded-host"] || request.headers.host;
  return hostHeader ? `${proto}://${hostHeader}` : "";
}

function getRequestIp(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (forwardedFor) return String(forwardedFor).split(",")[0].trim();
  return request.socket.remoteAddress || "";
}

function getServerInfoForRequest(request) {
  const origin = getRequestOrigin(request) || `http://${request.headers.host || `localhost:${port}`}`;
  const parsed = new URL(origin);
  const currentPort = Number(parsed.port || (parsed.protocol === "https:" ? "443" : "80"));

  return {
    hostname: parsed.hostname,
    port: currentPort || port,
    crossDomainPort: currentPort || port,
    protocol: parsed.protocol
  };
}

async function shutdown() {
  try {
    if (ngrokListener) await ngrokListener.close();
  } catch (error) {
    console.error(`ngrok shutdown error: ${error.message}`);
  }

  try {
    proxyServer.close();
  } catch (error) {
    console.error(`proxy shutdown error: ${error.message}`);
  }

  process.exit(0);
}
