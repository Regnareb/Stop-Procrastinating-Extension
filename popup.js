const DEFAULT_STATE = {
  enabled: true,
  blockedDomains: [],
  redirectUrls: [],
  mode: "random",
  disabledUntil: null
};

const enabledToggle = document.getElementById("enabledToggle");
const currentSite = document.getElementById("currentSite");
const blockCurrentBtn = document.getElementById("blockCurrentBtn");
const openOptionsBtn = document.getElementById("openOptionsBtn");
const counts = document.getElementById("counts");
const countdownEl = document.getElementById("countdown");

let disabledUntilCache = null;
let countdownTimer = null;

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderCountdown() {
  if (!disabledUntilCache) {
    countdownEl.textContent = "";
    return;
  }
  const remaining = disabledUntilCache - Date.now();
  if (remaining <= 0) {
    countdownEl.textContent = "";
    return;
  }
  countdownEl.textContent = `Reactivates automatically in ${formatCountdown(remaining)}`;
}

function startCountdownTimer() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(renderCountdown, 1000);
  renderCountdown();
}

function normalizeDomain(input) {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split("/")[0];
  d = d.split(":")[0];
  d = d.replace(/^www\./, "");
  return d;
}

let activeHostname = null;

async function init() {
  const state = await chrome.storage.local.get(DEFAULT_STATE);
  enabledToggle.checked = state.enabled;
  counts.textContent = `${state.blockedDomains.length} blocked · ${state.redirectUrls.length} redirect URL(s)`;
  disabledUntilCache = state.disabledUntil;
  startCountdownTimer();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) {
    try {
      const u = new URL(tab.url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        activeHostname = normalizeDomain(u.hostname);
        currentSite.textContent = activeHostname;
        const alreadyBlocked = state.blockedDomains
          .map(normalizeDomain)
          .includes(activeHostname);
        blockCurrentBtn.textContent = alreadyBlocked
          ? "Already blocked"
          : "Block this site";
        blockCurrentBtn.disabled = alreadyBlocked;
      } else {
        currentSite.textContent = "This page can't be blocked.";
        blockCurrentBtn.disabled = true;
      }
    } catch (e) {
      currentSite.textContent = "—";
      blockCurrentBtn.disabled = true;
    }
  }
}

enabledToggle.addEventListener("change", async () => {
  if (enabledToggle.checked) {
    // Turning it back on is always allowed immediately.
    await chrome.storage.local.set({ enabled: true });
    return;
  }

  // Trying to turn it off: revert the visible switch until the challenge
  // is solved, so the UI never shows "off" prematurely.
  enabledToggle.checked = true;
  showMathChallenge({
    onSuccess: async () => {
      enabledToggle.checked = false;
      await chrome.storage.local.set({ enabled: false });
    },
    onCancel: () => {
      enabledToggle.checked = true;
    }
  });
});

blockCurrentBtn.addEventListener("click", async () => {
  if (!activeHostname) return;
  const state = await chrome.storage.local.get(DEFAULT_STATE);
  const domains = state.blockedDomains || [];
  if (!domains.map(normalizeDomain).includes(activeHostname)) {
    domains.push(activeHostname);
    await chrome.storage.local.set({ blockedDomains: domains });
  }
  blockCurrentBtn.textContent = "Already blocked";
  blockCurrentBtn.disabled = true;
  counts.textContent = `${domains.length} blocked · ${state.redirectUrls.length} redirect URL(s)`;
});

openOptionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) {
    enabledToggle.checked = changes.enabled.newValue;
  }
  if (changes.disabledUntil) {
    disabledUntilCache = changes.disabledUntil.newValue;
    renderCountdown();
  }
});

init();
