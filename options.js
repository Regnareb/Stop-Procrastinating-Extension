const DEFAULT_STATE = {
  enabled: true,
  blockedDomains: [],
  redirectUrls: [],
  mode: "random",
  lastIndex: -1,
  stats: { redirectCount: 0 },
  disabledUntil: null
};

let disabledUntilCache = null;
let countdownTimer = null;
let isDirty = false;

function markDirty() {
  if (isDirty) return;
  isDirty = true;
  document.getElementById("unsavedMsg")?.classList.add("show");
}

function clearDirty() {
  isDirty = false;
  document.getElementById("unsavedMsg")?.classList.remove("show");
}

window.addEventListener("beforeunload", (e) => {
  if (!isDirty) return;
  // Chrome ignores any custom text and shows its own generic message —
  // setting returnValue is what actually triggers the confirmation prompt.
  e.preventDefault();
  e.returnValue = "";
});

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderCountdown() {
  const el = document.getElementById("countdown");
  if (!disabledUntilCache) {
    el.textContent = "";
    return;
  }
  const remaining = disabledUntilCache - Date.now();
  if (remaining <= 0) {
    el.textContent = "";
    return;
  }
  el.textContent = `Reactivates automatically in ${formatCountdown(remaining)}`;
}

function startCountdownTimer() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(renderCountdown, 1000);
  renderCountdown();
}

const els = {
  enabledToggle: document.getElementById("enabledToggle"),
  statusLine: document.getElementById("statusLine"),
  blockedDomains: document.getElementById("blockedDomains"),
  redirectUrls: document.getElementById("redirectUrls"),
  newBlockedDomain: document.getElementById("newBlockedDomain"),
  newRedirectUrl: document.getElementById("newRedirectUrl"),
  addBlockedBtn: document.getElementById("addBlockedBtn"),
  addRedirectBtn: document.getElementById("addRedirectBtn"),
  saveBtn: document.getElementById("saveBtn"),
  savedMsg: document.getElementById("savedMsg"),
  unsavedMsg: document.getElementById("unsavedMsg"),
  redirectCount: document.getElementById("redirectCount"),
  modeRadios: document.querySelectorAll('input[name="mode"]'),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  importMsg: document.getElementById("importMsg")
};

function linesToArray(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function arrayToLines(arr) {
  return (arr || []).join("\n");
}

function updateStatusLine(state) {
  els.statusLine.textContent = state.enabled
    ? `Active — ${state.blockedDomains.length} blocked domain(s), ${state.redirectUrls.length} redirect URL(s).`
    : "Disabled — no redirects will happen.";
}

async function load() {
  const state = await chrome.storage.local.get(DEFAULT_STATE);
  els.enabledToggle.checked = state.enabled;
  els.blockedDomains.value = arrayToLines(state.blockedDomains);
  els.redirectUrls.value = arrayToLines(state.redirectUrls);
  els.redirectCount.textContent = state.stats?.redirectCount || 0;
  els.modeRadios.forEach((r) => (r.checked = r.value === state.mode));
  updateStatusLine(state);
  disabledUntilCache = state.disabledUntil;
  startCountdownTimer();
  clearDirty();
}

async function save() {
  const enabled = els.enabledToggle.checked;
  const blockedDomains = linesToArray(els.blockedDomains.value);
  const redirectUrls = linesToArray(els.redirectUrls.value);
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "random";

  await chrome.storage.local.set({ enabled, blockedDomains, redirectUrls, mode });

  const state = await chrome.storage.local.get(DEFAULT_STATE);
  updateStatusLine(state);

  els.savedMsg.textContent = "Saved.";
  els.savedMsg.classList.add("show");
  setTimeout(() => els.savedMsg.classList.remove("show"), 1500);
  clearDirty();
}

els.addBlockedBtn.addEventListener("click", () => {
  const val = els.newBlockedDomain.value.trim();
  if (!val) return;
  els.blockedDomains.value = els.blockedDomains.value
    ? els.blockedDomains.value + "\n" + val
    : val;
  els.newBlockedDomain.value = "";
  save();
});

els.newBlockedDomain.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    els.addBlockedBtn.click();
  }
});

els.addRedirectBtn.addEventListener("click", () => {
  const val = els.newRedirectUrl.value.trim();
  if (!val) return;
  els.redirectUrls.value = els.redirectUrls.value
    ? els.redirectUrls.value + "\n" + val
    : val;
  els.newRedirectUrl.value = "";
  save();
});

els.newRedirectUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    els.addRedirectBtn.click();
  }
});

els.enabledToggle.addEventListener("change", async () => {
  if (els.enabledToggle.checked) {
    await save();
    return;
  }

  // Trying to turn it off: revert the visible switch until the challenge
  // is solved.
  els.enabledToggle.checked = true;
  showMathChallenge({
    onSuccess: async () => {
      els.enabledToggle.checked = false;
      await save();
    },
    onCancel: () => {
      els.enabledToggle.checked = true;
    }
  });
});
els.saveBtn.addEventListener("click", save);
els.modeRadios.forEach((r) => r.addEventListener("change", save));

// Typing directly into either list is the one path that doesn't auto-save
// — flag it so we can warn before the tab closes with edits still unsaved.
els.blockedDomains.addEventListener("input", markDirty);
els.redirectUrls.addEventListener("input", markDirty);

const EXPORT_VERSION = 1;

function showImportMsg(text, isError) {
  els.importMsg.textContent = text;
  els.importMsg.style.color = isError ? "#dc3545" : "#16a34a";
  setTimeout(() => {
    els.importMsg.textContent = "";
  }, 4000);
}

els.exportBtn.addEventListener("click", async () => {
  // Export whatever is currently saved in storage (click Save first if you
  // want unsaved textarea edits included).
  const state = await chrome.storage.local.get(DEFAULT_STATE);
  const payload = {
    exportVersion: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    enabled: state.enabled,
    mode: state.mode,
    blockedDomains: state.blockedDomains,
    redirectUrls: state.redirectUrls
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const dateStr = new Date().toISOString().slice(0, 10);

  const a = document.createElement("a");
  a.href = url;
  a.download = `domain-blocker-settings-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

els.importBtn.addEventListener("click", () => {
  els.importFile.click();
});

els.importFile.addEventListener("change", async () => {
  const file = els.importFile.files[0];
  els.importFile.value = ""; // allow re-selecting the same file later
  if (!file) return;

  let data;
  try {
    const text = await file.text();
    data = JSON.parse(text);
  } catch (e) {
    showImportMsg("Couldn't read that file — is it valid JSON?", true);
    return;
  }

  if (typeof data !== "object" || data === null) {
    showImportMsg("That file doesn't look like a settings export.", true);
    return;
  }

  const blockedDomains = Array.isArray(data.blockedDomains)
    ? data.blockedDomains.filter((d) => typeof d === "string" && d.trim())
    : null;
  const redirectUrls = Array.isArray(data.redirectUrls)
    ? data.redirectUrls.filter((u) => typeof u === "string" && u.trim())
    : null;

  if (blockedDomains === null || redirectUrls === null) {
    showImportMsg(
      "That file is missing blockedDomains/redirectUrls arrays.",
      true
    );
    return;
  }

  const confirmed = window.confirm(
    `Import ${blockedDomains.length} blocked domain(s) and ${redirectUrls.length} redirect URL(s)? This replaces your current lists.`
  );
  if (!confirmed) return;

  const mode = data.mode === "sequential" ? "sequential" : "random";
  const enabled = typeof data.enabled === "boolean" ? data.enabled : true;

  await chrome.storage.local.set({
    blockedDomains,
    redirectUrls,
    mode,
    enabled,
    lastIndex: -1
  });

  await load();
  showImportMsg("Import successful.", false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stats) {
    els.redirectCount.textContent = changes.stats.newValue?.redirectCount || 0;
  }
  if (changes.enabled) {
    els.enabledToggle.checked = changes.enabled.newValue;
  }
  if (changes.disabledUntil) {
    disabledUntilCache = changes.disabledUntil.newValue;
    renderCountdown();
  }
});

load();
