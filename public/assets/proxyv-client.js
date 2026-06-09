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
let currentUrl = "";
let scramjet = null;
let scramjetFrame = null;
let scramjetReady = null;
let frameSyncTimer = null;
const debugEntries = [];

installDebugConsole();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(addressInput.value);
});

homeButton.addEventListener("click", () => {
  currentUrl = "";
  addressInput.value = "";
  emptyState.hidden = false;
  proxyFrame.hidden = true;
  proxyFrame.src = "about:blank";
  addressInput.focus();
  void refreshStatus();
});

reloadButton.addEventListener("click", () => {
  if (scramjetFrame) scramjetFrame.reload();
  else if (currentUrl) loadFrame(currentUrl);
});

detachButton.addEventListener("click", () => {
  if (currentUrl && scramjet) window.open(scramjet.encodeUrl(currentUrl), "_blank", "noopener,noreferrer");
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
  const frame = await ensureScramjet();
  proxyFrame.hidden = false;
  emptyState.hidden = true;
  proxyFrame.src = "about:blank";

  requestAnimationFrame(() => {
    frame.go(url);
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

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    connectionLabel.textContent = status.mode || "Proxy ready";
    if (status.ngrokUrl) {
      ngrokUrl.textContent = status.ngrokUrl;
      ngrokUrl.href = status.ngrokUrl;
    } else {
      ngrokUrl.textContent = "Starting...";
      ngrokUrl.removeAttribute("href");
    }
  } catch {
    connectionLabel.textContent = "Status unavailable";
    ngrokUrl.textContent = "Unavailable";
    ngrokUrl.removeAttribute("href");
  }
}

function ensureScramjet() {
  if (scramjetReady) return scramjetReady;

  scramjetReady = (async () => {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service workers are required for Scramjet.");
    }

    if (!window.BareMux || !window.$scramjetLoadController) {
      throw new Error("Scramjet assets did not load.");
    }

    const { ScramjetController } = $scramjetLoadController();
    scramjet = new ScramjetController({
      prefix: "/scramjet/",
      files: {
        wasm: "/scramjet/scramjet.wasm.wasm",
        all: "/scramjet/scramjet.all.js",
        sync: "/scramjet/scramjet.sync.js"
      }
    });

    await activateScramjetWorker();
    await initializeScramjet();

    if (!navigator.serviceWorker.controller) {
      throw new Error("Scramjet service worker did not take control.");
    }

    await navigator.serviceWorker.ready;

    const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
    await connection.setTransport("/baremod/index.mjs", [`${location.origin}/bare/`]);

    scramjetFrame = scramjet.createFrame(proxyFrame);
    scramjetFrame.addEventListener("urlchange", syncFrameUrl);
    scramjetFrame.addEventListener("navigate", syncFrameUrl);
    proxyFrame.addEventListener("load", () => syncFrameUrl(), true);
    if (!frameSyncTimer) frameSyncTimer = setInterval(syncFrameUrl, 750);

    return scramjetFrame;
  })().catch((error) => {
    scramjetReady = null;
    const message = error && error.message ? error.message : "Scramjet unavailable";
    addDebugEntry("error", message);
    connectionLabel.textContent = message;
    throw error;
  });

  return scramjetReady;
}

async function initializeScramjet() {
  try {
    await scramjet.init();
  } catch (error) {
    if (!isMissingScramjetStoreError(error)) throw error;

    addDebugEntry("warn", "Resetting stale Scramjet IndexedDB state.");
    await deleteScramjetDatabase();
    await scramjet.init();
  }
}

async function activateScramjetWorker() {
  if (navigator.serviceWorker.controller) return;

  const controllerReady = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      reject(new Error("Timed out waiting for Scramjet service worker control."));
    }, 10000);

    function onControllerChange() {
      window.clearTimeout(timeout);
      resolve();
    }

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange, { once: true });
  });

  await navigator.serviceWorker.register("/scramjet-sw.js", { scope: "/" });
  await Promise.race([navigator.serviceWorker.ready, controllerReady]);

  if (!navigator.serviceWorker.controller) {
    throw new Error("Scramjet service worker registered but did not take control.");
  }
}

function isMissingScramjetStoreError(error) {
  const message = error && error.message ? error.message : String(error || "");
  return message.includes("object stores was not found") || message.includes("object store was not found");
}

function deleteScramjetDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("$scramjet");
    request.onerror = () => reject(request.error || new Error("Failed to reset Scramjet IndexedDB."));
    request.onblocked = () => reject(new Error("Scramjet IndexedDB reset was blocked."));
    request.onsuccess = () => resolve();
  });
}

function syncFrameUrl(event) {
  const url = event && event.url ? String(event.url) : getCurrentFrameUrl();
  if (!url) return;

  currentUrl = url;
  addressInput.value = url;
  connectionLabel.textContent = new URL(url).hostname;
  addDebugEntry("info", `frame url changed to ${url}`);
}

function getCurrentFrameUrl() {
  if (!scramjet) return "";

  const frameLocation = getFrameLocation();
  if (frameLocation) {
    try {
      return scramjet.decodeUrl(frameLocation);
    } catch {
      // Fall back to the iframe src below.
    }
  }

  if (!proxyFrame.src || proxyFrame.src === "about:blank") return "";

  try {
    return scramjet.decodeUrl(proxyFrame.src);
  } catch {
    return "";
  }
}

function getFrameLocation() {
  try {
    return proxyFrame.contentWindow ? proxyFrame.contentWindow.location.href : "";
  } catch {
    return "";
  }
}

setInterval(refreshStatus, 5000);

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
