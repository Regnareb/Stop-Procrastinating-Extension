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
  searchEngineDomains: DEFAULT_SEARCH_ENGINES,
  includeReadingListUrls: false // opt-in: also use the browser's Reading List entries as redirect targets
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

// Compares URLs loosely: ignores protocol, a leading "www.", and a trailing
// slash, so "https://example.com/foo" and "example.com/foo/" are treated as
// the same destination.
function normalizeUrlForComparison(url) {
  try {
    const u = new URL(ensureProtocol(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch (e) {
    return null;
  }
}

// Reading List items can change at any time (the person adds/removes them
// outside this extension entirely), so rather than copying them into
// storage once, we fetch the live list each time a redirect target is
// picked. Guarded in case the API is unavailable (older Chrome, or the
// permission somehow isn't granted).
async function getReadingListUrls() {
  if (!chrome.readingList || typeof chrome.readingList.query !== "function") {
    return [];
  }
  try {
    const items = await chrome.readingList.query({});
    return items.map((item) => item.url).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// The full pool of possible redirect destinations: the manual list, plus
// live Reading List entries if that option is on.
async function getRedirectPool(state) {
  let list = state.redirectUrls.slice();
  if (state.includeReadingListUrls) {
    list = list.concat(await getReadingListUrls());
  }
  return list;
}

function pickFromPool(pool, state) {
  if (!pool.length) return null;
  let index;
  if (state.mode === "sequential") {
    index = (state.lastIndex + 1) % pool.length;
    chrome.storage.local.set({ lastIndex: index });
  } else {
    index = Math.floor(Math.random() * pool.length);
  }
  return ensureProtocol(pool[index]);
}

// Shared by two listeners:
//  - onBeforeNavigate ("before"): the first line of defense, redirects before
//    the blocked page loads.
//  - onCommitted ("committed"): a safety net. It catches navigations that
//    onBeforeNavigate never sees (e.g. a link shortener or tracking URL on an
//    allowed site that server-side redirects to a blocked domain) and cases
//    where the tabs.update() redirect lost a race with the original navigation.
async function handleNavigation(details, phase) {
  // Only act on the top-level frame, not iframes embedded within a page.
  if (details.frameId !== 0) return;

  const state = await getState();
  if (!state.enabled) return;
  if (!state.blockedDomains.length) return;
  if (!state.redirectUrls.length && !state.includeReadingListUrls) return;

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

  const redirectPool = await getRedirectPool(state);

  // Never block/redirect a URL that is itself one of the chosen redirect
  // destinations — even if its domain also happens to be on the blocklist.
  // (This is also what prevents redirect loops.)
  const normalizedTarget = normalizeUrlForComparison(details.url);
  if (
    normalizedTarget &&
    redirectPool.some((raw) => normalizeUrlForComparison(raw) === normalizedTarget)
  ) {
    return;
  }

  // Search-engine exception. The referrer can only be worked out before the
  // navigation commits, so "before" records an allowance and "committed"
  // honours it instead of re-checking.
  const allowKey = `allowed:${details.tabId}`;
  if (phase === "before") {
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
        if (fromSearchEngine) {
          await chrome.storage.session.set({ [allowKey]: normalizedTarget });
          return; // let this one navigation through
        }
      }
    }
  } else {
    const stored = (await chrome.storage.session.get(allowKey))[allowKey];
    if (stored) {
      await chrome.storage.session.remove(allowKey);
      if (stored === normalizedTarget) return;
    }
  }

  const targetUrl = pickFromPool(redirectPool, state);
  if (!targetUrl) return;

  chrome.tabs.update(details.tabId, { url: targetUrl });

  const newCount = (state.stats?.redirectCount || 0) + 1;
  await chrome.storage.local.set({ stats: { redirectCount: newCount } });
}

chrome.webNavigation.onBeforeNavigate.addListener((details) =>
  handleNavigation(details, "before")
);
chrome.webNavigation.onCommitted.addListener((details) =>
  handleNavigation(details, "committed")
);

// Clean up any leftover search-engine allowance when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`allowed:${tabId}`);
});

// Initialize default storage values on install.
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_STATE, ...current };
  await chrome.storage.local.set(merged);
  await reconcileDisableState();
});

chrome.runtime.onStartup.addListener(reconcileDisableState);

// ---------------------------------------------------------------------------
// Reactivation toast
// ---------------------------------------------------------------------------

// Injected into the page (via chrome.scripting.executeScript), so it must be
// fully self-contained: it can't reference anything else in this file. It
// renders inside a shadow root so the host page's CSS can't affect it.
function showReactivationToast() {
  const HOST_ID = "stop-procrastinating-toast-host";
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "all: initial; position: fixed; top: 20px; right: 20px; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .toast {
        display: flex; align-items: center; gap: 10px;
        max-width: 320px; padding: 12px 16px;
        background: #1f2937; color: #fff;
        font: 500 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.3);
        opacity: 0; transform: translateY(-8px);
        transition: opacity .25s ease, transform .25s ease;
      }
      .toast.show { opacity: 1; transform: translateY(0); }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; flex: none; }
    </style>
    <div class="toast" role="status" aria-live="polite">
      <span class="dot"></span>
      <span>Stop Procrastinating is back on. This site is blocked.</span>
    </div>`;
  (document.body || document.documentElement).appendChild(host);

  const toast = root.querySelector(".toast");
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => host.remove(), 300);
  }, 4000);
}

// Shows the toast on every window's active tab, but only if that tab is
// currently on a blocked domain (and isn't one of the exempt redirect
// destinations, which the extension deliberately leaves alone).
async function notifyReactivated() {
  const state = await getState();
  if (!state.blockedDomains.length) return;
  const redirectPool = await getRedirectPool(state);

  const tabs = await chrome.tabs.query({ active: true });
  for (const tab of tabs) {
    if (!tab.url || tab.id == null) continue;

    let hostname;
    try {
      const u = new URL(tab.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      hostname = u.hostname;
    } catch (e) {
      continue;
    }

    const isBlocked = state.blockedDomains.some((raw) =>
      hostMatchesDomain(hostname, normalizeDomain(raw))
    );
    if (!isBlocked) continue;

    const normalizedTab = normalizeUrlForComparison(tab.url);
    if (
      normalizedTab &&
      redirectPool.some((raw) => normalizeUrlForComparison(raw) === normalizedTab)
    ) {
      continue;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showReactivationToast
      });
    } catch (e) {
      // Some pages (e.g. the Chrome Web Store) can't be scripted; skip them.
    }
  }
}

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
    // Only a real off -> on transition counts as a reactivation.
    if (changes.enabled.oldValue === false) notifyReactivated();
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
