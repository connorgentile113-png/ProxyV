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

const searchTemplate = "https://www.google.com/search?q=%s";
let currentUrl = "";
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
  addressInput.focus();
  void refreshStatus();
});

reloadButton.addEventListener("click", () => {
  window.location.reload();
});

detachButton.addEventListener("click", () => {
  if (currentUrl) window.open(toProxyUrl(currentUrl), "_blank", "noopener,noreferrer");
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
  window.location.href = toProxyUrl(url);
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
