// challenge.js
// Shared "prove you meant it" math challenge, used by both popup.js and
// options.js right before the extension is switched off. Difficulty scales
// with how many times it's been switched off recently.

// Must match DISABLE_HISTORY_WINDOW_MS in background.js.
const DISABLE_HISTORY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Ordered low → high; the highest tier whose threshold is met wins.
const DIFFICULTY_TIERS = [
  { label: "Easy", minRecentDisables: 0 },
  { label: "Medium", minRecentDisables: 1 },
  { label: "Hard", minRecentDisables: 3 },
  { label: "Very hard", minRecentDisables: 5 }
];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getRecentDisableCount() {
  const { disableTimestamps } = await chrome.storage.local.get({
    disableTimestamps: []
  });
  const now = Date.now();
  return disableTimestamps.filter((ts) => now - ts < DISABLE_HISTORY_WINDOW_MS)
    .length;
}

function pickTier(recentCount) {
  let tier = DIFFICULTY_TIERS[0];
  for (const t of DIFFICULTY_TIERS) {
    if (recentCount >= t.minRecentDisables) tier = t;
  }
  return tier;
}

function generateEasyChallenge() {
  const operations = [
    { symbol: "+", fn: (a, b) => a + b },
    { symbol: "-", fn: (a, b) => a - b },
    { symbol: "×", fn: (a, b) => a * b }
  ];
  const op = operations[Math.floor(Math.random() * operations.length)];

  let a, b;
  if (op.symbol === "×") {
    a = randInt(2, 11);
    b = randInt(2, 11);
  } else {
    a = randInt(10, 50);
    b = randInt(10, 50);
    if (op.symbol === "-" && b > a) [a, b] = [b, a];
  }
  return { question: `${a} ${op.symbol} ${b}`, answer: op.fn(a, b) };
}

function generateMediumChallenge() {
  const operations = [
    { symbol: "+", fn: (a, b) => a + b },
    { symbol: "-", fn: (a, b) => a - b },
    { symbol: "×", fn: (a, b) => a * b }
  ];
  const op = operations[Math.floor(Math.random() * operations.length)];

  let a, b;
  if (op.symbol === "×") {
    a = randInt(6, 15);
    b = randInt(6, 15);
  } else {
    a = randInt(50, 300);
    b = randInt(50, 300);
    if (op.symbol === "-" && b > a) [a, b] = [b, a];
  }
  return { question: `${a} ${op.symbol} ${b}`, answer: op.fn(a, b) };
}

function generateHardChallenge() {
  const patterns = [
    () => {
      const a = randInt(5, 20),
        b = randInt(5, 20),
        c = randInt(2, 9);
      return { question: `(${a} + ${b}) × ${c}`, answer: (a + b) * c };
    },
    () => {
      const a = randInt(20, 50),
        b = randInt(5, 20),
        c = randInt(2, 9);
      return { question: `(${a} - ${b}) × ${c}`, answer: (a - b) * c };
    },
    () => {
      const a = randInt(4, 12),
        b = randInt(4, 12),
        c = randInt(1, 30);
      return { question: `${a} × ${b} - ${c}`, answer: a * b - c };
    }
  ];
  return patterns[Math.floor(Math.random() * patterns.length)]();
}

function generateVeryHardChallenge() {
  const patterns = [
    () => {
      const a = randInt(4, 12),
        b = randInt(4, 12),
        c = randInt(4, 12),
        d = randInt(4, 12);
      return {
        question: `(${a} × ${b}) - (${c} × ${d})`,
        answer: a * b - c * d
      };
    },
    () => {
      // exact division, so the answer is always a whole number
      const divisor = randInt(3, 12);
      const quotient = randInt(4, 15);
      const dividend = divisor * quotient;
      const c = randInt(5, 40);
      return { question: `(${dividend} ÷ ${divisor}) + ${c}`, answer: quotient + c };
    },
    () => {
      const a = randInt(10, 40),
        b = randInt(10, 40),
        c = randInt(2, 9),
        d = randInt(1, 20);
      return {
        question: `(${a} + ${b}) × ${c} - ${d}`,
        answer: (a + b) * c - d
      };
    }
  ];
  return patterns[Math.floor(Math.random() * patterns.length)]();
}

function generateMathChallenge(tierLabel) {
  switch (tierLabel) {
    case "Very hard":
      return generateVeryHardChallenge();
    case "Hard":
      return generateHardChallenge();
    case "Medium":
      return generateMediumChallenge();
    default:
      return generateEasyChallenge();
  }
}

/**
 * Shows a full-page overlay with a math question whose difficulty scales
 * with how often the switch has been turned off in the last hour. Calls
 * onSuccess() if answered correctly, onCancel() if the user cancels/
 * escapes/closes without answering correctly.
 */
async function showMathChallenge({ onSuccess, onCancel }) {
  const recentCount = await getRecentDisableCount();
  const tier = pickTier(recentCount);
  const challenge = generateMathChallenge(tier.label);

  const overlay = document.createElement("div");
  overlay.className = "challenge-overlay";
  overlay.innerHTML = `
    <div class="challenge-box" role="dialog" aria-modal="true">
      <p class="challenge-title">Solve this to turn protection off</p>
      ${
        tier.label !== "Easy"
          ? `<p class="challenge-tier">Difficulty: ${tier.label} — you've switched off ${recentCount} time(s) in the last hour</p>`
          : ""
      }
      <p class="challenge-question">${challenge.question} = ?</p>
      <input type="number" inputmode="numeric" class="challenge-input" autocomplete="off" />
      <p class="challenge-error" hidden>Not quite — try again.</p>
      <div class="challenge-actions">
        <button type="button" class="challenge-cancel">Cancel</button>
        <button type="button" class="challenge-confirm">Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector(".challenge-input");
  const errorMsg = overlay.querySelector(".challenge-error");
  const confirmBtn = overlay.querySelector(".challenge-confirm");
  const cancelBtn = overlay.querySelector(".challenge-cancel");

  let settled = false;
  input.focus();

  function cleanup() {
    overlay.remove();
  }

  function finish(success) {
    if (settled) return;
    settled = true;
    cleanup();
    if (success) onSuccess();
    else onCancel();
  }

  function attempt() {
    const val = parseInt(input.value, 10);
    if (!Number.isNaN(val) && val === challenge.answer) {
      finish(true);
    } else {
      errorMsg.hidden = false;
      input.value = "";
      input.focus();
    }
  }

  confirmBtn.addEventListener("click", attempt);
  cancelBtn.addEventListener("click", () => finish(false));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) finish(false);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      attempt();
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
}
