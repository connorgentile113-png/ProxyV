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
let pendingFrameUrl = "";
const debugEntries = [];

installDebugConsole();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(addressInput.value);
});

homeButton.addEventListener("click", () => {
  currentUrl = "";
  pendingFrameUrl = "";
  addressInput.value = "";
  emptyState.hidden = false;
  proxyFrame.hidden = true;
  proxyFrame.src = "about:blank";
  addressInput.focus();
  void refreshStatus();
});

reloadButton.addEventListener("click", () => {
  if (currentUrl) loadFrame(currentUrl);
});

detachButton.addEventListener("click", () => {
  if (currentUrl) window.open(toProxyUrl(currentUrl), "_blank", "noopener,noreferrer");
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || !event.data || event.data.source !== "proxyv") return;

  if (event.data.type === "navigate" && event.data.url) {
    navigate(event.data.url);
    return;
  }

  if (event.data.type === "loaded" && event.data.url) {
    currentUrl = event.data.url;
    addressInput.value = event.data.url;
    connectionLabel.textContent = new URL(event.data.url).hostname;
  }
});

void refreshStatus();

function navigate(input) {
  const url = normalizeAddress(input);
  if (!url) return;

  currentUrl = url;
  addressInput.value = url;
  emptyState.hidden = true;
  connectionLabel.textContent = new URL(url).hostname;
  addDebugEntry("info", `navigating to ${url}`);
  loadFrame(url);
}

function loadFrame(url) {
  pendingFrameUrl = toProxyUrl(url);
  proxyFrame.hidden = false;
  emptyState.hidden = true;
  proxyFrame.src = "about:blank";
  requestAnimationFrame(() => {
    if (pendingFrameUrl) proxyFrame.src = pendingFrameUrl;
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

function toProxyUrl(url) {
  return `/api/proxy?u=${encodeURIComponent(toBase64Url(url))}`;
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

function toBase64Url(value) {
  return btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
