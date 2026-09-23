// background.js
// Watches top-level navigations. If the destination hostname matches an
// entry in the blocked-domains list, the tab is redirected to one of the
// URLs in the redirect list (chosen randomly or sequentially).

const DEFAULT_SEARCH_ENGINES = [
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "yahoo.com",
  "search.brave.com",
  "ecosia.org",
  "startpage.com",
  "yandex.com",
  "baidu.com",
  "qwant.com"
];

const DEFAULT_STATE = {
  enabled: true,
  blockedDomains: [],
  redirectUrls: [],
  mode: "random", // "random" | "sequential"
  lastIndex: -1,
  stats: { redirectCount: 0 },
  disabledUntil: null, // timestamp (ms) when the extension will auto re-enable, or null
  disableTimestamps: [], // recent times (ms) the user successfully switched off, for difficulty scaling
  allowFromSearchEngines: false, // opt-in exception: skip the redirect if the click came from a search results page
  searchEngineDomains: DEFAULT_SEARCH_ENGINES
};

const REACTIVATE_ALARM = "reactivate-enabled";
const DISABLE_DURATION_MINUTES = 5;
// Must match DISABLE_HISTORY_WINDOW_MS in challenge.js — the rolling window
// used to judge "how often has this been switched off lately".
const DISABLE_HISTORY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function getState() {
  return chrome.storage.local.get(DEFAULT_STATE);
}

// Turn "https://www.Example.com/foo" or "example.com" into "example.com"
function normalizeDomain(input) {
  if (!input) return "";
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, ""); // strip protocol
  d = d.split("/")[0]; // strip path
  d = d.split(":")[0]; // strip port
  d = d.replace(/^www\./, "");
  return d;
}

// True if hostname is the domain itself or any subdomain of it.
function hostMatchesDomain(hostname, domain) {
  if (!domain) return false;
  hostname = hostname.toLowerCase();
  return hostname === domain || hostname.endsWith("." + domain);
}

function ensureProtocol(url) {
  url = url.trim();
  if (!/^[a-z]+:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return url;
}

// webNavigation doesn't expose a referrer directly, so we approximate it:
// at the moment a navigation starts, the tab's *current* URL (before it's
// overwritten) is the page the click came from. For links opened in a new
// tab (target="_blank"), the new tab has no prior URL of its own, so we
// fall back to the opener tab's URL instead.
async function getReferrerHostname(details) {
  try {
    const tab = await chrome.tabs.get(details.tabId);
    let refUrl = tab.url;

    if ((!refUrl || refUrl === "about:blank") && tab.openerTabId != null) {
      try {
        const opener = await chrome.tabs.get(tab.openerTabId);
        refUrl = opener.url;
      } catch (e) {
        // opener tab may already be closed; nothing more we can do
      }
    }

    if (!refUrl) return null;
    return new URL(refUrl).hostname.toLowerCase();
  } catch (e) {
    return null;
  }
}

// True if the URL is essentially just the domain itself — root path, no
// query string — as opposed to a specific page/article/post on that domain.
function isBaseDomainUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname === "/" || u.pathname === "") && !u.search;
  } catch (e) {
    return false;
  }
}

async function pickRedirectUrl(state) {
  const list = state.redirectUrls;
  if (!list.length) return null;

  let index;
  if (state.mode === "sequential") {
    index = (state.lastIndex + 1) % list.length;
    await chrome.storage.local.set({ lastIndex: index });
  } else {
    index = Math.floor(Math.random() * list.length);
  }
  return ensureProtocol(list[index]);
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Only act on the top-level frame (the address-bar navigation itself),
  // not iframes embedded within a page.
  if (details.frameId !== 0) return;

  const state = await getState();
  if (!state.enabled) return;
  if (!state.blockedDomains.length || !state.redirectUrls.length) return;

  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch (e) {
    return; // not a normal http(s) URL (e.g. chrome://, about:blank)
  }
  if (!hostname) return;

  const isBlocked = state.blockedDomains.some((raw) =>
    hostMatchesDomain(hostname, normalizeDomain(raw))
  );
  if (!isBlocked) return;

  if (
    state.allowFromSearchEngines &&
    state.searchEngineDomains?.length &&
    !isBaseDomainUrl(details.url)
  ) {
    const referrerHostname = await getReferrerHostname(details);
    if (referrerHostname) {
      const fromSearchEngine = state.searchEngineDomains.some((raw) =>
        hostMatchesDomain(referrerHostname, normalizeDomain(raw))
      );
      if (fromSearchEngine) return; // let this one navigation through
    }
  }

  const targetUrl = await pickRedirectUrl(state);
  if (!targetUrl) return;

  // Avoid an infinite loop if a blocked domain happens to equal the chosen
  // redirect target's own domain.
  let targetHostname = null;
  try {
    targetHostname = new URL(targetUrl).hostname;
  } catch (e) {
    /* ignore */
  }
  if (targetHostname && targetHostname === hostname) return;

  chrome.tabs.update(details.tabId, { url: targetUrl });

  const newCount = (state.stats?.redirectCount || 0) + 1;
  await chrome.storage.local.set({ stats: { redirectCount: newCount } });
});

// Initialize default storage values on install.
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_STATE, ...current };
  await chrome.storage.local.set(merged);
  await reconcileDisableState();
});

chrome.runtime.onStartup.addListener(reconcileDisableState);

// Whenever "enabled" is switched off, schedule an alarm to flip it back on
// after DISABLE_DURATION_MINUTES. Whenever it's switched back on (by the
// user, or by the alarm firing), clear any pending alarm/timestamp.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.enabled) return;

  if (changes.enabled.newValue === false) {
    const now = Date.now();
    const disabledUntil = now + DISABLE_DURATION_MINUTES * 60 * 1000;

    const { disableTimestamps } = await chrome.storage.local.get({
      disableTimestamps: []
    });
    const recent = disableTimestamps.filter(
      (ts) => now - ts < DISABLE_HISTORY_WINDOW_MS
    );
    recent.push(now);

    await chrome.storage.local.set({ disabledUntil, disableTimestamps: recent });
    chrome.alarms.create(REACTIVATE_ALARM, {
      delayInMinutes: DISABLE_DURATION_MINUTES
    });
  } else if (changes.enabled.newValue === true) {
    chrome.alarms.clear(REACTIVATE_ALARM);
    const { disabledUntil } = await chrome.storage.local.get({
      disabledUntil: null
    });
    if (disabledUntil !== null) {
      await chrome.storage.local.set({ disabledUntil: null });
    }
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== REACTIVATE_ALARM) return;
  await chrome.storage.local.set({ enabled: true, disabledUntil: null });
});

// On browser/service-worker startup, make sure a pending disable is either
// resolved (if its time already passed) or re-armed as an alarm (alarms are
// persisted by Chrome, but this is a safety net).
async function reconcileDisableState() {
  const { enabled, disabledUntil } = await chrome.storage.local.get({
    enabled: true,
    disabledUntil: null
  });
  if (enabled || !disabledUntil) return;

  const remainingMs = disabledUntil - Date.now();
  if (remainingMs <= 0) {
    await chrome.storage.local.set({ enabled: true, disabledUntil: null });
  } else {
    chrome.alarms.create(REACTIVATE_ALARM, {
      delayInMinutes: Math.max(remainingMs / 60000, 0.02)
    });
  }
}
