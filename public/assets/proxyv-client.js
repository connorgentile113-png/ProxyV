"use strict";

const form = document.getElementById("proxyForm");
const addressInput = document.getElementById("addressInput");
const connectionLabel = document.getElementById("connectionLabel");
const emptyState = document.getElementById("emptyState");
const homeButton = document.getElementById("homeButton");
const reloadButton = document.getElementById("reloadButton");
const detachButton = document.getElementById("detachButton");
const ngrokUrl = document.getElementById("ngrokUrl");
const debugButton = document.getElementById("debugButton");
const debugDialog = document.getElementById("debugDialog");
const debugLog = document.getElementById("debugLog");
const copyDebugButton = document.getElementById("copyDebugButton");
const closeDebugButton = document.getElementById("closeDebugButton");
const proxyFrame = document.getElementById("proxyFrame");

const searchTemplate = "https://www.google.com/search?q=%s";
const sessionStorageKey = "proxyv-rammerhead-session";

let currentUrl = "";
let sessionId = "";
let sessionReady = null;
let frameSyncTimer = null;
const debugEntries = [];

installDebugConsole();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void navigate(addressInput.value);
});

homeButton.addEventListener("click", () => {
  currentUrl = "";
  addressInput.value = "";
  emptyState.hidden = false;
  proxyFrame.hidden = true;
  proxyFrame.src = "about:blank";
  connectionLabel.textContent = "Proxy ready";
  addressInput.focus();
});

reloadButton.addEventListener("click", () => {
  if (proxyFrame.contentWindow && proxyFrame.src && proxyFrame.src !== "about:blank") {
    proxyFrame.contentWindow.location.reload();
    return;
  }

  if (currentUrl) {
    void loadFrame(currentUrl);
  }
});

detachButton.addEventListener("click", () => {
  if (!currentUrl) return;

  window.open(buildPublicProxyUrl(currentUrl), "_blank", "noopener,noreferrer");
});

void refreshStatus();

async function navigate(input) {
  const url = normalizeAddress(input);
  if (!url) return;

  currentUrl = url;
  addressInput.value = url;
  emptyState.hidden = true;
  connectionLabel.textContent = new URL(url).hostname;
  addDebugEntry("info", `navigating to ${url}`);
  await loadFrame(url);
}

async function loadFrame(url) {
  const id = await ensureSession();
  proxyFrame.hidden = false;
  emptyState.hidden = true;
  proxyFrame.src = "about:blank";
  requestAnimationFrame(() => {
    proxyFrame.src = buildSessionUrl(url, id);
  });
}

function normalizeAddress(input) {
  const value = input.trim();
  if (!value) return "";

  try {
    return new URL(value).toString();
  } catch {
    try {
      const withScheme = new URL(`https://${value}`);
      if (withScheme.hostname.includes(".")) return withScheme.toString();
    } catch {
      return searchTemplate.replace("%s", encodeURIComponent(value));
    }
  }

  return searchTemplate.replace("%s", encodeURIComponent(value));
}

function buildSessionUrl(url, id = sessionId) {
  return `/${id}/${url}`;
}

function buildPublicProxyUrl(url) {
  return `/pv/${encodeURIComponent(url)}`;
}

async function ensureSession() {
  if (sessionReady) return sessionReady;

  sessionReady = (async () => {
    const savedSessionId = localStorage.getItem(sessionStorageKey);
    if (savedSessionId && (await sessionExists(savedSessionId))) {
      sessionId = savedSessionId;
      return sessionId;
    }

    const createdSessionId = await createSession();
    sessionId = createdSessionId;
    localStorage.setItem(sessionStorageKey, sessionId);
    return sessionId;
  })().catch((error) => {
    sessionReady = null;
    const message = error && error.message ? error.message : "Rammerhead unavailable";
    addDebugEntry("error", message);
    connectionLabel.textContent = message;
    throw error;
  });

  return sessionReady;
}

async function createSession() {
  const response = await fetch("/newsession", { method: "GET" });
  const text = (await response.text()).trim();

  if (!response.ok || !text) {
    throw new Error(text || "Failed to create Rammerhead session.");
  }

  return text;
}

async function sessionExists(id) {
  const response = await fetch(`/sessionexists?id=${encodeURIComponent(id)}`, { method: "GET" });
  const text = (await response.text()).trim();
  return response.ok && text === "exists";
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();

    if (!currentUrl) {
      connectionLabel.textContent = status.mode || "Proxy ready";
    }

    if (status.ngrokUrl) {
      ngrokUrl.textContent = status.ngrokUrl;
      ngrokUrl.href = status.ngrokUrl;
    } else {
      ngrokUrl.textContent = "Starting...";
      ngrokUrl.removeAttribute("href");
    }
  } catch {
    if (!currentUrl) connectionLabel.textContent = "Status unavailable";
    ngrokUrl.textContent = "Unavailable";
    ngrokUrl.removeAttribute("href");
  }
}

proxyFrame.addEventListener("load", () => syncFrameUrl(), true);
if (!frameSyncTimer) frameSyncTimer = setInterval(syncFrameUrl, 1000);
setInterval(refreshStatus, 5000);

function syncFrameUrl() {
  const url = getCurrentFrameUrl();
  if (!url) return;

  currentUrl = url;
  addressInput.value = url;
  connectionLabel.textContent = new URL(url).hostname;
  addDebugEntry("info", `frame url changed to ${url}`);
}

function getCurrentFrameUrl() {
  try {
    const href = proxyFrame.contentWindow ? proxyFrame.contentWindow.location.href : "";
    if (!href || href === "about:blank") return "";

    const parsed = new URL(href);
    const match = parsed.pathname.match(/^\/([a-z0-9]{32})(\/.*)$/i);
    if (!match) return "";

    const candidate = `${match[2]}${parsed.search}${parsed.hash}`;
    try {
      return new URL(candidate).toString();
    } catch {
      return candidate;
    }
  } catch {
    return "";
  }
}

function installDebugConsole() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      addDebugEntry(level, args.map(formatDebugValue).join(" "));
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    addDebugEntry("error", `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    addDebugEntry("error", `Unhandled rejection: ${formatDebugValue(event.reason)}`);
  });

  debugButton.addEventListener("click", () => {
    renderDebugLog();
    debugDialog.showModal();
  });

  closeDebugButton.addEventListener("click", () => debugDialog.close());

  copyDebugButton.addEventListener("click", async () => {
    renderDebugLog();
    await navigator.clipboard.writeText(debugLog.textContent || "");
  });

  addDebugEntry("info", `ProxyV loaded at ${location.href}`);
}

function addDebugEntry(level, message) {
  debugEntries.push({
    time: new Date().toISOString(),
    level,
    message
  });

  if (debugEntries.length > 300) debugEntries.shift();
  if (debugDialog.open) renderDebugLog();
}

function renderDebugLog() {
  debugLog.textContent = debugEntries
    .map((entry) => `[${entry.time}] ${entry.level.toUpperCase()} ${entry.message}`)
    .join("\n");
}

function formatDebugValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
