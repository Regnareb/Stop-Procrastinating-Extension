# Stop Procrastinating

A Chrome extension (Manifest V3) that keeps two lists — **blocked domains**
and **redirect URLs** — and sends you to one of the redirect URLs whenever
you try to visit a blocked domain.

## How it works

- The background service worker listens for top-level tab navigations
  (`chrome.webNavigation.onBeforeNavigate`).
- If the destination hostname matches an entry in your blocked-domains list
  (subdomains are matched automatically — blocking `example.com` also blocks
  `www.example.com`, `mail.example.com`, etc.), the tab is redirected via
  `chrome.tabs.update`.
- The redirect target is chosen from your redirect-URL list either
  **randomly** or **sequentially (round-robin)** — pick the mode in Settings.
- Both lists, the enabled/disabled toggle, and the mode are stored in
  `chrome.storage.local` and edited from the Settings (options) page or the
  toolbar popup.

## Install (load unpacked, for development/personal use)

1. Unzip this folder somewhere permanent (don't delete it after installing —
   Chrome loads the extension directly from these files).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder
   (`domain-blocker-extension`).
5. The extension icon will appear in your toolbar.

## Usage

- Click the toolbar icon to quickly enable/disable the extension or block
  the site you're currently on.
- **Disabling requires solving a quick math problem**: clicking the switch
  to turn it off pops up a modal with a random math question. The switch
  only actually turns off once you answer correctly; cancelling or closing
  the modal leaves it on. This is a small deliberate speed bump against
  impulsively disabling the blocker — it does not add security against
  someone editing the extension's files directly.
- **The question gets harder the more often you disable it**: the extension
  keeps a rolling count of how many times you've switched off in the last
  hour and scales the math accordingly:
  - 0 recent disables → **Easy** (e.g. `23 + 17`)
  - 1–2 recent disables → **Medium** (larger numbers, e.g. `184 - 96`)
  - 3–4 recent disables → **Hard** (two-step, e.g. `(14 + 8) × 6`)
  - 5+ recent disables → **Very hard** (chained operations, e.g.
    `(9 × 7) - (6 × 8)`, or exact division)

  The current difficulty and how many times you've toggled off recently are
  shown in the challenge modal once it goes above Easy. The 1-hour window
  and the thresholds are set by `DISABLE_HISTORY_WINDOW_MS` and
  `DIFFICULTY_TIERS` at the top of `challenge.js` (keep
  `DISABLE_HISTORY_WINDOW_MS` in sync with the same constant in
  `background.js`).
- **Turning the switch off is temporary**: whenever you disable the
  extension (from the popup or the Settings page), it automatically turns
  itself back on **5 minutes later**. A live countdown ("Reactivates
  automatically in 4:45") shows next to the switch while it's off. Turning
  the switch back on manually cancels the countdown immediately. This is
  meant to discourage casually disabling the blocker to "just quickly" visit
  a blocked site — you can still turn it back on any time, but not stay off
  indefinitely without re-toggling. The 5-minute duration is set by
  `DISABLE_DURATION_MINUTES` at the top of `background.js` if you want to
  change it.
- Click **Open settings** (or right-click the icon → Options) to manage the
  full blocked-domains list and redirect-URLs list, one entry per line.
- Toggle **Random** vs **Sequential** to control how the redirect target is
  chosen each time a blocked site is hit.
- **Search-engine exception (off by default)**: in Settings, you
  can enable "Allow visits arriving from a search engine" so that clicking a
  blocked site directly from a search results page (Google, Bing, DuckDuckGo,
  etc. — the list is editable) isn't redirected. This works by checking, at
  the moment a navigation starts, either the tab's previous URL (same-tab
  clicks) or the opener tab's URL (links opened in a new tab), and matching
  its hostname against your search-engine list.

- **Optional: include Reading List URLs as redirect targets**: next to the
  Redirect URLs box in Settings, ticking "Also include all Reading List
  URLs" adds every page saved in Chrome's built-in Reading List (the one in
  the side panel) to the pool of possible redirect destinations, alongside
  whatever you've typed in manually.

## Notes & limitations

- Matching is by hostname (registrable domain + subdomains), not by full
  URL/path — entering `example.com` blocks the whole site.
- **A URL that's itself in your redirect pool (the manual Redirect URLs
  list, or a live Reading List entry if that option is on) is never
  blocked**, even if its domain is also on your blocklist. 
- Only top-level (address-bar) navigations are intercepted — this covers
  typing a URL, clicking a link, bookmarks, etc. It does not block content
  loaded inside an `<iframe>` on an otherwise-allowed page.
- If a redirect URL happens to point at the same domain as the one being
  blocked, that specific redirect is skipped to avoid a loop — make sure
  your redirect URLs point to sites that aren't also on your blocked list.
- This uses broad host permissions (`<all_urls>`) because it needs to see
  the destination of every navigation to check it against your list.

## File overview

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Core blocking/redirect logic |
| `options.html/js/css` | Full settings page (manage both lists) |
| `popup.html/js/css` | Toolbar popup (quick toggle + block current site) |
| `challenge.js/css` | Shared math-challenge modal shown before disabling |
| `icons/` | Extension icons |
