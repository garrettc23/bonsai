// Bonsai front-end — vanilla JS driving the editorial UI.
// Four views: Overview (upload + approvals), Bills (tracked bills status),
// Offers (agent-hunted deals), Settings (agent config + integrations).
// Progress/Results/Error are overlay-style views inside the main content area.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const FLOW_STAGES = ["Extract", "Audit", "Negotiate", "Finalize"];

/**
 * Defensive wrapper around `fetch` for same-origin /api/* calls. Modern
 * browsers default credentials to "same-origin" already, so this is
 * belt-and-braces: it guarantees the bonsai_session cookie rides along
 * even if a future fetch override or polyfill changes the default.
 */
async function apiFetch(path, opts = {}) {
  return fetch(path, { ...opts, credentials: "same-origin" });
}

/**
 * Clamp a "saved" amount to [0, cap]. Saving more than the user actually
 * owes is impossible and confusing. Display $0 for negative or invalid
 * inputs rather than a misleading negative number.
 */
function clampSaved(saved, cap) {
  const s = Number(saved ?? 0);
  if (!Number.isFinite(s) || s <= 0) return 0;
  const c = Number(cap ?? 0);
  if (c > 0 && s > c) return c;
  return s;
}

/**
 * Maximum amount the user could possibly save on this bill — i.e., the
 * upper bound for any "we can save you $X" number. For medical bills
 * with an EOB, this is the EOB patient responsibility (what the user
 * actually owes after insurance), NOT the bill's full charges (which
 * may include amounts the insurer has already covered or that the
 * provider is over-billing). For everything else, fall back to the
 * bill's current balance due.
 */
function maxSavingsCap(report) {
  const meta = report?.analyzer?.metadata ?? {};
  const eobOwed = Number(meta.eob_patient_responsibility ?? 0);
  const billDue =
    Number(report?.summary?.original_balance ?? 0) ||
    Number(meta.bill_current_balance_due ?? 0);
  if (eobOwed > 0 && billDue > 0) return Math.min(eobOwed, billDue);
  if (eobOwed > 0) return eobOwed;
  return billDue;
}

/**
 * Format a US phone number progressively as the user types.
 *   "9"           → "(9"
 *   "94988"       → "(949) 88"
 *   "9498879051"  → "(949) 887-9051"
 * Strips non-digits. Leaves a leading "1" or "+1" as an unformatted
 * prefix so international numbers don't break (we only auto-format
 * 10-digit US numbers; anything else passes through digits-only).
 */
function formatPhone(value) {
  const raw = String(value ?? "");
  // Preserve a leading "+" so users typing "+44…" don't get reset.
  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return hasPlus ? "+" : "";
  // International or 11-digit US (1-aaa-bbb-cccc): leave digits alone
  // with the + when present.
  if (hasPlus || digits.length > 10) {
    return (hasPlus ? "+" : "") + digits;
  }
  // 10-digit US — chunk into (XXX) XXX-XXXX as the user types.
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

/**
 * Wire the on-input formatter to a phone <input>. Idempotent — calling
 * twice on the same element is a no-op. Reformats on every keystroke
 * and preserves caret position so the user's typing isn't disrupted.
 */
function attachPhoneFormatter(input) {
  if (!input || input.dataset.phoneFmt === "1") return;
  input.dataset.phoneFmt = "1";
  // Format the existing value once so loaded data renders pretty.
  if (input.value) input.value = formatPhone(input.value);
  input.addEventListener("input", () => {
    const before = input.value;
    const formatted = formatPhone(before);
    if (formatted !== before) {
      input.value = formatted;
      // Caret to end is fine for almost all typing flows; the alternative
      // (preserve caret across formatter inserts/deletes) is fiddly and
      // doesn't earn much UX in this form context.
      try { input.setSelectionRange(formatted.length, formatted.length); } catch {}
    }
  });
}

const ICONS = {
  scan:  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M21 7V5a2 2 0 0 0-2-2h-2"/><path d="M3 17v2a2 2 0 0 0 2 2h2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>',
  doc:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  phone: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  mail:  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>',
  pulse: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  shield:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v7c0 5-3.5 9-8 10-4.5-1-8-5-8-10V5l8-3z"/></svg>',
  pill:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 20.5a7.07 7.07 0 1 1 10-10l-10 10z"/><path d="M8.5 8.5l7 7"/></svg>',
  hospital:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M12 9v4"/><path d="M10 11h4"/></svg>',
  inbox: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  arrow: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  sparkle:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>',
};

// Sidebar nav icons
const NAV_ICONS = {
  home: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></svg>',
  inbox: ICONS.inbox,
  sparkle: ICONS.sparkle,
  user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

const TIMELINE_STEPS = [
  { stage: 0, kind: "scan",  title: "Reading the bill",
    sub: "Pulling the provider, date, line items, and totals off the document." },
  { stage: 0, kind: "doc",   title: "Cross-referencing supporting docs",
    sub: "Any attachments, prior bills, or statements — lining them up against the main bill." },
  { stage: 1, kind: "shield",title: "Grounding every claim",
    sub: "Every flag has to quote a verbatim line from the bill. Anything that can't be cited gets dropped." },
  { stage: 1, kind: "pulse", title: "Finding overcharges & errors",
    sub: "Duplicates, denied items, markups, bundled-in fees, rate mismatches — everything that shouldn't be there." },
  { stage: 1, kind: "check", title: "Sizing the opportunity",
    sub: "Dollar impact per finding, overlap-aware, so we don't double-count the same dispute twice." },
  { stage: 2, kind: "mail",  title: "Picking the channel",
    sub: "Email or phone — choosing the fastest path to the person who can say yes." },
  { stage: 2, kind: "phone", title: "Opening negotiation",
    sub: "Real outbound: email sent or call placed to the provider's billing contact." },
  { stage: 3, kind: "check", title: "Building your report",
    sub: "Findings, appeal letter, and savings summary — ready for you to review or sign." },
];

let timelineTimer = null;
let currentNav = "overview";
let historyCache = null;

// Unsaved-changes guard for Profile and Settings.
// `installUnsavedGuard(getValues)` snapshots the form state and registers a
// dirty-check used by both showNav() (in-app navigation) and beforeunload.
// Save handlers call `markSaved()` to reset the baseline.
let unsavedGuard = null;
function installUnsavedGuard(getValues) {
  let baseline;
  try { baseline = JSON.stringify(getValues()); } catch { baseline = ""; }
  const guard = {
    isDirty: () => {
      try { return JSON.stringify(getValues()) !== baseline; } catch { return false; }
    },
    markSaved: () => {
      try { baseline = JSON.stringify(getValues()); } catch { /* ignore */ }
    },
  };
  unsavedGuard = guard;
  return guard;
}
function clearUnsavedGuard() { unsavedGuard = null; }

/**
 * Reference to the upload dropzone's staged-files array, set by init().
 * Used by confirmDiscardUnsaved + beforeunload to warn before the user
 * navigates away with files queued but not yet audited.
 */
let stagedFilesRef = null;
function setStagedFilesRef(getter) { stagedFilesRef = getter; }
function hasStagedUpload() {
  try {
    const arr = stagedFilesRef?.();
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

async function confirmDiscardUnsaved() {
  // Three kinds of unsaved state can block in-app navigation:
  //   1) Mid-flow on the Overview tab — staged upload, audit running, or
  //      a completed audit awaiting accept (the "review" sub-view).
  //      Leaving discards the audited bill the user just paid Claude
  //      tokens to produce.
  //   2) Profile/Settings field edits (unsavedGuard).
  if (currentNav === "overview" && hasInFlightAuditWork()) {
    const isReview = currentWorkflowView === "review";
    const isComplaint = currentWorkflowView === "complaint";
    let title, body, confirmText, cancelText;
    if (isReview) {
      title = "Leave without accepting the plan?";
      body = "Bonsai already audited this bill. If you leave now, the audit and the negotiation plan are gone — you'll need to re-upload to get them back.";
      confirmText = "Leave";
      cancelText = "Stay on this plan";
    } else if (isComplaint) {
      title = "Discard this complaint?";
      body = "You've started typing a complaint. Leaving will clear what you've written.";
      confirmText = "Discard";
      cancelText = "Keep editing";
    } else {
      title = "Discard the bill you're about to upload?";
      body = "You have a bill queued but Bonsai hasn't audited it yet. Leaving will clear those files and you'll need to re-upload.";
      confirmText = "Discard";
      cancelText = "Stay here";
    }
    return confirmModal({ title, body, confirmText, cancelText });
  }
  if (!unsavedGuard?.isDirty?.()) return true;
  if (!(currentNav === "profile" || currentNav === "settings")) return true;
  return confirmModal({
    title: "Discard unsaved changes?",
    body: "You've made changes that haven't been saved. Leaving this tab will lose them.",
    confirmText: "Discard",
    cancelText: "Keep editing",
  });
}

function fmt$(n) {
  if (n == null) return "—";
  if (typeof n !== "number") n = Number(n);
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function fmt$2(n) {
  if (n == null) return "—";
  if (typeof n !== "number") n = Number(n);
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

// Current workflow sub-view. Used by the navigate-away guard to know
// whether the user is in the middle of an audit/review/results flow
// inside the Overview tab — tab-switches and tab-closes should warn so
// they don't lose the in-flight work.
let currentWorkflowView = "overview";
function setWorkflowView(view) {
  // overview | complaint | progress | review | results | error — sub-views inside the main content area.
  // Only one of these is visible at a time when nav=overview.
  currentWorkflowView = view;
  for (const v of ["overview", "complaint", "progress", "review", "results", "error"]) {
    const el = $(`#view-${v}`);
    if (!el) continue;
    if (v === view) el.classList.remove("hidden");
    else el.classList.add("hidden");
  }
}

/**
 * True when the user is mid-flow inside the Overview tab — has audited a
 * bill but not yet accepted, OR is staring at the audit progress view,
 * OR has staged files. Leaving any of these states drops the work.
 */
function hasInFlightAuditWork() {
  if (currentWorkflowView === "progress") return true;
  if (currentWorkflowView === "review" && reviewState != null) return true;
  if (currentWorkflowView === "complaint" && hasComplaintInProgress()) return true;
  if (hasStagedUpload()) return true;
  return false;
}

function hasComplaintInProgress() {
  // True when the user has typed anything into the complaint intake — leaving
  // mid-typing should warn so the draft text isn't silently lost.
  const company = $("#complaint-company")?.value?.trim() ?? "";
  const desc = $("#complaint-description")?.value?.trim() ?? "";
  const desired = $("#complaint-desired")?.value?.trim() ?? "";
  const email = $("#complaint-contact-email")?.value?.trim() ?? "";
  const phone = $("#complaint-contact-phone")?.value?.trim() ?? "";
  return Boolean(company || desc || desired || email || phone);
}

async function showNav(name) {
  // Block navigation when leaving in-flight work — prompts via the in-app
  // confirm modal instead of the browser's native confirm() dialog.
  // We trigger the prompt in two cases:
  //   1) name !== currentNav (real tab switch — the obvious case)
  //   2) name === currentNav === "overview" but the user is mid-flow on
  //      a workflow sub-view (progress/review). Without this, clicking
  //      "Home" while on the plan-review screen silently drops back to
  //      the upload screen, losing the audit. (Both nav values are
  //      "overview" so the first check passes through.)
  const tabSwitch = name !== currentNav;
  const homeFromMidFlow =
    name === "overview" && currentNav === "overview" && hasInFlightAuditWork();
  if (tabSwitch || homeFromMidFlow) {
    const ok = await confirmDiscardUnsaved();
    if (!ok) return;
    if (tabSwitch) clearUnsavedGuard();
    // Always reset workflow + reviewState when the user confirms leaving
    // mid-flow — otherwise the next showNav would still see leftover
    // state and re-prompt unnecessarily.
    if (homeFromMidFlow) {
      reviewState = null;
      clearComplaintInputs();
    }
    if (tabSwitch && currentWorkflowView === "complaint") {
      clearComplaintInputs();
    }
  }
  currentNav = name;
  if (name !== "bills") stopBillsPoll();
  // Toggle sidebar nav active state
  for (const n of $$(".nav-item")) {
    n.classList.toggle("active", n.dataset.nav === name);
  }
  // Hide every view; the nav-specific ones get revealed below
  for (const v of ["overview", "complaint", "progress", "review", "results", "error", "bills", "offers", "profile", "settings"]) {
    $(`#view-${v}`)?.classList.add("hidden");
  }
  if (name === "overview") {
    setWorkflowView("overview");
    resetPageHeader();
    markApprovalsSeen();
    updateNavCounts();
  } else if (name === "bills") {
    $("#view-bills").classList.remove("hidden");
    renderBills();
    markBillsSeen();
    updateNavCounts();
  } else if (name === "offers") {
    $("#view-offers").classList.remove("hidden");
    renderOffers();
    markOffersSeen();
    updateNavCounts();
  } else if (name === "profile") {
    $("#view-profile").classList.remove("hidden");
    renderProfile();
  } else if (name === "settings") {
    $("#view-settings").classList.remove("hidden");
    renderSettings();
  }
}

// ─── FlowStepper ─────────────────────────────────────────────

function renderFlowStepper(activeIndex) {
  const root = $("#flow-stepper");
  root.innerHTML = "";
  FLOW_STAGES.forEach((label, i) => {
    const step = document.createElement("div");
    step.className = "fs-step";
    if (i < activeIndex) step.classList.add("done");
    else if (i === activeIndex) step.classList.add("active");
    const done = i < activeIndex;
    step.innerHTML = `
      <div class="fs-bubble">${done ? ICONS.check : (i + 1)}</div>
      <div class="fs-label">${label}</div>`;
    root.appendChild(step);
    if (i < FLOW_STAGES.length - 1) {
      const conn = document.createElement("div");
      conn.className = "fs-connector" + (i < activeIndex ? " done" : "");
      root.appendChild(conn);
    }
  });
}

function startTimeline(fromStage = 0) {
  // Filter the timeline to steps at or beyond `fromStage`. When the user hits
  // Approve after a completed audit, we skip Extract/Audit and start at
  // Negotiate — the earlier stages are already done, and replaying them
  // would be misleading.
  const steps = TIMELINE_STEPS.filter((s) => s.stage >= fromStage);
  const initialActive = steps.length > 0 ? steps[0].stage : fromStage;
  renderFlowStepper(initialActive);
  const root = $("#timeline");
  root.innerHTML = "";
  let i = 0;
  const tick = () => {
    if (i < steps.length) {
      const prev = root.querySelector(".tl-item.active");
      if (prev) { prev.classList.remove("active"); prev.classList.add("done"); }
      const s = steps[i];
      const el = document.createElement("div");
      el.className = "tl-item active";
      el.innerHTML = `
        <div class="tl-dot"></div>
        <div class="tl-row">
          <div class="tl-chip">${ICONS[s.kind] ?? ICONS.pulse}</div>
          <div>
            <div class="tl-title">${s.title}<span class="dots"><span>.</span><span>.</span><span>.</span></span></div>
            <div class="tl-sub">${s.sub}</div>
          </div>
        </div>`;
      root.appendChild(el);
      renderFlowStepper(s.stage);
      i++;
    }
  };
  tick();
  const gaps = [2200, 3200, 4200, 6000, 5500, 7000, 9000, 12000];
  const schedule = () => {
    if (i >= steps.length) return;
    const gap = gaps[Math.min(i, gaps.length - 1)];
    timelineTimer = setTimeout(() => { tick(); schedule(); }, gap);
  };
  schedule();
}

function stopTimeline() {
  if (timelineTimer) clearTimeout(timelineTimer);
  timelineTimer = null;
  const last = $("#timeline .tl-item.active");
  if (last) {
    last.classList.remove("active");
    last.classList.add("done");
    const t = last.querySelector(".tl-title");
    if (t) t.querySelector(".dots")?.remove();
  }
  renderFlowStepper(FLOW_STAGES.length);
}

// ─── Auth gate ──────────────────────────────────────────────────
// Before booting the main app, ask the server who we are. When no user is
// present we render a full-page login/signup form and stop — successful
// auth reloads the page so init() runs again with the cookie set.

async function fetchCurrentUser() {
  try {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) return null;
    const j = await res.json();
    return j.user ?? null;
  } catch {
    return null;
  }
}

// Eye / eye-off icons for the password show-hide control. Pulled out of the
// renderers so login, signup, and reset all stay visually identical.
const ICONS_EYE = {
  show: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  hide: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a18.5 18.5 0 0 1 4.16-5.16"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 5c6.5 0 10 7 10 7a18.6 18.6 0 0 1-2.16 3.19"/><path d="M14.12 14.12A3 3 0 0 1 9.88 9.88"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
};

/**
 * Wrap a password <input> with an eye toggle. Idempotent — calling it on an
 * already-wrapped input is a no-op. Honors initial type so the same helper
 * works on autofocus / different starting states.
 */
function attachPasswordToggle(input) {
  if (!input || input.dataset.pwToggle === "1") return;
  input.dataset.pwToggle = "1";
  // Wrap the input in a positioning container so the toggle sits inside.
  const wrap = document.createElement("div");
  wrap.className = "pw-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pw-toggle";
  btn.setAttribute("aria-label", "Show password");
  btn.setAttribute("aria-pressed", "false");
  btn.innerHTML = ICONS_EYE.show;
  // Padding on the input so its text doesn't collide with the icon.
  input.classList.add("pw-input");
  wrap.appendChild(btn);
  btn.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.setAttribute("aria-pressed", showing ? "false" : "true");
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    btn.innerHTML = showing ? ICONS_EYE.show : ICONS_EYE.hide;
    // Keep focus + caret on the input — clicking the eye shouldn't kick the
    // user out of the field they were typing in.
    input.focus();
  });
}

function renderAuthScreen() {
  document.body.classList.add("auth-screen");
  document.body.innerHTML = `
    <main class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand brand">
          <span class="brand-mark" aria-hidden="true">
            <img src="/assets/bonsai-logo.svg" alt="" />
          </span>
          <span class="wordmark">
            <span class="wm-lead">Bons</span><span class="wm-tail">ai</span>
          </span>
        </div>
        <div class="auth-tag">Every bill, negotiated.</div>
        <div class="auth-tabs">
          <button type="button" class="auth-tab is-active" data-tab="login">Log in</button>
          <button type="button" class="auth-tab" data-tab="signup">Sign up</button>
        </div>
        <form class="auth-form" id="auth-form" autocomplete="on">
          <label class="auth-field">
            <span>Email</span>
            <input type="email" name="email" autocomplete="email" required />
          </label>
          <label class="auth-field">
            <span>Password</span>
            <input type="password" name="password" autocomplete="current-password" minlength="8" required />
          </label>
          <button type="submit" class="auth-submit" data-label-login="Log in" data-label-signup="Create account">Log in</button>
          <div class="auth-error" id="auth-error" hidden></div>
        </form>
        <div class="auth-foot">
          <button type="button" class="auth-link" id="auth-forgot">Forgot password?</button>
          <label class="auth-terms" id="auth-terms" hidden>
            <input type="checkbox" name="accepted_terms" id="auth-terms-input" />
            <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span>
          </label>
        </div>
      </div>
    </main>
  `;

  // If we arrived with ?reset=<token> in the URL, jump straight to the
  // reset view — that's where the password-reset email link lands.
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get("reset");
  if (resetToken) {
    renderResetView(resetToken);
    return;
  }

  let mode = "login";
  const submit = document.getElementById("auth-form").querySelector(".auth-submit");
  const errEl = document.getElementById("auth-error");
  const pwField = document.querySelector('input[name="password"]');
  attachPasswordToggle(pwField);
  const forgotLink = document.getElementById("auth-forgot");
  const termsRow = document.getElementById("auth-terms");
  const termsInput = document.getElementById("auth-terms-input");

  for (const tab of document.querySelectorAll(".auth-tab")) {
    tab.addEventListener("click", () => {
      mode = tab.dataset.tab;
      for (const t of document.querySelectorAll(".auth-tab")) t.classList.toggle("is-active", t === tab);
      submit.textContent = mode === "login" ? submit.dataset.labelLogin : submit.dataset.labelSignup;
      pwField.autocomplete = mode === "login" ? "current-password" : "new-password";
      // Forgot password is only relevant in login mode; terms is only
      // relevant in signup mode. Both live in the same .auth-foot grid
      // cell (CSS layers them) so toggling visibility doesn't move the
      // card height — only one is visible at a time.
      forgotLink.hidden = mode !== "login";
      termsRow.hidden = mode !== "signup";
      errEl.hidden = true;
    });
  }

  forgotLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    renderForgotView();
  });

  document.getElementById("auth-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const data = new FormData(ev.target);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    // The terms checkbox lives in .auth-foot (sibling of <form>) so the
    // foot can swap forgot-password ↔ terms in the same grid cell without
    // changing the card's height. That puts the checkbox outside the
    // form, which means FormData(form) doesn't pick it up — read the
    // checkbox state straight from the DOM instead.
    const acceptedTerms = !!termsInput?.checked;
    if (mode === "signup" && !acceptedTerms) {
      errEl.textContent = "Please accept the Terms of Service and Privacy Policy to create an account.";
      errEl.hidden = false;
      return;
    }
    submit.disabled = true;
    errEl.hidden = true;
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(
          mode === "signup"
            ? { email, password, accepted_terms: true }
            : { email, password },
        ),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        errEl.textContent = j.error ?? "Sign in failed.";
        errEl.hidden = false;
        return;
      }
      // Cookie is set; reload so init() runs with the session.
      window.location.reload();
    } catch (err) {
      errEl.textContent = err?.message ?? "Network error.";
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

function renderForgotView() {
  document.body.innerHTML = `
    <main class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand brand">
          <span class="brand-mark" aria-hidden="true">
            <img src="/assets/bonsai-logo.svg" alt="" />
          </span>
          <span class="wordmark">
            <span class="wm-lead">Bons</span><span class="wm-tail">ai</span>
          </span>
        </div>
        <div class="auth-tag">Reset your password</div>
        <form class="auth-form" id="forgot-form" autocomplete="on">
          <label class="auth-field">
            <span>Email</span>
            <input type="email" name="email" autocomplete="email" required />
          </label>
          <button type="submit" class="auth-submit">Send reset link</button>
          <div class="auth-error" id="auth-error" hidden></div>
          <div class="auth-info" id="auth-info" hidden></div>
        </form>
        <div class="auth-foot">
          <button type="button" class="auth-link" id="auth-back">Back to log in</button>
        </div>
      </div>
    </main>
  `;
  document.getElementById("auth-back").addEventListener("click", () => renderAuthScreen());
  const errEl = document.getElementById("auth-error");
  const infoEl = document.getElementById("auth-info");
  const submit = document.querySelector("#forgot-form .auth-submit");
  // No password field here — but keep the same form rhythm. (Forgot view
  // intentionally collects only email; the reset view below collects the
  // new password and uses the toggle.)
  document.getElementById("forgot-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = String(new FormData(ev.target).get("email") || "").trim();
    submit.disabled = true;
    errEl.hidden = true;
    infoEl.hidden = true;
    try {
      const res = await apiFetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = await res.json().catch(() => ({}));
      // Always show the same neutral confirmation — even on unknown email —
      // so we don't leak which addresses have accounts. The server logs the
      // dev link when Resend isn't wired so the developer can still retrieve it.
      infoEl.textContent = j.dev_link
        ? "Reset link generated. (Dev: check the server log for the URL.)"
        : "If that email is on file, a reset link is on its way.";
      infoEl.hidden = false;
    } catch (err) {
      errEl.textContent = err?.message ?? "Network error.";
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

function renderResetView(token) {
  document.body.innerHTML = `
    <main class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand brand">
          <span class="brand-mark" aria-hidden="true">
            <img src="/assets/bonsai-logo.svg" alt="" />
          </span>
          <span class="wordmark">
            <span class="wm-lead">Bons</span><span class="wm-tail">ai</span>
          </span>
        </div>
        <div class="auth-tag">Set a new password</div>
        <form class="auth-form" id="reset-form" autocomplete="on">
          <label class="auth-field">
            <span>New password</span>
            <input type="password" name="password" autocomplete="new-password" minlength="8" required />
          </label>
          <button type="submit" class="auth-submit">Set password &amp; log in</button>
          <div class="auth-error" id="auth-error" hidden></div>
        </form>
      </div>
    </main>
  `;
  const errEl = document.getElementById("auth-error");
  const submit = document.querySelector("#reset-form .auth-submit");
  attachPasswordToggle(document.querySelector('#reset-form input[name="password"]'));
  document.getElementById("reset-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const password = String(new FormData(ev.target).get("password") || "");
    submit.disabled = true;
    errEl.hidden = true;
    try {
      const res = await apiFetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        errEl.textContent = j.error ?? "Reset failed.";
        errEl.hidden = false;
        return;
      }
      // Server sets a fresh session cookie on success — strip the token from
      // the URL and reload into the app.
      window.history.replaceState({}, "", "/app");
      window.location.reload();
    } catch (err) {
      errEl.textContent = err?.message ?? "Network error.";
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

// ─── Init ──────────────────────────────────────────────────────

// Stash the current user so Settings can render their email + Log out.
let currentUser = null;

async function logout() {
  try { await apiFetch("/api/auth/logout", { method: "POST" }); } catch {}
  // Send the user to the marketing landing page after logout — reloading
  // the SPA shell would just bounce them straight back to the auth screen.
  window.location.href = "/";
}

async function init() {
  const user = await fetchCurrentUser();
  if (!user) {
    renderAuthScreen();
    return;
  }
  currentUser = user;
  // Inject sidebar nav icons
  for (const el of $$(".nav-ic")) {
    const k = el.dataset.icon;
    if (NAV_ICONS[k]) el.innerHTML = NAV_ICONS[k];
  }
  // Clickable logo → Overview
  const brand = $(".brand");
  if (brand) {
    brand.setAttribute("role", "button");
    brand.setAttribute("tabindex", "0");
    brand.setAttribute("aria-label", "Bonsai home");
    brand.style.cursor = "pointer";
    brand.addEventListener("click", () => showNav("overview"));
    brand.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showNav("overview"); }
    });
  }
  // Sidebar nav click handler
  for (const btn of $$(".nav-item")) {
    btn.addEventListener("click", () => showNav(btn.dataset.nav));
  }

  // Drawer trash button sits next to the bill name in the drawer header —
  // wire once since the element is static markup, not re-rendered.
  $("#drawer-delete-btn")?.addEventListener("click", () => deleteBill());

  // Browser-level unsaved-changes prompt on full page reload / tab close.
  // Triggers for any in-flight audit work (staged upload, running audit,
  // pending review accept) OR Profile/Settings dirty state — losing
  // any of these is silently destructive.
  window.addEventListener("beforeunload", (ev) => {
    if (unsavedGuard?.isDirty?.() || hasInFlightAuditWork()) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  // Fixture dropdown
  const fixtures = await apiFetch("/api/fixtures").then((r) => r.json()).catch(() => ({ fixtures: [] }));
  const sel = $("#fixture");
  sel.innerHTML = "";
  for (const f of fixtures.fixtures ?? []) {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    sel.appendChild(o);
  }
  if (sel.options.length === 0) {
    const o = document.createElement("option");
    o.value = "bill-001";
    o.textContent = "bill-001";
    sel.appendChild(o);
  }

  $("#run-fixture").addEventListener("click", async () => {
    const fixture = $("#fixture").value;
    const channel = $("#channel").value;
    await runPhasedFromSample(fixture, channel);
  });

  // Complaint flow — non-bill negotiations (flight delays, refunds, etc.).
  // Opens a dedicated workflow sub-view (not a modal) so the intake feels
  // like the same lane as the bill audit flow.
  $("#open-complaint-btn")?.addEventListener("click", openComplaintView);
  $("#complaint-submit")?.addEventListener("click", submitComplaint);

  // Right-column advisory chat. Stateless on the server — we re-send the
  // full history on every turn so /api/complaint/chat can answer in
  // context of the form fields the user has filled out so far.
  $("#complaint-chat-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submitComplaintChat();
  });
  attachPhoneFormatter($("#complaint-contact-phone"));

  // ─── Multi-file staging: drop/pick up to 10 files, review, then "Next" ──
  const uploadForm = $("#upload-form");
  const MAX_BILL_FILES = 10;
  /** @type {File[]} Files queued for upload, in order. */
  let stagedFiles = [];
  let uploadSubmittedOnce = false;
  // Expose the staged-files state to the navigation guard so the user
  // gets a "you'll lose these files" prompt if they try to leave the
  // Overview tab or close the tab mid-upload. Cleared in submitForReal()
  // once stagedFiles is reset.
  setStagedFilesRef(() => stagedFiles);

  // Speculative audit: we kick off /api/audit as soon as files are staged.
  // Users almost never change their mind after dropping, so starting early
  // swaps a ~30-45s wait after "Next" for a near-instant hand-off into review.
  // prefetchPromise resolves to { run_id, report }. prefetchController lets
  // us cancel on the client when the file set changes.
  let prefetchController = null;
  let prefetchPromise = null;
  let prefetchDebounce = null;

  function cancelPrefetch() {
    if (prefetchDebounce) { clearTimeout(prefetchDebounce); prefetchDebounce = null; }
    if (prefetchController) {
      try { prefetchController.abort(); } catch {}
      prefetchController = null;
    }
    prefetchPromise = null;
  }

  function kickoffPrefetch() {
    cancelPrefetch();
    if (stagedFiles.length === 0) return;
    // Debounce so a burst of add-more clicks only kicks off one audit.
    prefetchDebounce = setTimeout(() => {
      prefetchDebounce = null;
      const controller = new AbortController();
      prefetchController = controller;
      const form = new FormData();
      stagedFiles.forEach((f) => form.append("bill", f, f.name));
      form.set("channel", "persistent");
      prefetchPromise = apiFetch("/api/audit", { method: "POST", body: form, signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(await res.text());
          return res.json();
        })
        .catch((err) => {
          if (err?.name === "AbortError") return null;
          // Surface the error when Next is clicked; don't blow up the staging UI.
          return { __error: err };
        });
    }, 350);
  }

  function fileKey(f) { return `${f.name}|${f.size}|${f.lastModified ?? 0}`; }

  // HEIC/HEIF/TIFF thumbnails are transcoded server-side. Cache by fileKey so
  // re-renders of the staging grid don't refetch the same bytes.
  const thumbnailCache = new Map();
  async function fetchThumbnail(file) {
    const key = fileKey(file);
    if (thumbnailCache.has(key)) return thumbnailCache.get(key);
    const form = new FormData();
    form.append("file", file, file.name);
    const p = apiFetch("/api/thumbnail", { method: "POST", body: form })
      .then(async (res) => {
        if (!res.ok) return null;
        const blob = await res.blob();
        return URL.createObjectURL(blob);
      })
      .catch(() => null);
    thumbnailCache.set(key, p);
    return p;
  }

  function stageFiles(incoming) {
    if (!incoming || incoming.length === 0) return;
    const seen = new Set(stagedFiles.map(fileKey));
    let added = 0;
    let skipped = 0;
    for (const f of incoming) {
      if (stagedFiles.length >= MAX_BILL_FILES) { skipped++; continue; }
      const k = fileKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      stagedFiles.push(f);
      added++;
    }
    if (skipped > 0) {
      flashStagingMessage(`Max ${MAX_BILL_FILES} files. Ignored the extras.`);
    }
    renderStaging();
    if (added > 0) kickoffPrefetch();
  }

  function removeStagedAt(i) {
    stagedFiles.splice(i, 1);
    renderStaging();
    kickoffPrefetch();
  }

  function clearStaging() {
    stagedFiles = [];
    cancelPrefetch();
    renderStaging();
  }

  function flashStagingMessage(msg) {
    const grid = $("#dz-staging-grid");
    if (!grid) return;
    const m = document.createElement("div");
    m.className = "dz-flash";
    m.textContent = msg;
    grid.parentElement.appendChild(m);
    setTimeout(() => m.remove(), 2500);
  }

  function renderStaging() {
    const block = $("#dz-staging");
    const grid = $("#dz-staging-grid");
    const count = $("#dz-staging-count");
    // Hide the "No bill handy? Try a sample" row once the user has
    // staged real files — they clearly have a bill, the prompt is
    // distracting at that point.
    const sampleRow = document.querySelector(".dz-sample-row");
    if (!block || !grid || !count) return;
    if (stagedFiles.length === 0) {
      block.hidden = true;
      grid.innerHTML = "";
      count.textContent = "0";
      if (sampleRow) sampleRow.hidden = false;
      return;
    }
    block.hidden = false;
    if (sampleRow) sampleRow.hidden = true;
    count.textContent = String(stagedFiles.length);
    grid.innerHTML = "";
    stagedFiles.forEach((f, i) => {
      const tile = document.createElement("div");
      tile.className = "dz-tile";
      const thumb = document.createElement("div");
      thumb.className = "dz-tile-thumb";
      const isImage = (f.type || "").startsWith("image/") ||
        /\.(jpe?g|png|gif|webp|heic|heif|avif|tiff?)$/i.test(f.name);
      const needsServerThumb = /\.(heic|heif|tiff?)$/i.test(f.name);
      if (isImage) {
        const img = document.createElement("img");
        img.alt = "";
        if (needsServerThumb) {
          // Browsers can't render HEIC/HEIF/TIFF natively. Ask the server
          // to transcode a small JPEG preview. Show a subtle spinner state
          // on the tile while we wait.
          thumb.classList.add("dz-tile-thumb-loading");
          fetchThumbnail(f).then((url) => {
            if (!url) return;
            img.src = url;
            img.onload = () => { thumb.classList.remove("dz-tile-thumb-loading"); };
            img.onerror = () => { thumb.classList.remove("dz-tile-thumb-loading"); };
          }).catch(() => { thumb.classList.remove("dz-tile-thumb-loading"); });
        } else {
          try {
            img.src = URL.createObjectURL(f);
            img.onload = () => URL.revokeObjectURL(img.src);
          } catch { /* fall through to icon */ }
        }
        thumb.appendChild(img);
      } else {
        thumb.classList.add("dz-tile-thumb-doc");
        thumb.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      }
      const nameEl = document.createElement("div");
      nameEl.className = "dz-tile-name";
      nameEl.textContent = f.name;
      nameEl.title = f.name;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "dz-tile-remove";
      rm.setAttribute("aria-label", `Remove ${f.name}`);
      rm.innerHTML = "×";
      rm.addEventListener("click", (ev) => { ev.stopPropagation(); removeStagedAt(i); });
      tile.appendChild(thumb);
      tile.appendChild(nameEl);
      tile.appendChild(rm);
      grid.appendChild(tile);
    });
  }

  async function submitStagedUpload() {
    if (uploadSubmittedOnce || stagedFiles.length === 0) return;
    uploadSubmittedOnce = true;
    // Prefer the speculative prefetch if one is in flight or done.
    if (prefetchPromise) {
      await runPhasedFromPrefetch(prefetchPromise);
    } else {
      const form = new FormData();
      stagedFiles.forEach((f) => form.append("bill", f, f.name));
      form.set("channel", "persistent");
      await runPhasedFromUpload(form);
    }
  }

  uploadForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submitStagedUpload();
  });
  // Primary input: pick one or many files; they accumulate rather than auto-post.
  $('input[name="bill"]')?.addEventListener("change", (ev) => {
    const input = ev.currentTarget;
    if (input.files && input.files.length > 0) {
      stageFiles(Array.from(input.files));
      input.value = ""; // reset so re-picking the same file stages again after removal
    }
  });
  // Add-more picker inside the staging area.
  $("#dz-add-input")?.addEventListener("change", (ev) => {
    const input = ev.currentTarget;
    if (input.files && input.files.length > 0) {
      stageFiles(Array.from(input.files));
      input.value = "";
    }
  });
  $("#dz-next")?.addEventListener("click", submitStagedUpload);

  const dz = $("#dropzone");
  if (dz) {
    ["dragenter", "dragover"].forEach((e) =>
      dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("drag"); }),
    );
    ["dragleave", "drop"].forEach((e) =>
      dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove("drag"); }),
    );
    dz.addEventListener("drop", (ev) => {
      const files = ev.dataTransfer?.files;
      if (!files || files.length === 0) return;
      stageFiles(Array.from(files));
    });
  }

  $("#error-reset").addEventListener("click", () => { showNav("overview"); });
  $("#run-again")?.addEventListener("click", () => {
    uploadSubmittedOnce = false;
    clearStaging();
    const fi = $('input[name="bill"]'); if (fi) fi.value = "";
    showNav("overview");
  });

  // Review view: approve, ask, view-bill
  $("#review-approve-btn")?.addEventListener("click", approveAndRun);
  // Delegated dismiss + restore handlers for the opportunities list.
  // List items are rebuilt on every render, so we bind to the static <ul>.
  $("#opps-list")?.addEventListener("click", (ev) => {
    if (!oppsState) return;
    const dismissBtn = ev.target.closest(".opp-dismiss");
    if (dismissBtn) {
      const li = dismissBtn.closest(".opp-item");
      const oppId = li?.dataset?.oppId;
      if (!oppId) return;
      oppsState.dismissed.add(oppId);
      saveDismissedOpps(oppsState.runId, oppsState.dismissed);
      renderOpportunities();
      return;
    }
    const restoreBtn = ev.target.closest(".opp-restore");
    if (restoreBtn) {
      oppsState.dismissed.clear();
      saveDismissedOpps(oppsState.runId, oppsState.dismissed);
      renderOpportunities();
    }
  });
  // The review view has a single unified chat panel (plan-chat). Q&A is
  // folded into it — the routing brain figures out whether the message is
  // a question or a plan edit. We bind both `submit` (Enter key + button
  // click) AND a direct click on the send button as a safety net — some
  // browsers (and form-fill extensions) intercept submit events and our
  // chat would silently no-op.
  $("#review-plan-chat-form")?.addEventListener("submit", (ev) => { ev.preventDefault(); submitPlanMessage(); });
  $("#review-plan-chat-form button")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    submitPlanMessage();
  });
  // Belt-and-suspenders: also fire on Enter in the input. Modern browsers
  // already do this via form-submit, but if the form's submit event is
  // ever blocked, the keypress fallback keeps the chat usable.
  $("#review-plan-chat-input")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      submitPlanMessage();
    }
  });
  $("#review-view-bill-btn")?.addEventListener("click", () => {
    if (reviewState?.run_id) openBillViewer(reviewState.run_id);
  });
  $("#bill-viewer-close")?.addEventListener("click", closeBillViewer);
  $("#bill-viewer-scrim")?.addEventListener("click", closeBillViewer);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("#bill-viewer").hidden) closeBillViewer();
  });

  for (const tab of $$(".tab")) {
    tab.addEventListener("click", () => {
      for (const t of $$(".tab")) t.classList.remove("active");
      for (const p of $$(".tab-panel")) p.classList.remove("active");
      tab.classList.add("active");
      $(`#tab-${tab.dataset.tab}`).classList.add("active");
    });
  }

  // Pre-load history for Bills count badge + approvals
  await loadHistory();
  updateNavCounts();
  renderAttentionList();
  loadReceipts();

  // Default view
  showNav("overview");
}

let receiptsCache = null;
async function loadReceipts() {
  try {
    receiptsCache = await apiFetch("/api/receipts").then((r) => r.json());
  } catch {
    receiptsCache = { rows: [], total_saved: 0, count: 0 };
  }
  renderReceipts();
  return receiptsCache;
}

function fmtDollars(n) {
  if (n == null || !Number.isFinite(Number(n))) return "$0";
  const num = Number(n);
  return "$" + Math.round(num).toLocaleString("en-US");
}

function renderReceipts() {
  const block = document.getElementById("receipts-block");
  const totalEl = document.getElementById("receipts-total");
  const countEl = document.getElementById("receipts-count");
  const subEl = document.getElementById("receipts-sub");
  const rowsEl = document.getElementById("receipts-rows");
  if (!block || !totalEl || !rowsEl) return;
  const data = receiptsCache ?? { rows: [], total_saved: 0, count: 0 };
  if (!data.rows || data.rows.length === 0) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  totalEl.textContent = fmtDollars(data.total_saved);
  if (countEl) countEl.textContent = String(data.count);
  if (subEl) {
    subEl.innerHTML =
      'Across <span id="receipts-count">' +
      String(data.count) +
      "</span> bill" +
      (data.count === 1 ? "" : "s");
  }
  // Show top 5 most recent.
  const top = data.rows.slice(0, 5);
  rowsEl.innerHTML = top
    .map((r) => {
      const provider = r.provider_name || r.name;
      const dos = r.date_of_service ? " · " + r.date_of_service : "";
      const channel = (r.channel_used || "—").toString();
      const channelTag =
        '<span class="receipt-channel">' + channel + "</span>";
      const quote = r.source_quote
        ? '<div class="receipt-quote">“' +
          escapeHtml(r.source_quote.length > 120 ? r.source_quote.slice(0, 117) + "…" : r.source_quote) +
          "”</div>"
        : "";
      return (
        '<div class="receipt-row">' +
        '<div><div class="receipt-provider">' +
        escapeHtml(provider) +
        "</div>" +
        '<div class="receipt-meta">' +
        escapeHtml((r.outcome || "resolved").replace(/_/g, " ")) +
        dos +
        "</div></div>" +
        '<div class="receipt-saved">' +
        fmtDollars(clampSaved(r.patient_saved, r.original_balance)) +
        "</div>" +
        channelTag +
        quote +
        "</div>"
      );
    })
    .join("");
}

async function loadHistory() {
  try {
    historyCache = await apiFetch("/api/history").then((r) => r.json());
  } catch {
    historyCache = { audits: [], letters: [] };
  }
  // The cumulative-saved counter on the overview page is fed by the same
  // backend artifacts (out/report-*.json), so refresh it whenever history
  // refreshes — that's roughly "after anything important happened."
  loadReceipts();
  return historyCache;
}

// Nav badges are silent by default. They only light up when a real event fires —
// a bill finished negotiating, a better price was found, a bill needs approval.
// Everything already visible to the user is baseline "seen" and never counted.
function updateNavCounts() {
  const audits = historyCache?.audits ?? [];
  seedNavBaselineIfNeeded(audits);

  // Approvals: escalated audits the user has not yet acknowledged.
  const pendingApprovals = audits.filter(
    (a) => a.outcome === "escalated" && !approvalSeen(a.name),
  ).length;
  setNavCount("#nav-approval-count", pendingApprovals);

  // Bills badge: only count *real* attention states — escalated, paused,
  // agent error, verify-outcome. The "awaiting your approval" state is
  // NOT a notification — the user just audited the bill and is staring
  // at the plan-review screen; surfacing a sidebar badge while they're
  // mid-flow is noise. The "Awaiting" chip still appears on the bill
  // row itself for the case where they navigate away and come back.
  const NOTIFY_KEYS = new Set(["error", "paused", "escalated", "verify_outcome"]);
  const auditsInAttention = audits.filter((a) => {
    const r = attentionReason(a);
    return r && NOTIFY_KEYS.has(r.key);
  }).length;
  const hiddenMocks = getHiddenMocks();
  const mocksInAttention = MOCK_RECURRING_BILLS.filter(
    (b) => !hiddenMocks.has(b.id) && b.attentionReason && NOTIFY_KEYS.has(b.attentionReason.key),
  ).length;
  setNavCount("#nav-bills-count", auditsInAttention + mocksInAttention);

  // Offers: recommended offers that weren't in the baseline at first load.
  const newOffers = MOCK_OFFERS.filter((o) => o.recommended && !offerSeen(o.id)).length;
  setNavCount("#nav-offers-count", newOffers);
}

function setNavCount(sel, n) {
  const el = $(sel);
  if (!el) return;
  if (n > 0) {
    el.hidden = false;
    el.textContent = String(n);
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

// On first ever app load, treat everything currently present as "already seen" so
// the nav starts quiet. After this baseline, any new audit outcome or new offer
// that appears will show up as a real badge until the user visits that tab.
function seedNavBaselineIfNeeded(audits) {
  if (localStorage.getItem("bonsai.seenBills") === null) {
    const finishedNames = audits
      .filter((a) => a.outcome === "resolved" || a.outcome === "escalated")
      .map((a) => a.name);
    localStorage.setItem("bonsai.seenBills", JSON.stringify(finishedNames));
  }
  if (localStorage.getItem("bonsai.seenOffers") === null) {
    localStorage.setItem(
      "bonsai.seenOffers",
      JSON.stringify(MOCK_OFFERS.filter((o) => o.recommended).map((o) => o.id)),
    );
  }
  if (localStorage.getItem("bonsai.seenApprovals") === null) {
    const escalated = audits.filter((a) => a.outcome === "escalated").map((a) => a.name);
    localStorage.setItem("bonsai.seenApprovals", JSON.stringify(escalated));
  }
}

function readSeenSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]")); }
  catch { return new Set(); }
}
function billSeen(name) { return readSeenSet("bonsai.seenBills").has(name); }
function offerSeen(id) { return readSeenSet("bonsai.seenOffers").has(id); }
function approvalSeen(name) { return readSeenSet("bonsai.seenApprovals").has(name); }

function markBillsSeen() {
  try {
    const audits = historyCache?.audits ?? [];
    const names = audits
      .filter((a) => a.outcome === "resolved" || a.outcome === "escalated")
      .map((a) => a.name);
    localStorage.setItem("bonsai.seenBills", JSON.stringify(names));
  } catch {}
}

function markOffersSeen() {
  try {
    localStorage.setItem(
      "bonsai.seenOffers",
      JSON.stringify(MOCK_OFFERS.filter((o) => o.recommended).map((o) => o.id)),
    );
  } catch {}
}

function markApprovalsSeen() {
  try {
    const audits = historyCache?.audits ?? [];
    const names = audits.filter((a) => a.outcome === "escalated").map((a) => a.name);
    localStorage.setItem("bonsai.seenApprovals", JSON.stringify(names));
  } catch {}
}

async function runAndRender(fn) {
  setWorkflowView("progress");
  updatePageHeader({
    eyebrow: "Run in progress",
    title: "Auditing the bill &amp; running grounded negotiation",
  });
  startTimeline();
  try {
    const report = await fn();
    stopTimeline();
    render(report);
    setWorkflowView("results");
    // Refresh history so the new audit lands in Bills
    await loadHistory();
    updateNavCounts();
  } catch (err) {
    stopTimeline();
    $("#error-body").textContent = String(err?.message ?? err);
    setWorkflowView("error");
  }
}

// ─── Phased run: audit → review → approve → negotiate ────────────

let reviewState = null; // { run_id, partial_report }

// Opportunities panel state. Total "predicted to save" is derived from
// `all` minus `dismissed` so the headline tracks the user's choices.
// { runId, all, cap, dismissed: Set<oppId>, report }
let oppsState = null;

const OPPS_PROBABILITY_FLOOR = 0.5;
const oppsDismissKey = (runId) => `bonsai.opps.dismissed.${runId}`;
const passesOppProbability = (o) =>
  typeof o.probability === "number" && Number.isFinite(o.probability) && o.probability >= OPPS_PROBABILITY_FLOOR;

function loadDismissedOpps(runId) {
  try {
    return new Set(JSON.parse(localStorage.getItem(oppsDismissKey(runId)) ?? "[]"));
  } catch {
    return new Set();
  }
}
function saveDismissedOpps(runId, set) {
  try {
    localStorage.setItem(oppsDismissKey(runId), JSON.stringify([...set]));
  } catch {}
}

// Complaint chat history for the right-column advisory chat. Lives only in
// memory because no PendingRun exists yet — we send the full history on
// every turn so /api/complaint/chat can stay stateless.
let complaintChatHistory = [];

function openComplaintView() {
  const errEl = $("#complaint-error");
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  setWorkflowView("complaint");
  updatePageHeader({
    eyebrow: "Negotiate",
    title: "Tell Bonsai what happened",
  });
  setTimeout(() => $("#complaint-company")?.focus(), 50);
}

function clearComplaintInputs() {
  const company = $("#complaint-company");
  const desc = $("#complaint-description");
  const desired = $("#complaint-desired");
  if (company) company.value = "";
  if (desc) desc.value = "";
  if (desired) desired.value = "";
  const email = $("#complaint-contact-email");
  const phone = $("#complaint-contact-phone");
  if (email) email.value = "";
  if (phone) phone.value = "";
  const errEl = $("#complaint-error");
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  const chatLog = $("#complaint-chat-log");
  if (chatLog) chatLog.innerHTML = "";
  complaintChatHistory = [];
}

async function submitComplaintChat() {
  const input = $("#complaint-chat-input");
  const msg = input?.value?.trim() ?? "";
  if (!msg) return;
  const log = $("#complaint-chat-log");
  if (!log) return;
  const company = $("#complaint-company")?.value?.trim() ?? "";
  const description = $("#complaint-description")?.value?.trim() ?? "";
  const desired = $("#complaint-desired")?.value?.trim() ?? "";

  const qDiv = document.createElement("div");
  qDiv.className = "qa-msg q";
  qDiv.innerHTML = `<div class="qa-role">You</div><div class="qa-body"></div>`;
  qDiv.querySelector(".qa-body").textContent = msg;
  log.appendChild(qDiv);
  input.value = "";
  input.disabled = true;
  const btn = $("#complaint-chat-form button");
  if (btn) btn.disabled = true;
  const thinking = document.createElement("div");
  thinking.className = "qa-msg a";
  thinking.innerHTML = `<div class="qa-role">Bonsai</div><div class="qa-body"><span class="dots"><span></span><span></span><span></span></span></div>`;
  log.appendChild(thinking);
  log.scrollTop = log.scrollHeight;

  try {
    const res = await apiFetch("/api/complaint/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        company,
        description,
        desired_outcome: desired,
        history: complaintChatHistory,
        message: msg,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { reply } = await res.json();
    thinking.querySelector(".qa-body").textContent = reply;
    complaintChatHistory.push({ role: "user", body: msg });
    complaintChatHistory.push({ role: "assistant", body: reply });
  } catch (err) {
    thinking.querySelector(".qa-body").textContent = `Error: ${err?.message ?? err}`;
    thinking.classList.add("error");
  } finally {
    input.disabled = false;
    if (btn) btn.disabled = false;
    input.focus();
    log.scrollTop = log.scrollHeight;
  }
}

// One-click flow: draft the complaint, save the user-typed contact, kick
// off negotiation, and route the user to Bills. Mirrors the multi-step
// bill flow but runs all three calls inline since there's no review step.
async function submitComplaint() {
  const company = $("#complaint-company")?.value?.trim() ?? "";
  const description = $("#complaint-description")?.value?.trim() ?? "";
  const desired = $("#complaint-desired")?.value?.trim() ?? "";
  const email = $("#complaint-contact-email")?.value?.trim() ?? "";
  const phone = $("#complaint-contact-phone")?.value?.trim() ?? "";
  const errEl = $("#complaint-error");
  const submitBtn = $("#complaint-submit");
  if (!company || !description) {
    errEl.textContent = "Company name and what happened are both required.";
    errEl.hidden = false;
    return;
  }
  if (!email && !phone) {
    errEl.textContent = "Add a customer-support email or phone so Bonsai knows where to reach out.";
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending to Bonsai…";
  // Single POST — server creates the run + status=negotiating immediately,
  // then drafts the letter and sends the email in the background. The user
  // is on Bills before any of that completes.
  try {
    const res = await apiFetch("/api/complaint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        company,
        description,
        desired_outcome: desired,
        support_email: email || null,
        support_phone: phone || null,
      }),
    });
    if (!res.ok) throw new Error(await res.text());

    clearComplaintInputs();
    // Reset workflow state so the nav guard doesn't prompt on the way out.
    setWorkflowView("overview");
    reviewState = null;
    await loadHistory();
    updateNavCounts();
    await showNav("bills");
  } catch (err) {
    $("#error-body").textContent = String(err?.message ?? err);
    setWorkflowView("error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Accept & negotiate";
  }
}

async function runPhasedFromSample(fixture, channel) {
  setWorkflowView("progress");
  updatePageHeader({
    eyebrow: "Audit in progress",
    title: "Reading the bill &amp; finding every overcharge",
  });
  startTimeline();
  // Cached fixtures return in ~20ms — too fast to show what Bonsai is
  // doing. Hold the loading view for ~1.5s so the user actually sees
  // the timeline animate. Real uploads (which are slow on their own)
  // skip past this minimum because the audit response takes longer.
  const startedAt = Date.now();
  const MIN_LOADING_MS = 1500;
  try {
    const res = await apiFetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixture, channel }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { run_id, report } = await res.json();
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_LOADING_MS) {
      await new Promise((r) => setTimeout(r, MIN_LOADING_MS - elapsed));
    }
    stopTimeline();
    reviewState = { run_id, partial_report: report };
    renderReviewView(report);
    setWorkflowView("review");
  } catch (err) {
    stopTimeline();
    $("#error-body").textContent = String(err?.message ?? err);
    setWorkflowView("error");
  }
}

async function runPhasedFromUpload(formData) {
  setWorkflowView("progress");
  updatePageHeader({
    eyebrow: "Audit in progress",
    title: "Reading the bill &amp; finding every overcharge",
  });
  startTimeline();
  try {
    const res = await apiFetch("/api/audit", { method: "POST", body: formData });
    if (!res.ok) throw new Error(await res.text());
    const { run_id, report } = await res.json();
    stopTimeline();
    reviewState = { run_id, partial_report: report };
    renderReviewView(report);
    setWorkflowView("review");
  } catch (err) {
    stopTimeline();
    $("#error-body").textContent = String(err?.message ?? err);
    setWorkflowView("error");
  }
}

// Resume a speculative audit kicked off when files were dropped. If the
// audit already finished, this hand-off is near-instant. If it's still in
// flight, the progress view animates while we await it.
async function runPhasedFromPrefetch(promise) {
  setWorkflowView("progress");
  updatePageHeader({
    eyebrow: "Audit in progress",
    title: "Reading the bill &amp; finding every overcharge",
  });
  startTimeline();
  try {
    const data = await promise;
    if (!data || data.__error) throw data?.__error ?? new Error("Audit cancelled");
    const { run_id, report } = data;
    stopTimeline();
    reviewState = { run_id, partial_report: report };
    renderReviewView(report);
    setWorkflowView("review");
  } catch (err) {
    stopTimeline();
    $("#error-body").textContent = String(err?.message ?? err);
    setWorkflowView("error");
  }
}

function renderReviewView(report) {
  const { analyzer, summary } = report;
  const provider = analyzer.metadata?.provider_name ?? "the provider";

  $("#review-title").textContent = "Reading the angles on this bill…";
  $("#review-sub").textContent = `${provider}. Original ${fmt$2(summary.original_balance ?? 0)}. Accept the plan or chat with Bonsai below to customize.`;

  renderReceipt(report);
  renderOpportunitiesSkeleton();

  // Reset chat state.
  $("#review-plan-chat-log").innerHTML = "";
  $("#review-plan-chat-input").value = "";

  // Fetch bill-specific strategies from the server. Falls back to the
  // synthesized list if the endpoint errors — the demo should never show
  // an empty opportunities panel.
  void loadOpportunities(report);

  // Surface the provider-contact card and start polling. The card lives
  // outside this fn so it survives chat re-renders.
  void initContactCard();
}

let contactPollTimer = null;

function initContactCard() {
  if (contactPollTimer) { clearInterval(contactPollTimer); contactPollTimer = null; }
  const card = $("#contact-card");
  if (!card) return;
  card.hidden = false;
  $("#contact-title").textContent = "Looking up the billing contact…";
  $("#contact-email").value = "";
  $("#contact-phone").value = "";
  attachPhoneFormatter($("#contact-phone"));
  $("#contact-notes").textContent = "";
  $("#contact-sources").innerHTML = "";

  // Wire actions once. Re-binding is harmless — these handlers reference
  // the live reviewState run_id at click time, not at bind time.
  if (!card.dataset.bound) {
    card.dataset.bound = "1";
    // Save button still works for users who explicitly want to confirm,
    // but typing now auto-saves so most won't need it.
    $("#contact-save")?.addEventListener("click", saveContactOverride);
    const onEdit = () => {
      // Clear the "needs input" highlight on first keystroke.
      card.classList.remove("needs-input");
      // Schedule a debounced save — typing IS the save.
      scheduleContactAutosave();
    };
    $("#contact-email")?.addEventListener("input", onEdit);
    $("#contact-phone")?.addEventListener("input", onEdit);
  }
  pollContactStatus();
  contactPollTimer = setInterval(pollContactStatus, 2500);
}

async function pollContactStatus() {
  const runId = reviewState?.run_id;
  if (!runId) return;
  let data;
  try {
    const res = await apiFetch(`/api/contact/${encodeURIComponent(runId)}`);
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }
  if (reviewState?.run_id !== runId) return;
  // Stash the real provider_name so save / re-render can pass it through
  // instead of having to read the (mutated) title element.
  if (data.provider_name) reviewState.provider_name = data.provider_name;
  applyContactStatus(data);
  if (data.status === "resolved" || data.status === "failed") {
    if (contactPollTimer) { clearInterval(contactPollTimer); contactPollTimer = null; }
  }
}

/**
 * "Customer support" or "billing department"? Medical bills always route
 * to a billing department; everything else (telecom, utility, subscription,
 * insurance, etc.) is customer support. Falls back to "customer support"
 * when the kind is unknown — safer default since most consumer bills have
 * a CS line.
 */
function contactRoleNoun(billKind) {
  return billKind === "medical" ? "billing department" : "customer support";
}

function applyContactStatus(data) {
  const titleEl = $("#contact-title");
  const notesEl = $("#contact-notes");
  const srcEl = $("#contact-sources");
  const emailEl = $("#contact-email");
  const phoneEl = $("#contact-phone");
  const card = document.getElementById("contact-card");
  const billKind =
    reviewState?.partial_report?.analyzer?.metadata?.bill_kind ?? "other";
  const role = contactRoleNoun(billKind);

  // Default-clear the "needs input" highlight every render. The only
  // place we add it is the click handler in approveAndRun (when the
  // user tries to accept with both fields empty). Any successful
  // poll/save lands a contact, which means we can drop the highlight.
  card?.classList.remove("needs-input");

  if (data.status === "pending") {
    titleEl.textContent = `Looking up the ${role} contact…`;
    return;
  }
  if (data.status === "failed") {
    titleEl.textContent = `Add a ${role} contact`;
    notesEl.textContent =
      data.error ??
      `Bonsai couldn't find one. Add an email or phone for the ${role} below — either is fine, email preferred when available.`;
    return;
  }
  const c = data.contact ?? {};
  // "Resolved with nothing useful" is functionally the same as "failed".
  // Don't show empty fields with prefilled noise; ask the user to fill in.
  // The .needs-input highlight is NOT applied on render — only when the
  // user tries to Accept the plan with both fields empty.
  const provider = data.provider_name ?? "this provider";
  // confidence:"none" is the explicit "lookup failed or returned garbage"
  // signal from src/lib/provider-contact.ts (timeout, no tool result, or
  // low-confidence with no email/phone). Prompt the user to paste from
  // their bill — keep the email + phone inputs editable so autosave + the
  // Approve auto-save round-trip continue to work.
  if (c.confidence === "none" || (!c.email && !c.phone)) {
    titleEl.textContent = `Add a ${role} contact for ${provider}`;
    notesEl.textContent =
      `We couldn't find this provider's ${role} email — paste it from your bill.`;
    // Never wipe a non-empty value the user has already typed. The poll
    // runs every 2.5s; if it lands while focus is on a different element
    // (e.g. the Approve button the user is about to click), wiping here
    // would erase their input and the front-end gate would fire as if
    // they hadn't typed anything.
    if (document.activeElement !== emailEl && !emailEl.value) emailEl.value = "";
    if (document.activeElement !== phoneEl && !phoneEl.value) phoneEl.value = "";
    srcEl.innerHTML = "";
    return;
  }
  titleEl.textContent = data.provider_name
    ? `${data.provider_name} — ${role}`
    : `${role.charAt(0).toUpperCase()}${role.slice(1)} contact`;
  // Don't blow away the user's typing if they're already editing.
  if (document.activeElement !== emailEl) emailEl.value = c.email ?? "";
  if (document.activeElement !== phoneEl) phoneEl.value = c.phone ?? "";
  notesEl.textContent = c.notes ?? "";
  srcEl.innerHTML = "";
  for (const url of (c.source_urls ?? []).slice(0, 4)) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    try { a.textContent = new URL(url).hostname; } catch { a.textContent = url; }
    srcEl.appendChild(a);
  }
}

async function saveContactOverride() {
  const runId = reviewState?.run_id;
  if (!runId) return;
  const email = $("#contact-email").value.trim();
  const phone = $("#contact-phone").value.trim();
  // No-op when both fields are empty — avoids POSTing nulls on every
  // backspace once the user clears the inputs to retype.
  if (!email && !phone) return;
  const status = $("#contact-save-status");
  if (status) {
    status.textContent = "Saving…";
    status.className = "contact-save-status pending";
  }
  try {
    const res = await apiFetch("/api/contact/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ run_id: runId, email, phone }),
    });
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    applyContactStatus({ status: "resolved", contact: j.contact, provider_name: reviewState?.provider_name ?? null });
    if (status) {
      status.textContent = "Saved ✓";
      status.className = "contact-save-status ok";
      setTimeout(() => {
        if (status.textContent === "Saved ✓") {
          status.textContent = "";
          status.className = "contact-save-status";
        }
      }, 2500);
    }
  } catch (err) {
    console.warn("[contact] save failed", err);
    if (status) {
      status.textContent = "Couldn't save — try again";
      status.className = "contact-save-status err";
    }
  }
}

/**
 * Debounced auto-save for the contact card. Fires ~700ms after the user
 * stops typing. The user no longer needs to hit "Save" — typing IS the
 * save action. We still keep saveContactOverride callable explicitly
 * (e.g., on Approve auto-save) because the debounce is async-safe.
 */
let contactAutosaveTimer = null;
function scheduleContactAutosave() {
  if (contactAutosaveTimer) clearTimeout(contactAutosaveTimer);
  contactAutosaveTimer = setTimeout(() => {
    contactAutosaveTimer = null;
    void saveContactOverride();
  }, 700);
}

async function loadOpportunities(report) {
  const runId = reviewState?.run_id;
  if (!runId) return;
  try {
    const res = await apiFetch("/api/opportunities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { opportunities } = await res.json();
    // Guard: if the current reviewState has moved on, bail.
    if (reviewState?.run_id !== runId) return;
    // Belt-and-braces: server already gates by probability, but if a
    // stray low-probability item slips through we still drop it here.
    const gated = (opportunities ?? []).filter(passesOppProbability);
    const normalized = gated.map((o, i) => ({
      opp_id: typeof o.opp_id === "string" && o.opp_id.length > 0 ? o.opp_id : `opp-${i}`,
      icon: ICONS[o.icon] ?? ICONS.pulse,
      title: o.title,
      desc: o.description,
      estimate: Number(o.dollar_estimate) || 0,
      probability: o.probability,
    }));
    initOppsState(runId, normalized, report);
    renderOpportunities();
  } catch (err) {
    console.warn("[opps] falling back to synthesized", err);
    const fallback = buildOpportunities(report);
    initOppsState(runId, fallback, report);
    renderOpportunities();
  }
}

function initOppsState(runId, all, report) {
  oppsState = {
    runId,
    all,
    cap: maxSavingsCap(report),
    dismissed: loadDismissedOpps(runId),
    report,
  };
}

function providerKindLabel() {
  // Keep the headline neutral for now. Could detect category later and say
  // "this dental bill" vs "this utility bill", but the provider name in
  // the subtitle already anchors the user.
  return "bill";
}

function renderOpportunitiesSkeleton() {
  $("#opps-total").textContent = "—";
  const ul = $("#opps-list");
  ul.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const li = document.createElement("li");
    li.className = "opp-item opp-skel";
    li.innerHTML = `
      <div class="opp-icon opp-skel-bar"></div>
      <div class="opp-body">
        <div class="opp-title opp-skel-bar" style="width:55%"></div>
        <div class="opp-desc opp-skel-bar" style="width:90%;margin-top:6px"></div>
      </div>
      <div class="opp-amount opp-skel-bar" style="width:40px"></div>`;
    ul.appendChild(li);
  }
}

/* ─── Receipt (left panel) ─────────────────────────────────────────── */

function renderReceipt(report) {
  const { analyzer, summary } = report;
  const meta = analyzer.metadata ?? {};
  const items = deriveReceiptItems(report);

  $("#receipt-provider").textContent = meta.provider_name ?? "Unknown provider";
  const metaBits = [
    meta.patient_name ? `For ${meta.patient_name}` : null,
    meta.date_of_service ? `Dated ${meta.date_of_service}` : null,
    meta.claim_number ? `Claim ${meta.claim_number}` : null,
  ].filter(Boolean);
  $("#receipt-meta").textContent = metaBits.join(" · ") || "—";

  const ul = $("#receipt-items");
  ul.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "receipt-empty";
    li.textContent = "No itemized line items detected. Totals below are from the summary section of the bill.";
    ul.appendChild(li);
  } else {
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "receipt-item";
      li.innerHTML = `
        <span class="receipt-item-label">${escapeHtml(it.label)}${it.detail ? `<span class="receipt-item-detail">${escapeHtml(it.detail)}</span>` : ""}</span>
        <span class="receipt-item-amt">${fmt$2(it.amount)}</span>`;
      ul.appendChild(li);
    }
  }

  // Totals block — show the structure the user expects.
  const totalsEl = $("#receipt-totals");
  const original = summary.original_balance ?? 0;
  const insurancePaid = (meta.eob_total_plan_paid ?? null);
  const patientOwes = (meta.eob_patient_responsibility ?? meta.bill_current_balance_due ?? summary.original_balance ?? null);
  const lines = [];
  lines.push(`<div class="receipt-total-line"><span>Total charges</span><span>${fmt$2(original)}</span></div>`);
  if (insurancePaid != null && insurancePaid > 0) {
    lines.push(`<div class="receipt-total-line"><span>Insurance paid</span><span class="minus">− ${fmt$2(insurancePaid)}</span></div>`);
  }
  if (patientOwes != null) {
    lines.push(`<div class="receipt-total-line receipt-total-due"><span>You owe</span><span>${fmt$2(patientOwes)}</span></div>`);
  }
  totalsEl.innerHTML = lines.join("");
}

/**
 * Best-effort line items from whatever the analyzer pulled out. For medical
 * bills with an itemized section this comes from `analyzer.metadata.line_items`
 * or similar; we fall back to synthesizing rows from the flagged findings
 * (at least the user sees the lines Bonsai cares about).
 */
function deriveReceiptItems(report) {
  const meta = report.analyzer?.metadata ?? {};
  // Prefer a real itemized list if the analyzer returned one.
  if (Array.isArray(meta.line_items) && meta.line_items.length > 0) {
    return meta.line_items
      .filter((li) => li && typeof li.amount === "number")
      .map((li) => ({
        label: li.label ?? li.description ?? li.cpt_code ?? "Line item",
        detail: li.cpt_code && li.label ? `Code ${li.cpt_code}` : (li.date ?? null),
        amount: li.amount,
      }));
  }
  // Fallback: surface each flagged finding as a row so at least the trouble
  // lines are visible with amounts. Good enough for the MVP.
  const errors = report.analyzer?.errors ?? [];
  return errors.slice(0, 12).map((e) => {
    const firstLine = (e.line_quote ?? "").split("\n")[0].trim();
    return {
      label: firstLine.slice(0, 70) || e.error_type,
      detail: e.cpt_code ? `Code ${e.cpt_code}` : e.error_type,
      amount: e.dollar_impact ?? 0,
    };
  });
}

/* ─── Opportunities (right panel) ──────────────────────────────────── */

function renderOpportunities() {
  if (!oppsState) return;
  const { all, cap, dismissed, report } = oppsState;
  const visible = all.filter((o) => !dismissed.has(o.opp_id));
  // Estimates may overlap (multiple strategies all chip at the same
  // defensible amount), and savings can't exceed what the user owes.
  // Clamp to the cap so the headline never goes north of their bill.
  const rawTotal = visible.reduce((s, o) => s + (o.estimate ?? 0), 0);
  const total = clampSaved(rawTotal, cap);

  $("#opps-total").textContent = total > 0 ? fmt$(total) : "—";

  const provider = report?.analyzer?.metadata?.provider_name ?? "the provider";
  const titleEl = $("#review-title");
  if (titleEl) {
    titleEl.textContent = total > 0
      ? `We think we can save you ${fmt$(total)} on this ${providerKindLabel(report)}.`
      : "Bill reviewed — a few angles to try.";
  }
  const subEl = $("#review-sub");
  if (subEl && report) {
    subEl.textContent = `${provider}. Original ${fmt$2(report.summary?.original_balance ?? 0)}. Accept the plan or chat with Bonsai below to customize.`;
  }

  const ul = $("#opps-list");
  ul.innerHTML = "";
  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "opp-empty";
    li.textContent = dismissed.size > 0
      ? "All opportunities dismissed."
      : "No clear savings angles on this one — the provider seems to be charging fairly. We'll still try a prompt-pay ask.";
    ul.appendChild(li);
  } else {
    for (const o of visible) {
      const li = document.createElement("li");
      li.className = "opp-item";
      li.dataset.oppId = o.opp_id;
      li.innerHTML = `
        <div class="opp-icon">${o.icon ?? ICONS.pulse}</div>
        <div class="opp-body">
          <div class="opp-title">${escapeHtml(o.title)}</div>
          <div class="opp-desc">${escapeHtml(o.desc)}</div>
        </div>
        <div class="opp-amount">${o.estimate > 0 ? fmt$(o.estimate) : "—"}</div>
        <button type="button" class="opp-dismiss" aria-label="Dismiss opportunity">×</button>`;
      ul.appendChild(li);
    }
  }

  if (dismissed.size > 0) {
    const li = document.createElement("li");
    li.className = "opp-undo";
    li.innerHTML = `<button type="button" class="opp-restore">Show ${dismissed.size} dismissed</button>`;
    ul.appendChild(li);
  }
}

// Bill kinds where T&C language tends to be a meaningful negotiation
// surface (statements with explicit policy text, late-fee schedules,
// good-faith estimates, etc.).
const TNC_BILL_KINDS = new Set(["telecom", "utility", "subscription", "insurance", "financial"]);
// Bill kinds where a competing provider exists and a switch threat is
// plausible. Medical/financial/legal are typically single-provider per
// encounter — a "competitor offer" lever is meaningless there.
const COMPETITOR_BILL_KINDS = new Set(["telecom", "utility", "subscription", "insurance"]);

const TNC_LANGUAGE_RE = /\b(policy|terms|late\s*fee|good[\s-]faith|charity\s*care|itemization|surcharge|waiver|liable|indemnif)/i;

function shouldShowTncLever(report) {
  const billKind = report?.analyzer?.metadata?.bill_kind;
  if (TNC_BILL_KINDS.has(billKind)) return true;
  // Otherwise, only include if the analyzer surfaced policy/T&C language
  // in any of its findings. "When in doubt, skip."
  const errors = report?.analyzer?.errors ?? [];
  return errors.some((e) => TNC_LANGUAGE_RE.test(`${e.evidence ?? ""} ${e.line_quote ?? ""}`));
}

function shouldShowCompetitorLever(report) {
  return COMPETITOR_BILL_KINDS.has(report?.analyzer?.metadata?.bill_kind);
}

/**
 * Synthesize a list of strategies to lower this bill with dollar estimates.
 * Pulls from analyzer findings where available, then layers on universal
 * levers (prompt-pay, competitor threat, financial hardship) so the user
 * always sees multiple angles — not just billing errors. Each item carries
 * a probability so it travels through the same gate as server-sourced opps.
 */
function buildOpportunities(report) {
  const out = [];
  const summary = report.summary ?? {};
  const analyzer = report.analyzer ?? {};
  const defensible = summary.defensible_disputed ?? 0;
  const original = summary.original_balance ?? 0;
  const remainingAfterDispute = Math.max(0, original - defensible);
  const high = (analyzer.errors ?? []).filter((e) => e.confidence === "high");
  const worth = (analyzer.errors ?? []).filter((e) => e.confidence === "worth_reviewing");

  // 1. Grounded billing errors (highest-signal)
  if (high.length > 0 && defensible > 0) {
    out.push({
      opp_id: "dispute-high-confidence-errors",
      icon: ICONS.shield,
      title: `Dispute ${high.length} billing error${high.length === 1 ? "" : "s"}`,
      desc: "Grounded citations against the bill. Duplicates, denied services, and balance-billing overlap all defensible on paper.",
      estimate: defensible,
      probability: 0.85,
    });
  }

  // 2. Worth-reviewing items — lower confidence but worth surfacing
  if (worth.length > 0) {
    const worthTotal = worth.reduce((s, e) => s + (e.dollar_impact ?? 0), 0);
    out.push({
      opp_id: "challenge-worth-reviewing",
      icon: ICONS.scan,
      title: `Challenge ${worth.length} questionable charge${worth.length === 1 ? "" : "s"}`,
      desc: "Unbundling, markup, and other soft flags. Lower win rate, but often negotiable.",
      estimate: Math.round(worthTotal * 0.5),
      probability: 0.55,
    });
  }

  // 3. Prompt-pay / negotiate the remaining balance
  if (remainingAfterDispute > 200) {
    const estimate = Math.round(remainingAfterDispute * 0.15);
    out.push({
      opp_id: "negotiate-prompt-pay",
      icon: ICONS.pulse,
      title: "Negotiate the remaining balance",
      desc: "Ask for a prompt-pay discount (10–20% is typical) and a single-settlement write-off on whatever's left.",
      estimate,
      probability: 0.7,
    });
  }

  // 4. Terms & loopholes — only when the bill has visible T&C language or
  // is a category whose statements typically expose negotiable policy.
  if (shouldShowTncLever(report)) {
    out.push({
      opp_id: "hunt-tnc-loopholes",
      icon: ICONS.doc,
      title: "Hunt for T&C loopholes",
      desc: "Review the provider's own policy — late-fee caps, good-faith-estimate discrepancies (No Surprises Act), charity care thresholds, or hidden itemization rules.",
      estimate: Math.round(original * 0.05),
      probability: 0.55,
    });
  }

  // 5. Competitor leverage — only for bill kinds where a switch threat is
  // real (telecom / utility / subscription / insurance). Skips medical
  // and one-off bills where there's no competing provider to switch to.
  if (shouldShowCompetitorLever(report)) {
    out.push({
      opp_id: "leverage-competitor-offer",
      icon: ICONS.phone,
      title: "Leverage a competitor offer",
      desc: "If there's a cheaper provider or a cancel-threat angle (subscriptions, utilities, pet insurance), we use it.",
      estimate: Math.round(original * 0.08),
      probability: 0.6,
    });
  }

  return out;
}


async function submitPlanMessage() {
  if (!reviewState) {
    console.warn("[plan-chat] no reviewState — chat fired before audit completed?");
    return;
  }
  const input = $("#review-plan-chat-input");
  const msg = input?.value?.trim() ?? "";
  if (!msg) return;
  const log = $("#review-plan-chat-log");
  const qDiv = document.createElement("div");
  qDiv.className = "qa-msg q";
  qDiv.innerHTML = `<div class="qa-role">You</div><div class="qa-body"></div>`;
  qDiv.querySelector(".qa-body").textContent = msg;
  log.appendChild(qDiv);
  input.value = "";
  input.disabled = true;
  const btn = $("#review-plan-chat-form button");
  if (btn) btn.disabled = true;
  const thinking = document.createElement("div");
  thinking.className = "qa-msg a";
  thinking.innerHTML = `<div class="qa-role">Bonsai</div><div class="qa-body"><span class="dots"><span></span><span></span><span></span></span></div>`;
  log.appendChild(thinking);
  log.scrollTop = log.scrollHeight;

  try {
    const res = await apiFetch("/api/plan-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: reviewState.run_id, message: msg }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { reply, strategy } = await res.json();
    thinking.querySelector(".qa-body").textContent = reply;
    if (strategy && reviewState.partial_report) {
      // Store the new strategy on the report so approve() picks it up.
      reviewState.partial_report.strategy = strategy;
    }
    // Re-fetch opportunities so the "Opportunities to lower this bill"
    // panel reflects the user's directive. /api/opportunities reads
    // run.plan_edits (which the chat just appended to), so the next call
    // returns a tailored list. Show the skeleton during the re-fetch
    // so the user sees the panel is updating, not stale.
    renderOpportunitiesSkeleton();
    void loadOpportunities(reviewState.partial_report);
  } catch (err) {
    thinking.querySelector(".qa-body").textContent = `Error: ${err.message ?? err}`;
    thinking.classList.add("error");
  } finally {
    input.disabled = false;
    if (btn) btn.disabled = false;
    input.focus();
    log.scrollTop = log.scrollHeight;
  }
}

async function approveAndRun() {
  if (!reviewState) return;
  // Front-end contact gate — at least one of email or phone is required
  // before we even POST /api/approve. This keeps the UX local: highlight
  // the card + scroll + focus the email input, no round-trip and no
  // error toast. The server still enforces the same rule defensively.
  const emailInput = document.getElementById("contact-email");
  const phoneInput = document.getElementById("contact-phone");
  const liveEmail = emailInput?.value?.trim() || "";
  const livePhone = phoneInput?.value?.trim() || "";
  const hasEmail = !!liveEmail;
  const hasPhone = !!livePhone;
  if (!hasEmail && !hasPhone) {
    const card = document.getElementById("contact-card");
    if (card) {
      card.classList.add("needs-input");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (emailInput) setTimeout(() => emailInput.focus(), 350);
    return;
  }
  // Auto-save the contact before approve. Without this, a user who
  // typed phone (or email) into the contact card but didn't click Save
  // would land on the server's missing_contact gate — the server reads
  // the persisted `run.contact`, not the live DOM input. Auto-saving
  // here turns "type phone, click Accept" into the one-click flow the
  // user expects.
  try {
    await apiFetch("/api/contact/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        run_id: reviewState.run_id,
        email: liveEmail,
        phone: livePhone,
      }),
    });
  } catch (err) {
    console.warn("[approve] contact auto-save failed", err);
  }
  // Negotiation runs in the background. Kick it off, then hand the user
  // off to the Bills view — updates will stream in as the bg job progresses
  // (polled via /api/history).
  try {
    const res = await apiFetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: reviewState.run_id }),
    });
    if (!res.ok) {
      // Structured gates surface as in-page CTAs instead of dumping into
      // the error view. `email_not_configured` means the operator hasn't
      // wired Resend yet (503) — nothing the end user can fix; we show a
      // friendly "we're working on it" message.
      const j = await res.json().catch(() => null);
      if (j?.error === "email_not_configured") {
        showApproveBlocker({
          title: "Email delivery isn't live yet",
          body:
            j.message ??
            "Bonsai's email channel is being configured. Try again in a few minutes — your bill is saved and ready to negotiate as soon as we're live.",
          ctaLabel: "Got it",
          ctaTarget: "bills",
        });
        return;
      }
      if (j?.error === "missing_contact") {
        // Highlight the contact card right here on the review page —
        // it's the same view, no need to send the user to a different
        // tab. Scroll it into focus and pop the email input.
        const card = document.getElementById("contact-card");
        const emailInput = document.getElementById("contact-email");
        if (card) {
          card.classList.add("needs-input");
          card.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (emailInput) {
          setTimeout(() => emailInput.focus(), 350);
        }
        return;
      }
      throw new Error(j?.message ?? j?.error ?? (await res.text()));
    }
    await res.json();
    reviewState = null;
    await loadHistory();
    updateNavCounts();
    await showNav("bills");
  } catch (err) {
    $("#error-body").textContent = String(err?.message ?? err);
    setWorkflowView("error");
  }
}

// Inline blocker shown above the approve action when the server gates a
// launch (Resend not connected, no contact, etc.). Rendered into the
// review view so the user keeps their plan/findings context — no full-
// page error redirect.
function showApproveBlocker({ title, body, ctaLabel, ctaTarget }) {
  const host =
    document.getElementById("approve-blocker") ??
    (() => {
      const el = document.createElement("div");
      el.id = "approve-blocker";
      el.className = "approve-blocker";
      // Mount near the approve button in the review view if available.
      const approveBtn = document.getElementById("approve-btn");
      const parent = approveBtn?.parentElement ?? $("#view-review") ?? document.body;
      parent.insertBefore(el, approveBtn ?? null);
      return el;
    })();
  host.innerHTML = `
    <div class="approve-blocker-title">${escapeHtml(title)}</div>
    <div class="approve-blocker-body">${escapeHtml(body)}</div>
    <button type="button" class="btn btn-primary approve-blocker-cta">${escapeHtml(ctaLabel)}</button>`;
  host.hidden = false;
  host.querySelector(".approve-blocker-cta").addEventListener("click", () => {
    showNav(ctaTarget);
  });
}

function resetPageHeader() {
  if (currentNav === "overview") {
    updatePageHeader({
      eyebrow: "Home",
      title: "Agents to manage your personal expenses",
      stats: null,
    });
  } else if (currentNav === "bills") {
    updatePageHeader({
      eyebrow: "Negotiation",
      title: "Every negotiation in one place",
      stats: null,
    });
  } else if (currentNav === "offers") {
    updatePageHeader({
      eyebrow: "Offers",
      title: "Cheaper alternatives, found for you",
      stats: null,
    });
  } else if (currentNav === "settings") {
    updatePageHeader({
      eyebrow: "Settings",
      title: "Tune your agent",
      stats: null,
    });
  }
}

function updatePageHeader({ eyebrow, title, stats }) {
  if (eyebrow != null) $("#ph-eyebrow").textContent = eyebrow;
  if (title != null) $("#ph-title").innerHTML = title;
  const root = $("#ph-stats");
  root.innerHTML = "";
  if (!stats) return;
  for (const s of stats) {
    const el = document.createElement("div");
    el.innerHTML = `
      <div class="eyebrow">${s.label}</div>
      <div class="stat-val${s.tone === "green" ? " stat-green" : ""}">${s.value}</div>`;
    root.appendChild(el);
  }
}

// ─── Audit render (shared with Overview → Progress → Results) ──

function render(report) {
  const s = report.summary;
  // Clamp at the render boundary too — covers legacy reports written
  // before the orchestrator-side clamp landed.
  const clampedSaved = clampSaved(s.patient_saved, s.original_balance);
  const savedPositive = clampedSaved > 0;
  const heroTitle = $("#hero-title");
  const heroAmount = document.createElement("span");
  heroAmount.className = "hero-amount";
  heroAmount.textContent = savedPositive ? fmt$2(clampedSaved) : (s.patient_saved != null ? fmt$2(clampedSaved) : "—");
  heroTitle.classList.toggle("hero-title-muted", !savedPositive);
  heroTitle.innerHTML = "";
  if (savedPositive) heroTitle.append("Saved ");
  else if (s.outcome === "escalated") heroTitle.append("Escalated ");
  else if (s.outcome === "in_progress") heroTitle.append("In progress ");
  else heroTitle.append("Outcome ");
  heroTitle.appendChild(heroAmount);

  const heroEyebrow = $("#hero-eyebrow");
  if (savedPositive) heroEyebrow.textContent = "Outcome";
  else if (s.outcome === "escalated") heroEyebrow.textContent = "Needs a human";
  else heroEyebrow.textContent = "Result";

  $("#hero-sub").textContent = buildHeroSub(s);
  $("#stat-was").textContent = fmt$2(s.original_balance);
  $("#stat-now").textContent = fmt$2(s.final_balance);
  $("#stat-saved").textContent = savedPositive ? fmt$2(clampedSaved) : "—";
  $("#stat-channel").textContent = s.channel_used ? s.channel_used.toUpperCase() : "—";

  updatePageHeader({
    eyebrow: "Audit complete",
    title: report.analyzer.metadata.provider_name
      ? escapeHtml(report.analyzer.metadata.provider_name)
      : "Audit results",
    stats: [
      { label: "Defensible", value: fmt$2(report.analyzer.summary.high_confidence_total), tone: "green" },
      { label: "Findings", value: String(report.analyzer.errors.length) },
      { label: "Channel", value: (s.channel_used ?? "—").toUpperCase() },
    ],
  });

  renderFindings(report.analyzer);
  renderLetter(report.analyzer.metadata, report.appeal.markdown);
  renderConversation(report);
  $("#raw-json").textContent = JSON.stringify(report, null, 2);
}

function buildHeroSub(s) {
  if (typeof s.patient_saved === "number" && s.patient_saved > 0) {
    return `Bonsai took ${fmt$2(s.original_balance)} down to ${fmt$2(s.final_balance)} over ${s.channel_used}. ${s.outcome_detail}`;
  }
  return s.outcome_detail || "No negotiation outcome yet.";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function errorTypeLabel(t) { return t.replace(/_/g, " "); }

function renderFindings(analyzer) {
  const root = $("#findings-list");
  root.innerHTML = "";
  const high  = analyzer.errors.filter((e) => e.confidence === "high");
  const worth = analyzer.errors.filter((e) => e.confidence === "worth_reviewing");
  const mkHeader = (label) => {
    const h = document.createElement("div");
    h.className = "findings-group-title";
    h.textContent = label;
    return h;
  };
  $("#findings-sub").textContent = analyzer.summary.headline
    || `${high.length} high-confidence · ${worth.length} worth reviewing`;
  if (high.length) {
    root.appendChild(mkHeader(`High confidence (${high.length}) — ready to ship to billing`));
    for (const e of high) root.appendChild(renderFinding(e, false));
  }
  if (worth.length) {
    root.appendChild(mkHeader(`Worth reviewing (${worth.length}) — patient-side only`));
    for (const e of worth) root.appendChild(renderFinding(e, true));
  }
  if (!high.length && !worth.length) {
    const p = document.createElement("p");
    p.className = "tl-sub";
    p.textContent = "No findings.";
    root.appendChild(p);
  }
}

function renderFinding(e, isWorth) {
  const div = document.createElement("div");
  div.className = `finding ${isWorth ? "worth" : ""}`;
  const head = document.createElement("div");
  head.className = "finding-head";
  const amt = document.createElement("div");
  amt.className = "finding-amount";
  amt.textContent = fmt$2(e.dollar_impact);
  head.appendChild(amt);
  const typeTag = document.createElement("span");
  typeTag.className = `tag ${isWorth ? "tag-amber" : "tag-green"}`;
  typeTag.textContent = errorTypeLabel(e.error_type);
  head.appendChild(typeTag);
  const confTag = document.createElement("span");
  confTag.className = `tag tag-mono ${isWorth ? "tag-amber" : "tag-green"}`;
  confTag.textContent = isWorth ? "WORTH REVIEW" : "HIGH";
  head.appendChild(confTag);
  if (e.cpt_code) {
    const cpt = document.createElement("span");
    cpt.className = "tag tag-mono";
    cpt.textContent = `CPT ${e.cpt_code}`;
    head.appendChild(cpt);
  }
  const page = document.createElement("span");
  page.className = "finding-page";
  page.textContent = `BILL PAGE ${e.page_number}`;
  head.appendChild(page);
  div.appendChild(head);
  const q = document.createElement("div");
  q.className = "finding-quote";
  q.textContent = e.line_quote;
  div.appendChild(q);
  const ev = document.createElement("div");
  ev.className = "finding-evidence";
  ev.textContent = e.evidence;
  div.appendChild(ev);
  return div;
}

function renderLetter(metadata, markdown) {
  const panel = $("#metadata-panel");
  panel.innerHTML = "";
  const order = [
    "patient_name","provider_name","provider_billing_address","account_number",
    "claim_number","date_of_service","insurer_name",
    "bill_current_balance_due","eob_patient_responsibility",
  ];
  const entries = order.filter((k) => k in metadata).map((k) => [k, metadata[k]]);
  for (const [k, v] of entries) {
    const row = document.createElement("div");
    row.className = "m-row";
    const label = k.replace(/_/g, " ");
    row.innerHTML = `<div class="k">${label}</div>`;
    const val = document.createElement("div");
    val.className = "v" + (v == null ? " missing" : "");
    if (v == null) val.textContent = "(missing)";
    else if (typeof v === "number" && (k.includes("balance") || k.includes("responsibility"))) val.textContent = fmt$2(v);
    else val.textContent = String(v);
    row.appendChild(val);
    panel.appendChild(row);
  }
  $("#letter-body").textContent = markdown;
}

function renderConversation(report) {
  const note = $("#strategy-note");
  note.innerHTML = "";
  const tag = document.createElement("span");
  tag.className = "tag tag-ink tag-mono";
  tag.textContent = (report.strategy.chosen || "—").toUpperCase();
  note.appendChild(tag);
  const body = document.createElement("div");
  body.textContent = report.strategy.reason;
  note.appendChild(body);
  const root = $("#conversation");
  root.innerHTML = "";

  // Persistent-agent run summary: ranked attempts across channels.
  if (report.persistent_run) {
    const pr = report.persistent_run;
    const panel = document.createElement("div");
    panel.className = "persistent-panel";
    const outcomeTag = pr.outcome === "floor_hit"
      ? `<span class="tag tag-mono tag-green">LOWEST PRICE</span>`
      : pr.outcome === "exhausted_with_offer"
      ? `<span class="tag tag-mono tag-amber">BEST OFFER</span>`
      : `<span class="tag tag-mono tag-red">NO CONCESSION</span>`;
    const attemptRows = pr.attempts.map((a) => {
      const amt = a.final_amount != null ? fmt$(a.final_amount) : '<em style="color:var(--ink-mute)">no adjustment</em>';
      const saved = a.saved != null ? `<span style="color:var(--green)">saved ${fmt$(a.saved)}</span>` : '<span style="color:var(--ink-mute)">—</span>';
      const isBest = pr.best && pr.best.channel === a.channel && pr.best.final_amount === a.final_amount;
      return `
        <div class="persistent-row${isBest ? " best" : ""}">
          <span class="tag tag-mono">${a.channel.toUpperCase()}</span>
          <span class="persistent-outcome">${a.outcome}</span>
          <span class="persistent-amt">${amt}</span>
          <span class="persistent-save">${saved}</span>
          <span class="persistent-turns">${a.turns} turn${a.turns === 1 ? "" : "s"}</span>
          ${isBest ? '<span class="tag tag-mono tag-green">BEST</span>' : ""}
        </div>`;
    }).join("");
    panel.innerHTML = `
      <div class="persistent-head">${outcomeTag} <span class="persistent-headline">${escapeHtml(pr.headline)}</span></div>
      <div class="persistent-meta">Original: <strong>${fmt$(pr.original_balance)}</strong> · Total saved: <strong>${pr.total_saved ? fmt$(pr.total_saved) : "—"}</strong></div>
      <div class="persistent-rows">${attemptRows}</div>`;
    root.appendChild(panel);
  }

  const addSection = (label) => {
    const hdr = document.createElement("div");
    hdr.className = "conv-section-head";
    hdr.textContent = label;
    root.appendChild(hdr);
  };

  let rendered = false;

  if (report.email_thread) {
    if (rendered) addSection("Email");
    for (const msg of report.email_thread.messages) {
      const el = document.createElement("div");
      el.className = `conv-msg ${msg.role === "outbound" ? "us" : "them"}`;
      const meta = document.createElement("div");
      meta.className = "conv-meta";
      const who = document.createElement("span");
      who.className = msg.role === "outbound" ? "who-us" : "who-them";
      who.textContent = msg.role === "outbound" ? "→ BONSAI" : "← PROVIDER";
      meta.appendChild(who);
      const ts = document.createElement("span");
      ts.textContent = new Date(msg.ts).toLocaleString();
      meta.appendChild(ts);
      const subj = document.createElement("span");
      subj.textContent = `"${msg.subject}"`;
      meta.appendChild(subj);
      const bodyEl = document.createElement("div");
      bodyEl.className = "conv-body";
      bodyEl.textContent = msg.body;
      el.append(meta, bodyEl);
      root.appendChild(el);
    }
    rendered = true;
  }

  if (report.voice_call) {
    if (rendered) addSection("Voice");
    for (const item of report.voice_call.transcript) {
      const el = document.createElement("div");
      el.className = `call-turn ${item.who}`;
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = item.who;
      const txt = document.createElement("div");
      txt.className = "txt";
      txt.textContent = item.text;
      el.append(who, txt);
      root.appendChild(el);
    }
    rendered = true;
  }

  if (!rendered) {
    const p = document.createElement("p");
    p.className = "tl-sub";
    p.textContent = "No negotiation ran.";
    root.appendChild(p);
  }
}

/**
 * Branded empty-state hero rendered in place of a view's regular chrome.
 * Bills and Comparison both use it pre-first-bill: the same brand mark +
 * wordmark from the sidebar, a serif headline, an explanation of what the
 * tab will do once a bill exists, and a single primary CTA back to the
 * home upload zone.
 *
 * The view's original children are stashed inside the empty-state element
 * itself (data-view-children) so `restoreViewChildren` can re-mount them
 * verbatim when an audit lands. That avoids re-creating the table /
 * filters / banner from scratch every time a poll cycle runs.
 */
/**
 * Custom hero for the Comparison tab. Like renderHeroEmptyView, but the
 * CTA is an early-access signup that persists on the user record. After
 * signup the button text flips to "Added to early access" and stays
 * disabled — every subsequent visit (even after a reload) reflects the
 * already-signed-up state because we read currentUser.early_access_at.
 */
function renderEarlyAccessHero(view) {
  if (view.querySelector(":scope > .empty-hero")) return;

  const stash = document.createElement("div");
  stash.style.display = "none";
  while (view.firstChild) stash.appendChild(view.firstChild);

  const hero = document.createElement("div");
  hero.className = "empty-hero";
  hero.innerHTML = `
    <div class="empty-hero-card">
      <h2 class="empty-hero-title">Comparison is in beta</h2>
      <p class="empty-hero-body">Bonsai will persistently look at other options for your recurring costs — phone plans, internet, insurance, subscriptions — so you're always paying the lowest price possible. No more digging through plans every year.</p>
      <button type="button" class="btn btn-primary btn-lg empty-hero-cta" id="early-access-btn"></button>
    </div>`;

  hero.appendChild(stash);
  hero.dataset.viewChildren = "1";
  view.appendChild(hero);

  const btn = hero.querySelector("#early-access-btn");
  if (!btn) return;

  // Sync the button to the user's current join status. Joined uses the
  // amber AI accent (the "ai" wordmark color) — the color shift IS the
  // affordance that the button is now a leave-toggle. No micro-copy
  // needed; clicking again removes them. Mount once + after every
  // toggle so the state never drifts.
  const sync = () => {
    const joined = !!currentUser?.early_access_at;
    btn.textContent = joined ? "Added to early access ✓" : "Sign up for early access";
    btn.classList.toggle("is-joined", joined);
  };
  sync();

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    const wasJoined = !!currentUser?.early_access_at;
    btn.disabled = true;
    btn.textContent = wasJoined ? "Removing…" : "Adding…";
    try {
      const res = await apiFetch("/api/early-access", {
        method: wasJoined ? "DELETE" : "POST",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(await res.text());
      const { user } = await res.json();
      if (user) currentUser = user;
      sync();
    } catch (err) {
      console.warn("[early-access] toggle failed", err);
      btn.textContent = "Try again";
    } finally {
      btn.disabled = false;
    }
  });
}

function renderHeroEmptyView(view, { title, body, cta }) {
  // If we already painted the empty state for this view, just bail —
  // re-render would lose attached event listeners on the CTA.
  if (view.querySelector(":scope > .empty-hero")) return;

  // Stash the existing children so we can swap them back later.
  const stash = document.createElement("div");
  stash.style.display = "none";
  while (view.firstChild) stash.appendChild(view.firstChild);

  const hero = document.createElement("div");
  hero.className = "empty-hero";
  hero.innerHTML = `
    <div class="empty-hero-card">
      <h2 class="empty-hero-title">${escapeHtml(title)}</h2>
      <p class="empty-hero-body">${escapeHtml(body)}</p>
      <button type="button" class="btn btn-primary btn-lg empty-hero-cta">${escapeHtml(cta)}</button>
    </div>`;

  hero.appendChild(stash);
  hero.dataset.viewChildren = "1";
  view.appendChild(hero);
  hero.querySelector(".empty-hero-cta").addEventListener("click", () => showNav("overview"));
}

function restoreViewChildren(view) {
  const hero = view.querySelector(":scope > .empty-hero");
  if (!hero) return;
  const stash = hero.querySelector(":scope > [style*='display: none']") ?? hero.lastElementChild;
  if (stash) {
    while (stash.firstChild) view.appendChild(stash.firstChild);
  }
  hero.remove();
}

// ─── Attention carousel (Negotiation tab) ─────────────────────────
// Every bill that needs the user's sign-off (or any other action — error,
// paused, verify-outcome, awaiting-approval) surfaces here above the
// stats. One card visible at a time; arrows page through the rest. The
// primary + secondary action buttons inline on the card mirror the
// drawer's Attention tab, so users can resolve without opening it.

const ATTENTION_CARD_BODY = {
  escalated: (a) => `Provider countered. Defensible amount: <strong>${fmt$(a.defensible_disputed ?? 0)}</strong>. Approve the counter or push back for a lower price.`,
  awaiting: () => `Audit complete. Review the plan and accept to start negotiating.`,
  error: (a) => a.error ? `Bonsai's agent hit an error: ${escapeHtml(a.error)}. Retry to keep going.` : `Bonsai's agent hit an error mid-negotiation. Retry to keep going.`,
  paused: () => `Paused by you. Resume to keep negotiating.`,
  verify_outcome: () => `Negotiation resolved. Confirm whether your next bill matched what Bonsai got.`,
};

let attentionCarouselIndex = 0;

function makeRowFromAudit(a, reason) {
  // Re-build the lightweight row shape openBillDrawer / handleAttentionAction
  // / resumeAgent expect, so an inline carousel button can drive the same
  // server actions as the drawer.
  const score = scoreFromAudit(a);
  return {
    id: `audit-${a.name}`,
    kind: "audit",
    vendor: a.provider_name ?? a.name,
    account: a.patient_name ? `${a.patient_name} · ${a.date_of_service ?? "—"}` : (a.date_of_service ?? "One-time bill"),
    lastCheck: relTime(a.modified),
    addedAt: a.modified ?? Date.now(),
    balance: a.final_balance ?? a.original_balance ?? 0,
    rate: "",
    category: inferCategory(a),
    score,
    scoreLabel: scoreLabelFor(score),
    auto: true,
    audit: a,
    status: a.status,
    lifecycle: "attention",
    attentionReason: reason,
  };
}

function renderAttentionList() {
  const root = $("#approvals-grid");
  const block = $("#approvals-block");
  const title = $("#approvals-title");
  if (!root || !block) return;
  const audits = historyCache?.audits ?? [];
  const attention = audits
    .map((a) => ({ a, reason: attentionReason(a) }))
    .filter((x) => x.reason != null);
  if (!attention.length) {
    block.hidden = true;
    return;
  }
  // Clamp the carousel index so resolved items at the end don't strand us
  // on a blank slot — and so a fresh attention item lands on a valid card.
  if (attentionCarouselIndex >= attention.length) attentionCarouselIndex = 0;
  if (attentionCarouselIndex < 0) attentionCarouselIndex = attention.length - 1;

  block.hidden = false;
  title.textContent = attention.length === 1
    ? "One negotiation needs your sign-off."
    : `${attention.length} negotiations need your sign-off.`;

  const cur = attention[attentionCarouselIndex];
  const { a, reason } = cur;
  const row = makeRowFromAudit(a, reason);
  const content = ATTENTION_CONTENT[reason.key] ?? null;
  const bodyFn = ATTENTION_CARD_BODY[reason.key] ?? (() => reason.label);

  const primaryBtn = content?.primary
    ? `<button type="button" class="btn btn-primary" data-attn-action="${escapeHtml(content.primary.id)}">${escapeHtml(content.primary.label)}</button>`
    : "";
  const secondaryBtn = content?.secondary
    ? `<button type="button" class="btn btn-ghost" data-attn-action="${escapeHtml(content.secondary.id)}">${escapeHtml(content.secondary.label)}</button>`
    : "";
  const openBtn = `<button type="button" class="btn btn-ghost btn-tight" data-attn-open>Open details</button>`;

  const showArrows = attention.length > 1;
  const pager = showArrows
    ? `<div class="attention-pager">
         <div class="attention-dots">
           ${attention.map((_, i) => `<span class="attention-dot${i === attentionCarouselIndex ? " is-active" : ""}"></span>`).join("")}
         </div>
         <div class="attention-counter mono">${attentionCarouselIndex + 1} of ${attention.length}</div>
       </div>`
    : "";

  root.innerHTML = `
    <div class="attention-carousel">
      ${showArrows ? `<button type="button" class="attention-arrow" data-attn-nav="prev" aria-label="Previous">‹</button>` : ""}
      <div class="approval-card approval-card-${reason.key}">
        <div class="approval-card-head">
          <div class="approval-card-icon">${ICONS.hospital}</div>
          <div class="approval-card-meta">${(a.channel_used ?? "email").toUpperCase()} · ${a.date_of_service ?? relTime(a.modified)}</div>
          <div class="approval-card-save">${fmt$(a.patient_saved ?? 0)}</div>
        </div>
        <div class="approval-card-title">${escapeHtml(a.provider_name ?? a.name)}</div>
        <div class="approval-card-reason">${escapeHtml(reason.label)}</div>
        <div class="approval-card-body">${bodyFn(a)}</div>
        <div class="approval-card-actions">
          ${openBtn}
          ${secondaryBtn}
          ${primaryBtn}
        </div>
      </div>
      ${showArrows ? `<button type="button" class="attention-arrow" data-attn-nav="next" aria-label="Next">›</button>` : ""}
    </div>
    ${pager}
  `;

  // Carousel navigation
  root.querySelectorAll("[data-attn-nav]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const dir = btn.dataset.attnNav;
      attentionCarouselIndex =
        dir === "prev"
          ? (attentionCarouselIndex - 1 + attention.length) % attention.length
          : (attentionCarouselIndex + 1) % attention.length;
      renderAttentionList();
    });
  });

  // Inline resolve actions — wire to the same handler the drawer uses.
  // resumeAgent / stopAgent read drawerState.row, so seed it before firing.
  // `silent: true` suppresses the post-action drawer auto-open so the user
  // who clicked here gets the action and stays on the list.
  root.querySelectorAll("[data-attn-action]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      drawerState.row = row;
      handleAttentionAction(btn.dataset.attnAction, row, { silent: true });
    });
  });

  root.querySelector("[data-attn-open]")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void openBillDrawer(row);
  });
}

// ─── Mock recurring bills + offers + settings ──────────────────
// Real audit data from /api/history + these recurring medical bills fill out the Bills table.
// These represent the long-tail the agent watches month-over-month.

const MOCK_RECURRING_BILLS = [];
// Fill in derived scoreLabel so existing callers that reference row.scoreLabel keep working.
for (const b of MOCK_RECURRING_BILLS) {
  b.scoreLabel = scoreLabelFor(b.score);
}

const KIND_ICON = {
  cell: ICONS.phone,
  cable: ICONS.pulse,
  security: ICONS.shield,
  electricity: ICONS.pulse,
  "car-insurance": ICONS.shield,
  "house-insurance": ICONS.shield,
  audit: ICONS.doc,
};

// Each offer carries a backend `baseline` so "Switch for me" runs a real
// /api/offer-hunt against the matching source directory. The cheaper numbers
// you see on the card are what the hunt typically produces — clicking
// triggers a live reach-out (email/voice simulation) to the directory and
// surfaces the actual quotes.
const MOCK_OFFERS = [];

// ─── Bills ─────────────────────────────────────────────────────

const BILLS_FILTER = { q: "", category: "", date: "", price: "", score: "" };
let billsFiltersBound = false;
let billsPollTimer = null;

function stopBillsPoll() {
  if (billsPollTimer) { clearTimeout(billsPollTimer); billsPollTimer = null; }
}

function scheduleBillsPoll() {
  stopBillsPoll();
  // Only poll while the Bills view is active AND there's at least one
  // in-progress bill. Otherwise sit quiet.
  if (currentNav !== "bills") return;
  const anyInflight = (historyCache?.audits ?? []).some(
    (a) => a.status === "negotiating" || a.outcome === "negotiating",
  );
  if (!anyInflight) return;
  billsPollTimer = setTimeout(async () => {
    try {
      await loadHistory();
      updateNavCounts();
      if (currentNav === "bills") renderBills();
    } catch { /* swallow and retry next tick */ }
    scheduleBillsPoll();
  }, 4000);
}

function renderBills() {
  updatePageHeader({
    eyebrow: "Negotiation",
    title: "Every negotiation in one place",
    stats: null,
  });

  const audits = historyCache?.audits ?? [];

  // Pre-first-bill state: hide the stats / filters / table chrome and show
  // a branded hero CTA. This is the empty Bills page on a fresh account.
  const view = $("#view-bills");
  if (view) {
    if (audits.length === 0) {
      renderHeroEmptyView(view, {
        title: "No negotiations yet",
        body:
          "Drop a bill or kick off a complaint from the home tab. Bonsai negotiates with the provider — every step, counter, and outcome lands here as it happens.",
        cta: "Start a negotiation",
      });
      scheduleBillsPoll();
      return;
    }
    // Real audits exist — make sure the regular chrome is back.
    restoreViewChildren(view);
  }

  const auditRows = audits.map((a) => {
    const score = scoreFromAudit(a);
    // outcome === "in_progress" is the real-email mode case: the agent
    // dispatched and is waiting on a reply. status flips to "completed"
    // (kickoff finished) but outcome stays "in_progress" — the bill is
    // very much an active negotiation, not a passive watch.
    const isNegotiating =
      a.status === "negotiating" ||
      a.outcome === "negotiating" ||
      a.outcome === "in_progress";
    const isFailed = a.status === "failed" || a.outcome === "failed";
    const isCancelled = a.status === "cancelled" || a.outcome === "cancelled";
    const isEscalated = a.outcome === "escalated";
    const isResolved = a.outcome === "resolved";
    // Traffic-light bucket:
    //   active    = yellow, negotiation in progress
    //   resolved  = green,  provider agreed / saved money
    //   attention = red,    needs a human (failed, escalated, or not-yet-started)
    let lifecycle;
    if (isNegotiating) lifecycle = "active";
    else if (isResolved) lifecycle = "resolved";
    else if (isFailed || isEscalated || isCancelled) lifecycle = "attention";
    // Audited-but-not-yet-approved is no longer "attention" — it shouldn't
    // pop a sidebar badge while the user is mid-flow on the review screen.
    // Treats it as "watching" instead; the row's own chip ("Awaiting your
    // approval") still surfaces the state on the Bills page.
    else lifecycle = null;
    return {
      id: `audit-${a.name}`,
      kind: "audit",
      vendor: a.provider_name ?? a.name,
      account: a.patient_name ? `${a.patient_name} · ${a.date_of_service ?? "—"}` : (a.date_of_service ?? "One-time bill"),
      lastCheck: relTime(a.modified),
      addedAt: a.modified ?? Date.now(),
      balance: a.final_balance ?? a.original_balance ?? 0,
      rate: "",
      category: inferCategory(a),
      score,
      scoreLabel: scoreLabelFor(score),
      auto: true,
      audit: a,
      status: isNegotiating ? "negotiating" : (isCancelled ? "cancelled" : (isFailed ? "failed" : "completed")),
      lifecycle,
      attentionReason: lifecycle === "attention" ? attentionReason(a) : null,
    };
  });
  const hiddenMocks = getHiddenMocks();
  const rows = [...auditRows, ...MOCK_RECURRING_BILLS.filter((b) => !hiddenMocks.has(b.id))];

  // Three numbers the user cares about: how many negotiations are running,
  // how many need attention, and total saved lifetime.
  const activeCount = auditRows.filter((r) => r.lifecycle === "active").length;
  const attentionCount = auditRows.filter((r) => r.lifecycle === "attention").length;
  const totalSaved = audits.reduce(
    (s, a) => s + clampSaved(a.patient_saved, a.original_balance),
    0,
  );

  // Attention cards render above the metrics. Re-render every time the
  // bills list refreshes so a counter that just landed (or got resolved)
  // shows up without a tab switch.
  renderAttentionList();

  $("#bills-stats").innerHTML = `
    <div>
      <div class="eyebrow">Active negotiations</div>
      <div class="stat-val">${activeCount}</div>
    </div>
    <div>
      <div class="eyebrow">Needs attention</div>
      <div class="stat-val${attentionCount > 0 ? " stat-red" : ""}">${attentionCount}</div>
    </div>
    <div>
      <div class="eyebrow">Total saved</div>
      <div class="stat-val stat-green">${fmt$(totalSaved)}</div>
    </div>`;

  // Populate the category dropdown from the live set of categories.
  const catSel = $("#bills-filter-category");
  if (catSel) {
    const cats = Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort();
    const current = BILLS_FILTER.category;
    catSel.innerHTML = `<option value="">All</option>` + cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (current && cats.includes(current)) catSel.value = current;
  }

  // One-time filter wiring.
  if (!billsFiltersBound) {
    bindBillsFilters(rows);
    billsFiltersBound = true;
  }

  renderBillsRows(rows);
  scheduleBillsPoll();
}

function billsFilterIsActive() {
  return Boolean(
    BILLS_FILTER.q || BILLS_FILTER.category || BILLS_FILTER.date || BILLS_FILTER.price || BILLS_FILTER.score,
  );
}

function syncBillsFilterResetState() {
  $("#bills-filter-reset")?.classList.toggle("is-active", billsFilterIsActive());
}

function bindBillsFilters(allRowsRef) {
  const onChange = () => {
    BILLS_FILTER.q = $("#bills-filter-q")?.value?.trim().toLowerCase() ?? "";
    BILLS_FILTER.category = $("#bills-filter-category")?.value ?? "";
    BILLS_FILTER.date = $("#bills-filter-date")?.value ?? "";
    BILLS_FILTER.price = $("#bills-filter-price")?.value ?? "";
    BILLS_FILTER.score = $("#bills-filter-score")?.value ?? "";
    syncBillsFilterResetState();
    // Always pull the freshest rows on re-filter (audits may have landed since).
    renderBills();
  };
  $("#bills-filter-q")?.addEventListener("input", debounce(onChange, 120));
  $("#bills-filter-category")?.addEventListener("change", onChange);
  $("#bills-filter-date")?.addEventListener("change", onChange);
  $("#bills-filter-price")?.addEventListener("change", onChange);
  $("#bills-filter-score")?.addEventListener("change", onChange);
  $("#bills-filter-reset")?.addEventListener("click", () => {
    BILLS_FILTER.q = ""; BILLS_FILTER.category = ""; BILLS_FILTER.date = "";
    BILLS_FILTER.price = ""; BILLS_FILTER.score = "";
    const q = $("#bills-filter-q"); if (q) q.value = "";
    for (const id of ["bills-filter-category", "bills-filter-date", "bills-filter-price", "bills-filter-score"]) {
      const el = document.getElementById(id); if (el) el.value = "";
    }
    syncBillsFilterResetState();
    renderBills();
  });
  syncBillsFilterResetState();
}

function filterBillsRows(rows) {
  const now = Date.now();
  const dateWindowMs = ({
    "7d": 7, "30d": 30, "90d": 90, "1y": 365,
  }[BILLS_FILTER.date] ?? 0) * 24 * 3600 * 1000;
  const [pMinStr, pMaxStr] = (BILLS_FILTER.price || "-").split("-");
  const pMin = pMinStr ? Number(pMinStr) : null;
  const pMax = pMaxStr ? Number(pMaxStr) : null;
  const [sMinStr, sMaxStr] = (BILLS_FILTER.score || "-").split("-");
  const sMin = sMinStr !== "" && sMinStr != null ? Number(sMinStr) : null;
  const sMax = sMaxStr !== "" && sMaxStr != null ? Number(sMaxStr) : null;
  const q = BILLS_FILTER.q;

  return rows.filter((r) => {
    if (q && !(`${r.vendor} ${r.account}`.toLowerCase().includes(q))) return false;
    if (BILLS_FILTER.category && r.category !== BILLS_FILTER.category) return false;
    if (dateWindowMs > 0) {
      const ts = r.addedAt ?? 0;
      if (!ts || now - ts > dateWindowMs) return false;
    }
    if (pMin != null && r.balance < pMin) return false;
    if (pMax != null && r.balance > pMax) return false;
    if (sMin != null && r.score < sMin) return false;
    if (sMax != null && r.score > sMax) return false;
    return true;
  });
}

function renderBillsRows(allRows) {
  const visible = filterBillsRows(allRows);
  // The live indicator strip used to announce active negotiations up top.
  // It ended up feeling like noise — the per-row yellow dot + inline
  // "Negotiating" pill already carries that signal. Keep the strip hidden.
  const liveWrap = $("#bills-live-text")?.closest(".live-indicator");
  if (liveWrap) liveWrap.hidden = true;

  const root = $("#bills-rows");
  root.innerHTML = "";

  if (allRows.length === 0) {
    root.innerHTML = `<div class="bills-empty">No bills yet. Run an audit from Overview to start tracking.</div>`;
    return;
  }
  if (visible.length === 0) {
    root.innerHTML = `<div class="bills-empty-filtered">No bills match these filters. <button class="dz-sample-link" type="button" id="bills-empty-reset">Reset filters →</button></div>`;
    $("#bills-empty-reset")?.addEventListener("click", () => $("#bills-filter-reset")?.click());
    return;
  }

  for (const r of visible) {
    const row = document.createElement("div");
    row.className = "bills-row bill-item" + (r.lifecycle === "active" ? " bill-item-active" : "");
    // Every row gets a status chip — never blank — so the user can see the
    // negotiation state at a glance without opening the drawer.
    const chip = rowStatusChip(r);
    const statusPill = chip.key === "active"
      ? `<span class="bill-inline-active"><span class="status-dot"></span>${escapeHtml(chip.label)}</span>`
      : `<span class="bill-inline-attention bill-inline-${escapeHtml(chip.key)}">${escapeHtml(chip.label)}</span>`;
    row.innerHTML = `
      <div class="bill-main">
        <div class="bill-ic">${KIND_ICON[r.kind] ?? ICONS.doc}</div>
        <div style="min-width:0">
          <div class="bill-name">${escapeHtml(r.vendor)}${statusPill}</div>
          <div class="bill-account mono">${r.lastCheck}</div>
        </div>
      </div>
      <div>
        <div class="bill-price">${fmt$(r.balance)}</div>
        ${r.rate ? `<div class="bill-price-sub">${r.rate}</div>` : ""}
      </div>
      <div class="bill-category"><span class="tag tag-mono">${escapeHtml(r.category.toUpperCase())}</span></div>
      <div class="bill-arrow">${ICONS.arrow}</div>`;
    row.addEventListener("click", () => openBillDrawer(r));
    root.appendChild(row);
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Single source of truth for the status chip on every Bills row. Returns
// { key, label } where key drives the color via .bill-inline-<key>.
function rowStatusChip(r) {
  if (r.lifecycle === "active") return { key: "active", label: "Negotiating" };
  if (r.attentionReason) return r.attentionReason;
  if (r.lifecycle === "resolved") return { key: "resolved", label: "Resolved" };
  // Mock bills paused via the drawer's Stop button surface that on the
  // Bills row even though there's no audit record for them.
  if (!r.audit && getMockPaused(r.id)) return { key: "paused", label: "Paused by you" };
  // Audited but not yet approved — user hasn't pressed Accept on the
  // review screen. Surface this explicitly so it doesn't get conflated
  // with the post-resolution "Watching" state below.
  if (r.audit?.status === "audited") return { key: "awaiting", label: "Awaiting your approval" };
  // Genuine "Watching": the bill has been settled and the user pressed
  // Start in the drawer to confirm a re-check cadence (mock rows for now;
  // real backend wires up later). Active negotiation NEVER lands here —
  // isNegotiating above catches in_progress / negotiating.
  return { key: "watching", label: "Watching" };
}

// Maps an audit's attention state to a human reason. Returns one of:
//   awaiting   — audited but not yet approved/started
//   escalated  — provider countered, the dispute is unresolved
//   paused     — user hit Stop on the agent
//   error      — agent crashed or otherwise failed mid-flight
// Returns null when the bill isn't in the attention bucket. Used both for
// the inline chip on the Bills list and as the drawer's Status label.
function attentionReason(audit) {
  if (!audit) return null;
  const status = audit.status;
  const outcome = audit.outcome;
  if (status === "failed" || outcome === "failed") return { key: "error", label: "Agent error" };
  if (status === "cancelled" || outcome === "cancelled") return { key: "paused", label: "Paused by you" };
  if (outcome === "escalated") return { key: "escalated", label: "Provider countered — review" };
  // "Negotiating" (the bg job is mid-flight) and "in_progress" (the agent
  // dispatched and is waiting on a real reply) are both ACTIVE states —
  // user already approved, nothing for them to do. The "in_progress"
  // case is what tripped users in real-email mode: status flipped to
  // "completed" (kickoff finished) but outcome stayed "in_progress",
  // which used to fall through to "Awaiting your approval".
  if (status === "negotiating" || outcome === "negotiating" || outcome === "in_progress") return null;
  if (outcome === "resolved") {
    // Server flags resolved bills the user hasn't confirmed match their next
    // statement after VERIFY_OUTCOME_AFTER_DAYS. Surfacing in the attention
    // bucket is what closes the loop.
    if (audit.needs_outcome_check && !audit.outcome_verified) {
      return { key: "verify_outcome", label: "Did your next bill match?" };
    }
    return null;
  }
  // Only show "Awaiting" for bills that were truly never approved — i.e.,
  // status === "audited" with no run kicked off yet. After approve, status
  // becomes "negotiating" or "completed" and we never land here.
  if (status === "audited") return { key: "awaiting", label: "Awaiting your approval" };
  return null;
}

function relTime(ms) {
  if (!ms) return "just now";
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)} min ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function inferCategory(a) {
  const n = (a.provider_name ?? a.name ?? "").toLowerCase();
  // Cell phone
  if (/verizon|at&?t|t-?mobile|sprint|mint mobile|cricket|metro|visible|us cellular|xfinity mobile|google fi|boost/.test(n)) {
    return "Cell phone";
  }
  // Internet
  if (/comcast|xfinity|spectrum|cox|optimum|fios|frontier|wow|cablevision|directv|dish/.test(n)) {
    return "Internet";
  }
  // Security system
  if (/adt|simplisafe|ring|vivint|frontpoint|brinks|xfinity home|abode|cove/.test(n)) {
    return "Security system";
  }
  // Electricity / utilities
  if (/pg&?e|edison|duke energy|con ?edison|pepco|national grid|pse&g|eversource|dominion|xcel energy|electric|power|utility/.test(n)) {
    return "Electricity";
  }
  // House insurance — match home-only carriers and explicit home/dwelling cues
  // first, before falling through to the broader auto-insurance list.
  if (/lemonade|hippo|kin insurance|homeowners?|home insurance|house insurance|renters? insurance|dwelling|property insurance/.test(n)) {
    return "House insurance";
  }
  // Car insurance
  if (/geico|progressive|allstate|state farm|liberty mutual|farmers|nationwide|usaa|esurance|travelers|the general|metromile/.test(n)) {
    return "Car insurance";
  }
  // Medical (broad net — hospital, clinic, health system, ER, lab, pharmacy, doctor/dr, dental, urgent care)
  if (/hospital|clinic|health|medical|er |emergency|urgent care|doctor|dr\.|md|dds|dental|pediatric|surgery|quest|labcorp|cvs|walgreens|regional|memorial|medic/.test(n)) {
    return "Medical bills";
  }
  return "Other";
}

// Gamified price score: 0 = greatly overpaying, 100 = at the best price possible.
// Resolved audits that saved money land in the 85-100 "best price" tier. Escalated
// audits where the provider has refused to move are stuck in overpaying territory.
function scoreFromAudit(a) {
  const original = a.original_balance ?? 0;
  const final = a.final_balance ?? original;
  const savedPct = original > 0 ? (original - final) / original : 0;

  if (a.outcome === "resolved") {
    // More of the bill negotiated away = closer to 100.
    if (savedPct >= 0.5) return 96;
    if (savedPct >= 0.3) return 90;
    if (savedPct >= 0.15) return 84;
    if (savedPct >= 0.05) return 76;
    return 70;
  }
  if (a.outcome === "escalated") {
    // Bigger defensible dispute still outstanding = worse score.
    const disputePct = original > 0 ? (a.defensible_disputed ?? 0) / original : 0;
    if (disputePct >= 0.4) return 18;
    if (disputePct >= 0.2) return 34;
    return 48;
  }
  // In review — neutral default.
  return 60;
}

function scoreLabelFor(score) {
  if (score >= 85) return "Best price";
  if (score >= 70) return "Fair price";
  if (score >= 50) return "Above market";
  if (score >= 25) return "Overpaying";
  return "Greatly overpaying";
}

// ─── Offers ────────────────────────────────────────────────────

let offersFilter = "Recommended";

function renderOffers() {
  // Page-header title is the original "Cheaper alternatives, found for
  // you" from when this tab was live. Comparison is now in beta — the
  // hero card below ("Comparison is in beta" + early-access CTA) carries
  // the not-yet-shipping state, so the page title can stay aspirational.
  updatePageHeader({
    eyebrow: "Comparison",
    title: "Cheaper alternatives, found for you",
    stats: null,
  });

  // Comparison is in beta — we ship the hero with an early-access
  // signup CTA. Clicking it persists on the user record so the button
  // shows "Added to early access" on subsequent visits.
  const view = $("#view-offers");
  if (view) {
    renderEarlyAccessHero(view);
    return;
  }

  // The savings banner only earns the page real estate when Bonsai has
  // actually found cheaper alternatives. Until there's a recommended
  // offer with a savings number, hide the whole bar — its $0 state was
  // the loudest thing on an otherwise empty Comparison page.
  const recommended = MOCK_OFFERS.filter((o) => o.recommended);
  const total = recommended.reduce((s, o) => s + (o.unit === "/mo" ? o.saves * 12 : o.saves), 0);
  const banner = $("#offers-banner");
  if (banner) {
    banner.hidden = recommended.length === 0 || total <= 0;
  }
  $("#banner-amount").textContent = fmt$(total);

  // Filters — "Recommended" leads (it's the agent's curated subset and what
  // we want users to consider first), then "All" as the escape hatch, then
  // the per-category chips.
  const filtersRoot = $("#offers-filters");
  filtersRoot.innerHTML = "";
  const cats = ["Recommended", "All", ...Array.from(new Set(MOCK_OFFERS.map((o) => o.category)))];
  for (const c of cats) {
    const chip = document.createElement("button");
    chip.className = "filter-chip" + (c === offersFilter ? " active" : "");
    chip.textContent = c;
    chip.addEventListener("click", () => { offersFilter = c; renderOffers(); });
    filtersRoot.appendChild(chip);
  }

  const grid = $("#offers-grid");
  grid.innerHTML = "";
  let visible;
  if (offersFilter === "All") visible = MOCK_OFFERS;
  else if (offersFilter === "Recommended") visible = MOCK_OFFERS.filter((o) => o.recommended);
  else visible = MOCK_OFFERS.filter((o) => o.category === offersFilter);
  for (const o of visible) grid.appendChild(buildOfferCard(o));

  // Accept-all: run hunts for every recommended offer that has a baseline.
  const acceptAll = $("#offers-accept-all");
  if (acceptAll && !acceptAll.dataset.wired) {
    acceptAll.addEventListener("click", async () => {
      const targets = MOCK_OFFERS.filter((o) => o.recommended && o.baseline);
      if (!targets.length) return;
      acceptAll.textContent = `Dispatching agent across ${targets.length} sources…`;
      acceptAll.disabled = true;
      for (const o of targets) {
        const card = document.querySelector(`[data-hunt-slot="${o.id}"]`)?.closest(".offer-card");
        if (card) await runOfferHuntForCard(o, card);
      }
      acceptAll.textContent = "All hunts complete — scroll to review";
    });
    acceptAll.dataset.wired = "1";
  }
}

function buildOfferCard(o) {
  const card = document.createElement("div");
  card.className = "offer-card" + (o.recommended ? " recommended" : "");
  card.innerHTML = `
    <div class="offer-head">
      <div class="offer-ic">${ICONS[o.icon] ?? ICONS.sparkle}</div>
      <div class="offer-head-main">
        <div class="offer-meta">${o.category}</div>
        <div class="offer-source">${escapeHtml(o.source)}</div>
      </div>
      <span class="tag tag-mono ${o.confidence === "HIGH" ? "tag-green" : "tag-amber"}">${o.confidence}</span>
    </div>
    <div class="offer-price-row">
      <div>
        <div class="col-label">Current</div>
        <div class="offer-current">${o.current ? `<span class="offer-amt offer-amt-strike">${fmt$(o.current)}</span>` + (o.unit ? `<span class="offer-unit">${escapeHtml(o.unit)}</span>` : "") : "—"}</div>
      </div>
      <div class="offer-arrow">${ICONS.arrow}</div>
      <div>
        <div class="col-label">Offer</div>
        <div class="offer-new">${o.offered ? `<span class="offer-amt">${fmt$(o.offered)}</span>` + (o.unit ? `<span class="offer-unit">${escapeHtml(o.unit)}</span>` : "") : "Free"}</div>
      </div>
      <div class="offer-pad"></div>
      <div class="offer-right">
        <div class="col-label">You save</div>
        <div class="offer-saves"><span class="offer-amt">${fmt$(o.saves)}</span>${o.unit ? `<span class="offer-unit">${escapeHtml(o.unit)}</span>` : ""}</div>
      </div>
    </div>
    <div>
      <div class="offer-sub-title">Why it fits</div>
      <div class="offer-sub">${escapeHtml(o.why)}</div>
    </div>
    <div>
      <div class="offer-sub-title">Switch friction</div>
      <div class="offer-sub">${escapeHtml(o.friction)}</div>
    </div>
    <div class="offer-eta">${escapeHtml(o.eta)}</div>
    <div class="offer-hunt-slot" data-hunt-slot="${o.id}"></div>
    <div class="offer-actions">
      <button class="btn btn-ghost" data-action="dismiss">Dismiss</button>
      <button class="btn btn-ghost" data-action="compare">Compare</button>
      <button class="btn btn-primary" data-action="hunt">Switch for me</button>
    </div>`;
  const switchBtn = card.querySelector('[data-action="hunt"]');
  if (switchBtn && o.baseline) {
    switchBtn.addEventListener("click", () => runOfferHuntForCard(o, card));
  } else if (switchBtn) {
    switchBtn.disabled = true;
    switchBtn.title = "No baseline wired for this offer";
  }
  const compareBtn = card.querySelector('[data-action="compare"]');
  if (compareBtn) {
    compareBtn.addEventListener("click", () => openCompareModal(o, card));
  }
  const dismissBtn = card.querySelector('[data-action="dismiss"]');
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      card.classList.add("offer-card-dismissed");
      setTimeout(() => card.remove(), 180);
    });
  }
  return card;
}

function openCompareModal(offer, card) {
  const modal = $("#cmp-modal");
  const scrim = $("#cmp-scrim");
  if (!modal || !scrim) return;

  const unit = offer.unit ?? "";
  const fmtWithUnit = (n) => n ? fmt$(n) + (unit ? `<span class="cmp-unit">${escapeHtml(unit)}</span>` : "") : "Free";
  const annualizedSaves = offer.unit === "/mo" ? offer.saves * 12 : offer.saves;

  $("#cmp-category").textContent = offer.category ?? "—";
  $("#cmp-title").textContent = `${offer.baseline?.current_provider ?? "Your current provider"} vs ${offer.source}`;
  $("#cmp-cur-provider").textContent = offer.baseline?.current_provider ?? "Your current provider";
  $("#cmp-cur-price").innerHTML = offer.current ? fmtWithUnit(offer.current) : "—";
  $("#cmp-cur-spec").textContent = offer.baseline?.specifics ?? "Same plan, same coverage — just paying more.";
  $("#cmp-off-provider").textContent = offer.source ?? "—";
  $("#cmp-off-price").innerHTML = fmtWithUnit(offer.offered);
  $("#cmp-off-saves").innerHTML = `Saves <strong>${fmt$(offer.saves)}</strong>${unit ? `<span class="cmp-unit">${escapeHtml(unit)}</span>` : ""}${unit === "/mo" ? ` · <strong>${fmt$(annualizedSaves)}</strong> a year` : ""}`;
  $("#cmp-why").textContent = offer.why ?? "—";
  $("#cmp-friction").textContent = offer.friction ?? "—";
  $("#cmp-eta").textContent = offer.eta ?? "—";
  $("#cmp-confidence").textContent = offer.confidence ?? "—";

  const switchBtn = $("#cmp-switch");
  if (offer.baseline) {
    switchBtn.disabled = false;
    switchBtn.title = "";
  } else {
    switchBtn.disabled = true;
    switchBtn.title = "No baseline wired for this offer";
  }

  scrim.hidden = false;
  modal.hidden = false;
  requestAnimationFrame(() => {
    scrim.classList.add("open");
    modal.classList.add("open");
  });

  const cleanup = () => {
    scrim.classList.remove("open");
    modal.classList.remove("open");
    setTimeout(() => { scrim.hidden = true; modal.hidden = true; }, 180);
    $("#cmp-close").onclick = null;
    $("#cmp-dismiss").onclick = null;
    $("#cmp-switch").onclick = null;
    scrim.onclick = null;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev) => { if (ev.key === "Escape") cleanup(); };
  $("#cmp-close").onclick = cleanup;
  $("#cmp-dismiss").onclick = cleanup;
  scrim.onclick = cleanup;
  document.addEventListener("keydown", onKey);
  switchBtn.onclick = () => {
    cleanup();
    if (offer.baseline && card) {
      void runOfferHuntForCard(offer, card);
      // Scroll to the card so the user sees the hunt panel populate.
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
}

async function runOfferHuntForCard(offer, card) {
  const slot = card.querySelector(`[data-hunt-slot="${offer.id}"]`);
  const btn = card.querySelector('[data-action="hunt"]');
  if (!slot || !btn) return;
  btn.disabled = true;
  btn.textContent = "Hunting…";
  slot.innerHTML = `
    <div class="hunt-panel">
      <div class="hunt-status">
        <span class="pulse-dot"></span>
        Agent reaching out to alternative sources…
      </div>
    </div>`;
  try {
    const res = await apiFetch("/api/offer-hunt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseline: offer.baseline, stop_on_first_win: false }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      slot.innerHTML = `<div class="hunt-panel error">Hunt failed: ${escapeHtml(data.error || res.statusText)}</div>`;
      btn.textContent = "Try again";
      btn.disabled = false;
      return;
    }
    slot.innerHTML = renderHuntPanel(data);
    btn.textContent = data.outcome === "lower_price_found" ? "Switch confirmed" : "Hunt complete";
  } catch (err) {
    slot.innerHTML = `<div class="hunt-panel error">Hunt failed: ${escapeHtml(err.message)}</div>`;
    btn.textContent = "Try again";
    btn.disabled = false;
  }
}

function renderHuntPanel(data) {
  const outcomeTag = data.outcome === "lower_price_found"
    ? `<span class="tag tag-mono tag-green">LOWER PRICE</span>`
    : data.outcome === "current_is_lowest"
    ? `<span class="tag tag-mono tag-amber">ALREADY LOWEST</span>`
    : `<span class="tag tag-mono tag-red">NO QUOTES</span>`;
  const rows = (data.quotes || []).map((q) => {
    const price = q.quoted_price != null ? fmt$(q.quoted_price) : '<em style="color:var(--ink-mute)">declined</em>';
    const save = q.savings_vs_baseline != null
      ? (q.savings_vs_baseline > 0
          ? `<span style="color:var(--green)">save ${fmt$(q.savings_vs_baseline)}</span>`
          : `<span style="color:var(--ink-mute)">+${fmt$(Math.abs(q.savings_vs_baseline))}</span>`)
      : "—";
    const chanBadge = `<span class="tag tag-mono" style="margin-right:6px">${q.channel.toUpperCase()}</span>`;
    return `
      <div class="hunt-row">
        <div class="hunt-row-head">${chanBadge}<strong>${escapeHtml(q.source_name)}</strong> · ${price} · ${save}</div>
        <div class="hunt-row-note">${escapeHtml(q.notes || "")}</div>
        <details class="hunt-reply">
          <summary>Reply</summary>
          <div class="hunt-reply-body">${escapeHtml(q.raw_reply || "")}</div>
        </details>
      </div>`;
  }).join("");
  return `
    <div class="hunt-panel">
      <div class="hunt-head">${outcomeTag} <span class="hunt-headline">${escapeHtml(data.headline || "")}</span></div>
      <div class="hunt-rows">${rows || '<div class="hunt-row-note">No quotes returned.</div>'}</div>
    </div>`;
}

// Modal dialog confirming account deletion. Two-step affordance: must type
// DELETE into the input before the confirm button enables.
function openDeleteAccountModal() {
  // Tear down a stale modal, if any.
  document.querySelector("#delete-account-modal")?.remove();

  const wrap = document.createElement("div");
  wrap.id = "delete-account-modal";
  wrap.className = "modal-scrim";
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="del-modal-title">
      <h2 class="modal-title" id="del-modal-title">Delete your account?</h2>
      <p class="modal-body">
        This permanently removes every bill, EOB, appeal letter, negotiation transcript,
        profile field, and tuning preference stored locally. We can't recover any of it.
      </p>
      <p class="modal-body" style="margin-top:8px">
        Type <strong>DELETE</strong> below to confirm.
      </p>
      <input type="text" id="del-modal-input" class="settings-input" autocomplete="off" placeholder="DELETE" />
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="del-modal-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="del-modal-confirm" disabled style="background:var(--red,#8b1e2e)">Delete account</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const input = wrap.querySelector("#del-modal-input");
  const confirm = wrap.querySelector("#del-modal-confirm");
  const cancel = wrap.querySelector("#del-modal-cancel");

  const close = () => wrap.remove();
  cancel.addEventListener("click", close);
  wrap.addEventListener("click", (ev) => {
    if (ev.target === wrap) close();
  });
  document.addEventListener(
    "keydown",
    function onKey(ev) {
      if (ev.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey);
      }
    },
  );

  input.addEventListener("input", () => {
    confirm.disabled = input.value.trim() !== "DELETE";
  });
  setTimeout(() => input.focus(), 50);

  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    confirm.textContent = "Deleting…";
    try {
      const res = await apiFetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (!res.ok) throw new Error(await res.text());
      close();
      // Reload so every cached view (bills, settings, profile) reflects the wipe.
      location.reload();
    } catch (err) {
      confirm.textContent = "Delete account";
      confirm.disabled = false;
      alert(`Delete failed: ${err?.message ?? err}`);
    }
  });
}

// Show a "Saved ✓" status pill, then fade it out after 3s. Used by every
// settings-style save button so the user gets confirmation without it lingering.
function flashSavedThenFade(statusEl) {
  statusEl.textContent = "Saved ✓";
  statusEl.className = "tg-save-status ok";
  // Cancel any prior fade timer so a second save doesn't get cut short.
  if (statusEl._fadeTimer) clearTimeout(statusEl._fadeTimer);
  if (statusEl._clearTimer) clearTimeout(statusEl._clearTimer);
  statusEl._fadeTimer = setTimeout(() => {
    statusEl.classList.add("fading");
  }, 3000);
  statusEl._clearTimer = setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "tg-save-status";
  }, 3600);
}

/**
 * Wipe the "Saved ✓" indicator the moment any field in `formRoot` changes,
 * so the user never sees stale confirmation when they have unsaved edits.
 * Idempotent — the listener is bound once per form root.
 */
function clearSaveStatusOnEdit(formRoot, statusEl) {
  if (!formRoot || !statusEl || formRoot.dataset.clearSaveBound === "1") return;
  formRoot.dataset.clearSaveBound = "1";
  const wipe = () => {
    if (statusEl._fadeTimer) clearTimeout(statusEl._fadeTimer);
    if (statusEl._clearTimer) clearTimeout(statusEl._clearTimer);
    statusEl.textContent = "";
    statusEl.className = "tg-save-status";
  };
  // `input` covers text fields, textareas, range; `change` covers
  // checkboxes, radios, selects, dates. Bubbling listeners on the form
  // root catch every descendant so we don't have to enumerate inputs.
  formRoot.addEventListener("input", wipe);
  formRoot.addEventListener("change", wipe);
}

// ─── Profile ──────────────────────────────────────────────────

async function renderProfile() {
  updatePageHeader({
    eyebrow: "Profile",
    title: "Who you are",
    stats: null,
  });
  const root = $("#profile-groups");
  root.innerHTML = '<div class="tl-sub">Loading…</div>';

  let sdata;
  try {
    sdata = await apiFetch("/api/settings").then((r) => r.json());
  } catch {
    sdata = { profile: {} };
  }
  const profile = sdata.profile ?? {};

  root.innerHTML = "";
  const card = mkProfileCard(profile);
  root.appendChild(card.el);
  installUnsavedGuard(card.getValues);
}

function mkProfileCard(p) {
  const g = document.createElement("div");
  g.className = "settings-group";
  const authorized = !!p.authorized;
  const hipaaAcked = !!p.hipaa_acknowledged;
  g.innerHTML = `
    <div class="settings-group-title">Personal details</div>
    <div class="settings-card">
      <div class="settings-row settings-row-split">
        <div class="settings-row-main">
          <div class="settings-row-label">First name</div>
          <input type="text" id="prof-first" class="settings-input" value="${escapeHtml(p.first_name ?? "")}" placeholder="Jane" autocomplete="given-name" />
        </div>
        <div class="settings-row-main">
          <div class="settings-row-label">Last name</div>
          <input type="text" id="prof-last" class="settings-input" value="${escapeHtml(p.last_name ?? "")}" placeholder="Doe" autocomplete="family-name" />
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Email</div>
          <div class="settings-row-help">Inbound replies from companies route here. Used as your contact email on every appeal.</div>
          <input type="email" id="prof-email" class="settings-input" value="${escapeHtml(p.email ?? "")}" placeholder="you@example.com" autocomplete="email" />
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Mobile</div>
          <div class="settings-row-help">Only used for real-time alerts.</div>
          <input type="tel" id="prof-phone" class="settings-input" value="${escapeHtml(p.phone ?? "")}" placeholder="+1 (415) 555-0134" autocomplete="tel" />
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Address</div>
          <div class="settings-row-help">Billing address on file. Used on appeal letters and dispute correspondence.</div>
          <input type="text" id="prof-address" class="settings-input" value="${escapeHtml(p.address ?? "")}" placeholder="123 Main St, Apt 4, Oakland, CA 94612" autocomplete="street-address" />
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Date of birth</div>
          <div class="settings-row-help">Some accounts require this to verify your identity. Never used for marketing.</div>
          <input type="date" id="prof-dob" class="settings-input" value="${escapeHtml(p.dob ?? "")}" autocomplete="bday" />
        </div>
      </div>
      <div class="settings-row settings-row-split">
        <div class="settings-row-main">
          <div class="settings-row-label">SSN (last 4)</div>
          <div class="settings-row-help">Some accounts require this to pull your record. Stored locally; never shown in transcripts.</div>
          <input type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" id="prof-ssn" class="settings-input" value="${escapeHtml(p.ssn_last4 ?? "")}" placeholder="1234" autocomplete="off" />
        </div>
        <div class="settings-row-main">
          <div class="settings-row-label">Driver's license</div>
          <div class="settings-row-help">Used when a company asks for an ID to verify identity.</div>
          <input type="text" id="prof-dl" class="settings-input" value="${escapeHtml(p.drivers_license ?? "")}" placeholder="D1234567" autocomplete="off" />
        </div>
      </div>
    </div>

    <div class="settings-group-title" style="margin-top:24px">Authorization</div>
    <div class="settings-card">
      <div class="settings-row settings-row-checkbox">
        <label class="consent-row">
          <input type="checkbox" id="prof-authorized" ${authorized ? "checked" : ""} />
          <span>
            <span class="settings-row-label">I authorize Bonsai to act on my behalf</span>
            <span class="settings-row-help">
              Includes requesting bills, negotiating balances, and contacting billing departments,
              providers, insurers, and collections agents about the bills you upload — across medical,
              utility, subscription, financial, and other accounts. You can revoke this at any time.
            </span>
          </span>
        </label>
      </div>

      <div class="hipaa-panel ${authorized ? "open" : ""}" id="prof-hipaa-panel">
        <div class="hipaa-eyebrow">HIPAA Authorization</div>
        <div class="hipaa-body">
          <p>
            By checking the box above, you also authorize Bonsai (the "Agent") and its operators to
            request, receive, and use your <strong>protected health information (PHI)</strong> — including
            itemized bills, EOBs, claim numbers, dates of service, CPT/HCPCS codes, diagnoses, treatment
            details, and insurer correspondence — strictly for the purpose of auditing and negotiating
            the bills you upload.
          </p>
          <p>
            This authorization complies with <strong>45 CFR § 164.508</strong>. It is voluntary and
            revocable in writing at any time, except for disclosures already made in reliance on it.
            Bonsai will not sell your PHI, use it for marketing, or share it with parties unrelated to
            your bill.
          </p>
        </div>
        <label class="consent-row hipaa-ack">
          <input type="checkbox" id="prof-hipaa" ${hipaaAcked ? "checked" : ""} />
          <span>
            <span class="settings-row-label">I acknowledge and agree to the HIPAA authorization above</span>
            <span class="settings-row-help">Required before Bonsai can request medical records on your behalf. Signed: ${
              p.hipaa_acknowledged_at
                ? new Date(p.hipaa_acknowledged_at).toLocaleString()
                : "not yet"
            }.</span>
          </span>
        </label>
      </div>
    </div>

    <div class="settings-row" style="justify-content:flex-end;gap:10px;margin-top:16px">
      <span id="prof-save-status" class="tg-save-status"></span>
      <button class="btn btn-primary" id="prof-save-btn" type="button">Save profile</button>
    </div>`;

  // HIPAA panel reveals only when the main authorization box is checked.
  // Unchecking the auth box also clears the HIPAA acknowledgment so the user
  // re-acknowledges if they re-authorize later.
  const authBox = g.querySelector("#prof-authorized");
  const hipaaPanel = g.querySelector("#prof-hipaa-panel");
  const hipaaBox = g.querySelector("#prof-hipaa");
  authBox.addEventListener("change", () => {
    if (authBox.checked) {
      hipaaPanel.classList.add("open");
    } else {
      hipaaPanel.classList.remove("open");
      hipaaBox.checked = false;
    }
  });

  // SSN: digits only.
  const ssnInput = g.querySelector("#prof-ssn");
  ssnInput.addEventListener("input", () => {
    ssnInput.value = ssnInput.value.replace(/\D/g, "").slice(0, 4);
  });

  const getValues = () => ({
    first_name: g.querySelector("#prof-first").value.trim(),
    last_name: g.querySelector("#prof-last").value.trim(),
    email: g.querySelector("#prof-email").value.trim(),
    phone: g.querySelector("#prof-phone").value.trim(),
    address: g.querySelector("#prof-address").value.trim(),
    dob: g.querySelector("#prof-dob").value.trim(),
    ssn_last4: ssnInput.value.trim(),
    drivers_license: g.querySelector("#prof-dl").value.trim(),
    authorized: authBox.checked,
    hipaa_acknowledged: hipaaBox.checked,
  });

  const saveBtn = g.querySelector("#prof-save-btn");
  const status = g.querySelector("#prof-save-status");
  saveBtn.addEventListener("click", async () => {
    const body = getValues();
    saveBtn.disabled = true;
    status.textContent = "Saving…";
    status.className = "tg-save-status";
    try {
      const res = await apiFetch("/api/settings/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      flashSavedThenFade(status);
      unsavedGuard?.markSaved?.();
    } catch (err) {
      status.textContent = `Error: ${err?.message ?? err}`;
      status.className = "tg-save-status err";
    } finally {
      saveBtn.disabled = false;
    }
  });
  // Format phone as the user types: "9498879051" → "(949) 887-9051"
  attachPhoneFormatter(g.querySelector("#prof-phone"));
  // Clear the "Saved ✓" pill the instant any field changes — stale
  // confirmation is misleading when there are pending edits.
  clearSaveStatusOnEdit(g, status);
  return { el: g, getValues };
}

// ─── Tune your agent ───────────────────────────────────────────

async function renderSettings() {
  updatePageHeader({
    eyebrow: "Settings",
    title: "Tune your agent",
    stats: null,
  });
  const root = $("#settings-groups");
  root.innerHTML = '<div class="tl-sub">Loading…</div>';

  let sdata;
  try {
    sdata = await apiFetch("/api/settings").then((r) => r.json());
  } catch {
    sdata = { tune: {}, integrations: [], fixtures: { count: 0 }, port: 3333 };
  }

  root.innerHTML = "";

  // Tune — tone, channels, floor, notifications.
  const tune = mkTuneCard(sdata.tune ?? {});
  root.appendChild(tune.el);

  // Connected accounts — editable credentials per integration.
  const integrations = mkIntegrationsCard(sdata.integrations ?? []);
  root.appendChild(integrations.el);

  installUnsavedGuard(tune.getValues);

  // Account — signed-in user, log out, export, delete. One card so users
  // don't have to hunt across two sections for "things that are mine".
  const accountGroup = document.createElement("div");
  accountGroup.className = "settings-group";
  accountGroup.innerHTML = `
    <div class="settings-group-title">Account</div>
    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Signed in as</div>
          <div class="settings-row-help" id="account-email">${escapeHtml(currentUser?.email ?? "")}</div>
        </div>
        <button class="btn btn-ghost" id="account-logout-btn" type="button">Log out</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Export all data</div>
          <div class="settings-row-help">Download every audit, letter, and transcript as a single JSON file.</div>
        </div>
        <button class="btn btn-ghost" id="data-export-btn" type="button">Export</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Delete account</div>
          <div class="settings-row-help">Removes stored bills, EOBs, and negotiation history. Irreversible.</div>
        </div>
        <button class="btn btn-ghost" id="data-delete-btn" type="button" style="color:var(--red);border-color:rgba(139,30,46,.3)">Delete</button>
      </div>
    </div>`;
  root.appendChild(accountGroup);
  accountGroup.querySelector("#account-logout-btn").addEventListener("click", () => logout());

  accountGroup.querySelector("#data-export-btn").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Exporting…";
    try {
      const res = await apiFetch("/api/export");
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m?.[1] ?? `bonsai-export-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Export failed: ${err?.message ?? err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  accountGroup.querySelector("#data-delete-btn").addEventListener("click", () => {
    openDeleteAccountModal();
  });

  // Save row — pinned to the very bottom of the Settings page.
  const saveRow = document.createElement("div");
  saveRow.className = "settings-save-row";
  saveRow.innerHTML = `
    <span id="tune-save-status" class="tg-save-status"></span>
    <button class="btn btn-primary" id="tune-save-btn" type="button">Save</button>`;
  root.appendChild(saveRow);

  const saveBtn = saveRow.querySelector("#tune-save-btn");
  const status = saveRow.querySelector("#tune-save-status");
  // Clear the "Saved ✓" pill the moment any field on the Settings page
  // changes — listening on `root` covers tune card, integrations card,
  // and account card via event bubbling.
  clearSaveStatusOnEdit(root, status);
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    status.textContent = "Saving…";
    status.className = "tg-save-status";
    try {
      const res = await apiFetch("/api/settings/tune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tune.getValues()),
      });
      if (!res.ok) throw new Error(await res.text());
      flashSavedThenFade(status);
      unsavedGuard?.markSaved?.();
    } catch (err) {
      status.textContent = `Error: ${err?.message ?? err}`;
      status.className = "tg-save-status err";
    } finally {
      saveBtn.disabled = false;
    }
  });
}

function mkIntegrationsCard(list) {
  const g = document.createElement("div");
  g.className = "settings-group";
  const title = document.createElement("div");
  title.className = "settings-group-title";
  title.textContent = "Connected accounts";
  g.appendChild(title);

  const card = document.createElement("div");
  card.className = "settings-card";
  g.appendChild(card);

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "settings-row";
    empty.innerHTML = `<div class="settings-row-main">
      <div class="settings-row-label">No integrations configured</div>
      <div class="settings-row-help">Nothing to connect yet.</div>
    </div>`;
    card.appendChild(empty);
  }

  for (const intg of list) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const connected = intg.status === "connected";
    const storedByUser = (intg.fields ?? []).some((f) => f.from_user);
    row.innerHTML = `
      <div class="settings-row-main">
        <div class="settings-row-label">${escapeHtml(intg.label)}${intg.required ? ' <span class="intg-req">required</span>' : ""}</div>
        <div class="settings-row-help">${escapeHtml(intg.detail ?? "")}</div>
      </div>
      <div class="intg-actions"></div>`;
    const actions = row.querySelector(".intg-actions");
    actions.appendChild(mkStatusPill(intg.status));
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "btn " + (connected ? "btn-ghost" : "btn-primary");
    primary.textContent = connected ? "Edit" : "Connect";
    primary.addEventListener("click", () => openIntegrationModal(intg));
    actions.appendChild(primary);
    if (storedByUser) {
      const disc = document.createElement("button");
      disc.type = "button";
      disc.className = "btn btn-ghost intg-disconnect";
      disc.textContent = "Disconnect";
      disc.addEventListener("click", () => disconnectIntegration(intg));
      actions.appendChild(disc);
    }
    card.appendChild(row);
  }

  return { el: g };
}

async function disconnectIntegration(intg) {
  const ok = await confirmModal({
    title: `Disconnect ${intg.label}?`,
    body: "Stored credentials for this integration will be cleared. You can reconnect at any time.",
    confirmText: "Disconnect",
    cancelText: "Cancel",
  });
  if (!ok) return;
  const body = {};
  for (const f of intg.fields ?? []) body[f.name] = "";
  try {
    const res = await apiFetch("/api/settings/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    void renderSettings();
  } catch (err) {
    alert(`Disconnect failed: ${err?.message ?? err}`);
  }
}

function openIntegrationModal(intg) {
  const modal = $("#intg-modal");
  const scrim = $("#intg-scrim");
  const titleEl = $("#intg-title");
  const subEl = $("#intg-sub");
  const fieldsRoot = $("#intg-modal-fields");
  const statusEl = $("#intg-modal-status");
  const saveBtn = $("#intg-save");
  const cancelBtn = $("#intg-cancel");
  if (!modal || !scrim) return;

  titleEl.textContent = `Connect ${intg.label}`;
  subEl.textContent = intg.detail ?? "";
  statusEl.textContent = "";
  statusEl.className = "intg-modal-status";
  fieldsRoot.innerHTML = "";

  for (const f of intg.fields ?? []) {
    const field = document.createElement("label");
    field.className = "intg-field";
    const placeholder = f.kind === "secret"
      ? (f.last4 ? `Current key ends in ${f.last4} — paste a new one to replace` : "Paste your key")
      : (f.placeholder ?? "");
    const initial = f.kind === "secret" ? "" : (f.value ?? "");
    field.innerHTML = `
      <span class="intg-field-label">${escapeHtml(f.label)}</span>
      <input
        type="${f.kind === "secret" ? "password" : "text"}"
        class="settings-input intg-input"
        data-intg-field="${escapeHtml(f.name)}"
        data-initial="${escapeHtml(initial)}"
        placeholder="${escapeHtml(placeholder)}"
        autocomplete="off"
        spellcheck="false"
        value="${escapeHtml(initial)}"
      />`;
    fieldsRoot.appendChild(field);
  }

  scrim.hidden = false;
  modal.hidden = false;
  requestAnimationFrame(() => {
    scrim.classList.add("open");
    modal.classList.add("open");
  });
  fieldsRoot.querySelector("input")?.focus();

  const cleanup = () => {
    scrim.classList.remove("open");
    modal.classList.remove("open");
    setTimeout(() => { scrim.hidden = true; modal.hidden = true; }, 180);
    saveBtn.onclick = null;
    cancelBtn.onclick = null;
    scrim.onclick = null;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") { cleanup(); }
  };
  cancelBtn.onclick = cleanup;
  scrim.onclick = cleanup;
  document.addEventListener("keydown", onKey);
  saveBtn.onclick = async () => {
    const body = {};
    for (const input of fieldsRoot.querySelectorAll("input[data-intg-field]")) {
      const name = input.dataset.intgField;
      const initial = input.dataset.initial ?? "";
      if (input.value !== initial) body[name] = input.value;
    }
    if (Object.keys(body).length === 0) {
      cleanup();
      return;
    }
    saveBtn.disabled = true;
    statusEl.textContent = "Saving…";
    statusEl.className = "intg-modal-status";
    try {
      const res = await apiFetch("/api/settings/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      cleanup();
      void renderSettings();
    } catch (err) {
      statusEl.textContent = `Error: ${err?.message ?? err}`;
      statusEl.className = "intg-modal-status err";
    } finally {
      saveBtn.disabled = false;
    }
  };
}

function mkTuneCard(tune) {
  const g = document.createElement("div");
  g.className = "settings-group";
  const tone = tune.tone ?? "firm";
  const channels = tune.channels ?? { email: true, voice: true };
  const digestOn = tune.email_digest !== false;
  const mobileOn = tune.mobile_alerts !== false;
  const toneOpt = (v, label, help) =>
    `<label class="tone-opt ${tone === v ? "tone-opt-sel" : ""}">
       <input type="radio" name="tune-tone" value="${v}" ${tone === v ? "checked" : ""} />
       <span class="tone-opt-label">${label}</span>
       <span class="tone-opt-help">${help}</span>
     </label>`;
  g.innerHTML = `
    <div class="settings-group-title">Negotiation style</div>
    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Tone</div>
          <div class="settings-row-help">How hard the agent pushes. You can always override per-bill in the feedback drawer.</div>
          <div class="tone-picker">
            ${toneOpt("polite", "Polite", "Lead with cooperation. Soft asks, patient timelines.")}
            ${toneOpt("firm", "Firm", "Clear asks, direct deadlines. Default.")}
            ${toneOpt("aggressive", "Aggressive", "Hard deadlines, explicit consequences (regulatory complaints, retention threats).")}
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Channels</div>
          <div class="settings-row-help">Which channels the agent may use. Disabled channels are skipped entirely.</div>
          <div class="channel-toggles">
            <label class="channel-toggle"><input type="checkbox" id="tune-ch-email" ${channels.email !== false ? "checked" : ""} /> <span>Email</span></label>
            <label class="channel-toggle"><input type="checkbox" id="tune-ch-voice" ${channels.voice !== false ? "checked" : ""} /> <span>Call</span></label>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-group-title" style="margin-top:24px">Notifications</div>
    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Weekly digest</div>
          <div class="settings-row-help">Summary of savings + what the agent is working on, delivered to your profile email.</div>
        </div>
        <button type="button" class="toggle ${digestOn ? "on" : ""}" id="tune-digest" aria-label="Weekly digest"><span class="toggle-dot"></span></button>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Real-time alerts</div>
          <div class="settings-row-help">Text alerts to your profile mobile number when the agent needs approval.</div>
        </div>
        <button type="button" class="toggle ${mobileOn ? "on" : ""}" id="tune-alerts" aria-label="Real-time alerts"><span class="toggle-dot"></span></button>
      </div>
    </div>`;

  // Tone radios: keep selected-style class in sync.
  for (const opt of g.querySelectorAll(".tone-opt")) {
    const input = opt.querySelector("input");
    input.addEventListener("change", () => {
      for (const o of g.querySelectorAll(".tone-opt")) o.classList.remove("tone-opt-sel");
      opt.classList.add("tone-opt-sel");
    });
  }
  // Notification toggles.
  for (const id of ["#tune-digest", "#tune-alerts"]) {
    g.querySelector(id).addEventListener("click", (ev) => ev.currentTarget.classList.toggle("on"));
  }
  const getValues = () => ({
    tone: g.querySelector('input[name="tune-tone"]:checked')?.value ?? "firm",
    channels: {
      email: g.querySelector("#tune-ch-email").checked,
      voice: g.querySelector("#tune-ch-voice").checked,
    },
    email_digest: g.querySelector("#tune-digest").classList.contains("on"),
    mobile_alerts: g.querySelector("#tune-alerts").classList.contains("on"),
  });
  return { el: g, getValues };
}

function mkSettingsGroup(title, rows) {
  const g = document.createElement("div");
  g.className = "settings-group";
  const t = document.createElement("div");
  t.className = "settings-group-title";
  t.textContent = title;
  g.appendChild(t);
  const card = document.createElement("div");
  card.className = "settings-card";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "settings-row" + (r.isRange ? " range-row" : "");
    if (r.isRange) {
      const head = document.createElement("div");
      head.className = "range-row-head";
      head.innerHTML = `
        <div class="settings-row-main">
          <div class="settings-row-label">${escapeHtml(r.label)}</div>
          <div class="settings-row-help">${escapeHtml(r.help ?? "")}</div>
        </div>
        <div class="range-row-value" data-range-val>${r.prefix ?? ""}${Number(r.value).toLocaleString()}</div>`;
      row.appendChild(head);
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(r.min); input.max = String(r.max); input.step = String(r.step);
      input.value = String(r.value);
      const display = head.querySelector("[data-range-val]");
      input.addEventListener("input", () => {
        display.textContent = `${r.prefix ?? ""}${Number(input.value).toLocaleString()}`;
      });
      row.appendChild(input);
    } else {
      const lead = document.createElement("div");
      lead.className = "settings-row-main";
      lead.innerHTML = `<div class="settings-row-label">${escapeHtml(r.label)}</div><div class="settings-row-help">${escapeHtml(r.help ?? "")}</div>`;
      row.appendChild(lead);
      const val = document.createElement("div");
      val.className = "settings-row-value";
      if (r.tone) val.classList.add(`tone-${r.tone}`);
      if (typeof r.value === "string") val.textContent = r.value;
      else val.appendChild(r.value);
      row.appendChild(val);
    }
    card.appendChild(row);
  }
  g.appendChild(card);
  return g;
}

function mkToggle(on) {
  const b = document.createElement("button");
  b.className = "toggle" + (on ? " on" : "");
  b.innerHTML = `<span class="toggle-dot"></span>`;
  return b;
}

function mkRange(value, min, max, step, prefix) {
  const wrap = document.createElement("div");
  wrap.className = "range-row";
  const display = document.createElement("div");
  display.className = "range-val mono";
  display.textContent = `${prefix ?? ""}${value.toLocaleString()}`;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    display.textContent = `${prefix ?? ""}${Number(input.value).toLocaleString()}`;
  });
  wrap.appendChild(display);
  wrap.appendChild(input);
  return wrap;
}

function mkSelect(options) {
  const s = document.createElement("select");
  s.className = "settings-select";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.textContent = o;
    s.appendChild(opt);
  }
  return s;
}

function mkStatusPill(status) {
  const span = document.createElement("span");
  // Anything that isn't a live, validated connection reads as "NOT CONNECTED"
  // regardless of whether it's a missing required integration or a soft
  // fallback to the built-in simulator — the user experience is the same:
  // they haven't linked it yet.
  const tone = status === "connected" ? "tag-green"
             : status === "missing"   ? "tag-red"
             : "tag-amber";
  span.className = `tag tag-mono ${tone}`;
  span.textContent = status === "connected" ? "CONNECTED" : "NOT CONNECTED";
  return span;
}

// ─── Bill detail drawer (CRM-style audit log) ──────────────────

let drawerState = { row: null, report: null, activeTab: "activity" };
const reportCache = new Map();

// Mock bills (no run_id) get a theatrical Stop/Start backed by localStorage so
// the controls and Feedback tab still work end-to-end without a real audit.
function mockPausedKey(rowId) { return `bonsai-mock-paused:${rowId}`; }
function getMockPaused(rowId) {
  try { return localStorage.getItem(mockPausedKey(rowId)) === "1"; } catch { return false; }
}
function setMockPaused(rowId, val) {
  try {
    if (val) localStorage.setItem(mockPausedKey(rowId), "1");
    else localStorage.removeItem(mockPausedKey(rowId));
  } catch {}
}
function mockFeedbackKey(rowId) { return `bonsai-mock-feedback:${rowId}`; }
function getMockFeedback(rowId) {
  try { return JSON.parse(localStorage.getItem(mockFeedbackKey(rowId)) ?? "[]"); } catch { return []; }
}
function appendMockFeedback(rowId, msg) {
  const log = getMockFeedback(rowId);
  log.push(msg);
  try { localStorage.setItem(mockFeedbackKey(rowId), JSON.stringify(log)); } catch {}
}
// Deleting a mock bill just hides it client-side — the /api/delete endpoint
// would 404 on a synthetic id. The list is keyed by row.id so both
// MOCK_RECURRING_BILLS entries and any future synthetic rows can be removed.
const HIDDEN_MOCKS_KEY = "bonsai-hidden-mocks";
function getHiddenMocks() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_MOCKS_KEY) ?? "[]")); } catch { return new Set(); }
}
function hideMock(rowId) {
  const set = getHiddenMocks();
  set.add(rowId);
  try { localStorage.setItem(HIDDEN_MOCKS_KEY, JSON.stringify([...set])); } catch {}
}

async function openBillDrawer(row) {
  drawerState = { row, report: null, activeTab: "activity" };
  const drawer = $("#bill-drawer");
  const scrim = $("#drawer-scrim");
  drawer.hidden = false;
  scrim.hidden = false;
  // Next frame so the transform transition runs
  requestAnimationFrame(() => {
    drawer.classList.add("open");
    scrim.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  });

  // Header
  $("#drawer-title").textContent = row.vendor ?? "—";
  $("#drawer-sub").textContent = row.lastCheck ?? "";

  // Stats (initial — will be enriched after fetch for audits)
  renderDrawerStats(row, null);

  // If this is an audited bill, fetch the full report
  if (row.kind === "audit" && row.audit?.name) {
    const name = row.audit.name;
    $("#drawer-body").innerHTML = `<div class="dact-empty">Loading activity…</div>`;
    let report = reportCache.get(name);
    if (!report) {
      try {
        const res = await apiFetch(`/api/report/${name}`);
        if (res.ok) {
          report = await res.json();
          reportCache.set(name, report);
        }
      } catch (err) { /* ignore */ }
    }
    if (drawerState.row !== row) return; // user switched rows
    drawerState.report = report;
    renderDrawerStats(row, report);
  }

  // Frequency dropdown — per-bill, persisted client-side.
  const freqSel = $("#drawer-frequency");
  if (freqSel) {
    const key = drawerFreqKey(row);
    const stored = (typeof localStorage !== "undefined" && localStorage.getItem(key)) || "monthly";
    freqSel.value = stored;
    if (!freqSel._bound) {
      freqSel._bound = true;
      freqSel.addEventListener("change", () => {
        const r = drawerState.row;
        if (!r) return;
        try { localStorage.setItem(drawerFreqKey(r), freqSel.value); } catch {}
      });
    }
  }

  // Stop / Start — always visible for any real audit. The agent's job on a
  // bill isn't one-shot: completed bills still get periodic re-negotiation
  // rounds. For mock recurring bills (no run_id) we still expose the control
  // so the user can mark them paused; the paused flag is persisted client-side
  // and the Feedback tab still works as a local notebook for that bill.
  const agentBtn = $("#drawer-agent-btn");
  const runId = row?.audit?.run_id;
  const isMock = !runId;
  const mockPaused = isMock ? getMockPaused(row.id) : false;
  // Mock rows tagged with an attentionReason are conceptually "not running"
  // — Awaiting approval, Provider countered, Paused, or Agent error all want
  // Start (not Stop) and the Feedback tab.
  const mockAttention = isMock && !!row.attentionReason;
  const isActive = isMock
    ? (!mockPaused && !mockAttention)
    : (row.lifecycle === "active");
  const isStopped = isMock
    ? (mockPaused || mockAttention)
    : (row.status === "cancelled" || row.status === "failed");

  updateDrawerAgentButton(row, { isMock, isActive });

  // Tab visibility rules:
  //   • Needs attention — only when the bill has an attentionReason. The
  //     panel hosts everything the user needs to resolve (counter info,
  //     inline chat, primary CTA) so they don't have to flip tabs.
  //   • Feedback        — only when an active negotiation was stopped by
  //                       the user (paused state). For other attention
  //                       reasons, chat lives inline on the Attention tab.
  // When attention is set we land directly on it; else if paused, on
  // Feedback; else default to Activity.
  const drawerReason = row.attentionReason ?? (row.audit ? attentionReason(row.audit) : null);
  const attentionTabBtn = document.querySelector('.drawer-tab[data-dtab="attention"]');
  if (attentionTabBtn) attentionTabBtn.hidden = !drawerReason;
  const feedbackTabBtn = document.querySelector('.drawer-tab[data-dtab="feedback"]');
  const isPaused = drawerReason?.key === "paused";
  if (feedbackTabBtn) feedbackTabBtn.hidden = !isPaused;
  // New bills with no contact channel must start on Contact — the agent is
  // gated on at least one of support_email / support_phone, and the Contact
  // tab is the only place to fix that.
  const needsContact = !!row.audit && row.audit.can_launch === false;
  const initialTab = needsContact
    ? "contact"
    : drawerReason ? "attention"
    : (isStopped ? "feedback" : "activity");
  drawerState.activeTab = initialTab;
  document.querySelectorAll(".drawer-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.dtab === initialTab);
  });

  // Awaiting approval is a *review* surface, not a quick status check —
  // widen the drawer so the audit findings, plan, and chat have room.
  // (Using the `drawer` const from the top of this function.)
  drawer.classList.toggle("drawer-wide", drawerReason?.key === "awaiting");

  // Tabs
  bindDrawerTabs();
  renderDrawerTab(initialTab);
}

/**
 * Render the drawer's primary agent button (Start / Stop / disabled) for
 * the given row. Re-callable on its own so saveDrawerContact() can update
 * the gate as soon as the user fills in support contact info — no full
 * drawer reflow required.
 *
 * Hard gate: real (non-mock) bills with no contact channel get a disabled
 * "Start" button. Server-side handleApprove / handleResumeNegotiation
 * mirror the same check; the UI is the friendly half of the same lock.
 */
function updateDrawerAgentButton(row, opts) {
  const agentBtn = $("#drawer-agent-btn");
  if (!agentBtn) return;
  const audit = row?.audit ?? null;
  const runId = audit?.run_id;
  const isMock = !runId;
  const mockPaused = isMock ? getMockPaused(row.id) : false;
  const mockAttention = isMock && !!row.attentionReason;
  const isActive = opts?.isActive ?? (isMock
    ? (!mockPaused && !mockAttention)
    : (row.lifecycle === "active"));
  const canLaunch = isMock ? true : (audit?.can_launch !== false);

  agentBtn.hidden = false;
  if (isActive) {
    agentBtn.className = "drawer-agent-btn drawer-stop-btn";
    agentBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
      <span>Stop</span>`;
    agentBtn.disabled = false;
    agentBtn.title = "";
    agentBtn.onclick = isMock
      ? () => {
          setMockPaused(row.id, true);
          row.lifecycle = null;
          row.attentionReason = null;
          if (currentNav === "bills") renderBills();
          updateNavCounts();
          void openBillDrawer(row);
        }
      : () => stopAgent();
  } else {
    agentBtn.className = canLaunch
      ? "drawer-agent-btn drawer-resume-btn"
      : "drawer-agent-btn drawer-resume-btn drawer-agent-btn-locked";
    agentBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>
      <span>Start</span>`;
    agentBtn.disabled = !canLaunch;
    agentBtn.title = canLaunch
      ? ""
      : "Add a support email or phone in the Contact tab to launch the agent.";
    agentBtn.onclick = canLaunch
      ? () => promptResumeMode(row)
      : (ev) => {
          ev?.preventDefault?.();
          // Steer the user to the only place that fixes the gate.
          drawerState.activeTab = "contact";
          document.querySelectorAll(".drawer-tab").forEach((b) => {
            b.classList.toggle("active", b.dataset.dtab === "contact");
          });
          renderDrawerTab("contact");
        };
  }
}

async function loadFeedback(row) {
  const log = $("#drawer-feedback-log");
  if (!log) return;
  log.innerHTML = "";
  const runId = row?.audit?.run_id;
  if (!runId) {
    // Mock bill — render the localStorage-backed log.
    for (const m of getMockFeedback(row.id)) {
      appendFeedbackMessage(m.role, m.body);
    }
    return;
  }
  try {
    const res = await apiFetch(`/api/feedback/${runId}`);
    if (!res.ok) return;
    const { feedback } = await res.json();
    for (const m of feedback ?? []) {
      appendFeedbackMessage(m.role, m.body);
    }
  } catch { /* empty log is fine */ }
}

function appendFeedbackMessage(role, body) {
  const log = $("#drawer-feedback-log");
  if (!log) return;
  const div = document.createElement("div");
  div.className = `qa-msg ${role === "user" ? "q" : "a"}`;
  div.innerHTML = `<div class="qa-role">${role === "user" ? "You" : "Bonsai"}</div><div class="qa-body"></div>`;
  div.querySelector(".qa-body").textContent = body;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function sendFeedback() {
  const row = drawerState?.row;
  if (!row) return;
  const runId = row?.audit?.run_id;
  const input = $("#drawer-feedback-input");
  const msg = input.value.trim();
  if (!msg) return;
  appendFeedbackMessage("user", msg);
  input.value = "";

  if (!runId) {
    // Mock bill — store the note locally and acknowledge so the user has a
    // record they can come back to. No backend round-trip.
    appendMockFeedback(row.id, { role: "user", body: msg, ts: Date.now() });
    const reply = "Got it. I'll apply that on the next round.";
    setTimeout(() => {
      appendFeedbackMessage("assistant", reply);
      appendMockFeedback(row.id, { role: "assistant", body: reply, ts: Date.now() });
      input.focus();
    }, 320);
    return;
  }

  input.disabled = true;
  const btn = $("#drawer-feedback-form button");
  if (btn) btn.disabled = true;
  const thinking = document.createElement("div");
  thinking.className = "qa-msg a";
  thinking.innerHTML = `<div class="qa-role">Bonsai</div><div class="qa-body"><span class="dots"><span></span><span></span><span></span></span></div>`;
  $("#drawer-feedback-log").appendChild(thinking);

  try {
    const res = await apiFetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, message: msg }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { reply } = await res.json();
    thinking.querySelector(".qa-body").textContent = reply;
  } catch (err) {
    thinking.querySelector(".qa-body").textContent = `Error: ${err?.message ?? err}`;
    thinking.classList.add("error");
  } finally {
    input.disabled = false;
    if (btn) btn.disabled = false;
    input.focus();
  }
}

async function deleteBill() {
  const row = drawerState?.row;
  if (!row) return;
  const runId = row?.audit?.run_id;
  const vendor = row.vendor ?? "this bill";
  const isMock = !runId;
  const ok = await confirmModal({
    title: `Delete ${vendor}?`,
    body: isMock
      ? "Removes this bill from your tracked list."
      : "This removes the audit, appeal letter, and uploaded files. Can't be undone.",
    confirmText: "Delete",
    cancelText: "Cancel",
  });
  if (!ok) return;
  if (isMock) {
    hideMock(row.id);
    updateNavCounts();
    if (currentNav === "bills") renderBills();
    closeBillDrawer();
    return;
  }
  try {
    const res = await apiFetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    if (!res.ok) throw new Error(await res.text());
    await loadHistory();
    updateNavCounts();
    if (currentNav === "bills") renderBills();
    closeBillDrawer();
  } catch (err) {
    alert(`Couldn't delete: ${err?.message ?? err}`);
  }
}

/** Promise-based confirm modal. Resolves true on confirm, false on cancel/scrim. */
function confirmModal({ title, body, confirmText = "Confirm", cancelText = "Cancel" }) {
  return new Promise((resolve) => {
    const modal = $("#confirm-modal");
    const scrim = $("#confirm-scrim");
    const ok = $("#confirm-ok");
    const cancel = $("#confirm-cancel");
    if (!modal || !scrim || !ok || !cancel) { resolve(false); return; }

    $("#confirm-title").textContent = title;
    $("#confirm-sub").textContent = body;
    ok.textContent = confirmText;
    cancel.textContent = cancelText;

    scrim.hidden = false;
    modal.hidden = false;
    requestAnimationFrame(() => {
      scrim.classList.add("open");
      modal.classList.add("open");
    });

    const cleanup = () => {
      scrim.classList.remove("open");
      modal.classList.remove("open");
      setTimeout(() => { scrim.hidden = true; modal.hidden = true; }, 180);
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      scrim.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKey = (ev) => {
      if (ev.key === "Escape") onCancel();
      else if (ev.key === "Enter") onOk();
    };

    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    scrim.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

async function resumeAgent(opts) {
  const silent = opts?.silent === true;
  const row = drawerState?.row;
  const runId = row?.audit?.run_id;
  if (!runId) return;
  try {
    const res = await apiFetch("/api/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    if (!res.ok) throw new Error(await res.text());
    await loadHistory();
    updateNavCounts();
    if (currentNav === "bills") renderBills();
    // When invoked from the carousel, the user never opened the drawer —
    // re-opening it after the action would feel like an unwanted modal.
    // Skip the drawer hand-off and just leave them on the list. The
    // attention card will fall away on the next render since the
    // negotiation has flipped back to active.
    if (silent) return;
    const updatedRow = findUpdatedRowAfterRefresh(row);
    if (updatedRow) {
      drawerState.row = updatedRow;
      openBillDrawer(updatedRow);
    } else {
      closeBillDrawer();
    }
  } catch (err) {
    alert(`Couldn't resume: ${err?.message ?? err}`);
  }
}

async function stopAgent() {
  const row = drawerState.row;
  const runId = row?.audit?.run_id;
  if (!runId) return;
  // Fire-and-re-render. No disabled state on the button — the user should
  // always be able to stop, cancel stops, or change their mind. The
  // operation only affects this specific run_id, so other bills keep
  // negotiating uninterrupted.
  try {
    const res = await apiFetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    if (!res.ok) throw new Error(await res.text());
    await loadHistory();
    updateNavCounts();
    if (currentNav === "bills") renderBills();
    const updatedRow = findUpdatedRowAfterRefresh(row);
    if (updatedRow) {
      drawerState.row = updatedRow;
      openBillDrawer(updatedRow);
    } else {
      closeBillDrawer();
    }
  } catch (err) {
    alert(`Couldn't stop: ${err?.message ?? err}`);
  }
}

// After a status flip, the bills cache is refreshed but `drawerState.row`
// still points at the old object. Reach into the fresh audits list to grab
// the new row for the same name so the drawer can re-render with updated
// lifecycle / status.
function findUpdatedRowAfterRefresh(row) {
  const name = row?.audit?.name;
  if (!name) return null;
  const audits = historyCache?.audits ?? [];
  const fresh = audits.find((a) => a.name === name);
  if (!fresh) return null;
  const score = scoreFromAudit(fresh);
  const isNegotiating = fresh.status === "negotiating" || fresh.outcome === "negotiating";
  const isFailed = fresh.status === "failed" || fresh.outcome === "failed";
  const isCancelled = fresh.status === "cancelled" || fresh.outcome === "cancelled";
  const isEscalated = fresh.outcome === "escalated";
  const isResolved = fresh.outcome === "resolved";
  let lifecycle;
  if (isNegotiating) lifecycle = "active";
  else if (isResolved) lifecycle = "resolved";
  else lifecycle = "attention";
  return {
    ...row,
    audit: fresh,
    lifecycle,
    status: isNegotiating ? "negotiating" : (isCancelled ? "cancelled" : (isFailed ? "failed" : "completed")),
  };
}

function drawerFreqKey(row) {
  return `bonsai.freq.${row?.id ?? row?.audit?.name ?? row?.vendor ?? "unknown"}`;
}

function closeBillDrawer() {
  const drawer = $("#bill-drawer");
  const scrim = $("#drawer-scrim");
  drawer.classList.remove("open");
  scrim.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  setTimeout(() => {
    if (!drawer.classList.contains("open")) {
      drawer.hidden = true;
      scrim.hidden = true;
    }
  }, 280);
}

// ─── Bill viewer (modal showing the uploaded bill files) ─────────
let billViewerState = null;

async function openBillViewer(runId) {
  const modal = $("#bill-viewer");
  const scrim = $("#bill-viewer-scrim");
  const body = $("#bill-viewer-body");
  const tabs = $("#bill-viewer-tabs");
  $("#bill-viewer-title").textContent = "Loading…";
  $("#bill-viewer-sub").textContent = "";
  tabs.innerHTML = "";
  body.innerHTML = '<div class="bv-loading">Loading your bill…</div>';
  scrim.hidden = false;
  modal.hidden = false;
  requestAnimationFrame(() => {
    scrim.classList.add("open");
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  });
  try {
    const res = await apiFetch(`/api/bill/${encodeURIComponent(runId)}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    billViewerState = { runId, files: data.files || [], index: 0 };
    if (billViewerState.files.length === 0) {
      $("#bill-viewer-title").textContent = "No file on record";
      body.innerHTML = '<div class="bv-empty">This run has no uploaded files attached.</div>';
      return;
    }
    $("#bill-viewer-title").textContent = billViewerState.files[0].name;
    $("#bill-viewer-sub").textContent = `${billViewerState.files.length} file${billViewerState.files.length === 1 ? "" : "s"} · click a tab to switch`;
    if (billViewerState.files.length > 1) {
      billViewerState.files.forEach((f, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bv-tab" + (i === 0 ? " active" : "");
        b.textContent = `${i + 1}. ${f.name}`;
        b.addEventListener("click", () => showBillViewerIndex(i));
        tabs.appendChild(b);
      });
    }
    showBillViewerIndex(0);
  } catch (err) {
    body.innerHTML = `<div class="bv-empty">Could not load: ${escapeHtml(String(err?.message ?? err))}</div>`;
  }
}

function showBillViewerIndex(i) {
  if (!billViewerState) return;
  billViewerState.index = i;
  const f = billViewerState.files[i];
  const body = $("#bill-viewer-body");
  $("#bill-viewer-title").textContent = f.name;
  for (const t of document.querySelectorAll(".bv-tab")) t.classList.remove("active");
  const active = document.querySelectorAll(".bv-tab")[i];
  if (active) active.classList.add("active");
  body.innerHTML = "";

  // Always give the user an escape hatch: a top-right "Open in new tab" link.
  // Browser PDF plugins sometimes refuse to render inside an iframe, and
  // some image formats (HEIC, TIFF) can't render inline at all. The link
  // guarantees the bill is accessible.
  const openLink = document.createElement("a");
  openLink.className = "bv-open-new";
  openLink.href = f.url;
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.textContent = "Open in new tab ↗";
  body.appendChild(openLink);

  if (f.mime === "application/pdf") {
    const frame = document.createElement("iframe");
    frame.className = "bv-frame";
    frame.src = f.url;
    frame.title = f.name;
    body.appendChild(frame);
  } else if (f.mime.startsWith("image/")) {
    // Every image file previews inline. The server transcodes HEIC/HEIF/TIFF
    // to JPEG on the fly, so we can render them as a normal <img>.
    const img = document.createElement("img");
    img.className = "bv-img";
    img.alt = f.name;
    img.src = f.url;
    body.appendChild(img);
  } else {
    const box = document.createElement("div");
    box.className = "bv-empty";
    box.innerHTML = `Your browser can't preview <code>${escapeHtml(f.ext.toUpperCase())}</code> files inline. Use <strong>Open in new tab</strong> above, or <a class="bv-download" href="${escapeHtml(f.url)}" download="${escapeHtml(f.name)}">download ${escapeHtml(f.name)}</a>.`;
    body.appendChild(box);
  }
}

function closeBillViewer() {
  const modal = $("#bill-viewer");
  const scrim = $("#bill-viewer-scrim");
  if (!modal) return;
  modal.classList.remove("open");
  scrim.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  setTimeout(() => {
    if (!modal.classList.contains("open")) {
      modal.hidden = true;
      scrim.hidden = true;
      $("#bill-viewer-body").innerHTML = "";
    }
  }, 200);
}

function bindDrawerTabs() {
  const buttons = document.querySelectorAll(".drawer-tab");
  buttons.forEach((btn) => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", () => {
      const which = btn.dataset.dtab;
      drawerState.activeTab = which;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      renderDrawerTab(which);
    });
  });
}

function renderDrawerStats(row, report) {
  const summary = report?.summary ?? {};
  const was = summary.original_balance ?? row.balance ?? 0;
  const now = summary.final_balance ?? row.balance ?? 0;
  const saved = clampSaved(summary.patient_saved, was);
  const channel = summary.channel_used ?? "—";

  // Traffic-light status. Active = yellow, resolved = green, attention = red.
  // For attention rows we surface the *specific* reason (Awaiting approval,
  // Provider countered, Paused by you, Agent error) so the drawer matches
  // the inline chip on the Bills row and tells the user exactly what to do.
  const reason = row.attentionReason ?? (row.audit ? attentionReason(row.audit) : null);
  let statusTone = "attention";
  let statusLabel = "Needs attention";
  if (row.lifecycle === "active" || summary.outcome === "in_progress" || row.status === "negotiating") {
    statusTone = "active";
    statusLabel = "Negotiating";
  } else if (row.lifecycle === "resolved" || summary.outcome === "resolved") {
    statusTone = "resolved";
    statusLabel = "Resolved";
  } else if (reason) {
    statusTone = "attention";
    statusLabel = reason.label;
  } else if (row.kind !== "audit") {
    statusTone = "resolved";
    statusLabel = row.scoreLabel ?? "Watching";
  }

  // Trash button lives statically in the drawer header next to the bill
  // name — wired once in init(). The Status stat here just shows the pill.
  $("#drawer-stats").innerHTML = `
    <div class="drawer-stat"><div class="eyebrow">Original</div><div class="drawer-stat-val ${saved ? "strike" : ""}">${fmt$(was)}</div></div>
    <div class="drawer-stat"><div class="eyebrow">Current</div><div class="drawer-stat-val">${fmt$(now)}</div></div>
    <div class="drawer-stat"><div class="eyebrow">Saved</div><div class="drawer-stat-val green">${saved ? fmt$(saved) : "—"}</div></div>
    <div class="drawer-stat">
      <div class="eyebrow">Status</div>
      <div class="drawer-stat-status bill-status bill-status-${statusTone}">
        <span class="status-dot"></span><span>${escapeHtml(statusLabel)}</span>
      </div>
    </div>`;

  // Outcome-verification ribbon for resolved bills. Renders in a slot
  // immediately below the stats grid — kept lightweight here (no full
  // attention card) so it doesn't compete with the activity timeline,
  // but still gives every resolved bill a one-click way to confirm.
  renderOutcomeVerifyBanner(row);
}

function renderOutcomeVerifyBanner(row) {
  const slot = $("#drawer-outcome-banner");
  if (!slot) return;
  const audit = row?.audit;
  const isResolved = audit && (audit.outcome === "resolved");
  if (!isResolved || !audit.run_id) {
    slot.innerHTML = "";
    slot.hidden = true;
    return;
  }
  if (audit.outcome_verified) {
    const labelMap = { yes: "matched", partial: "partially matched", no: "didn't match" };
    const label = labelMap[audit.outcome_verified] ?? audit.outcome_verified;
    slot.hidden = false;
    slot.innerHTML = `
      <div class="outcome-verify outcome-verify-done">
        <div class="outcome-verify-text">
          <strong>You confirmed this ${escapeHtml(label)}.</strong>
          ${audit.outcome_notes ? ` <span class="outcome-verify-notes">"${escapeHtml(audit.outcome_notes)}"</span>` : ""}
        </div>
      </div>`;
    return;
  }
  slot.hidden = false;
  slot.innerHTML = `
    <div class="outcome-verify">
      <div class="outcome-verify-text">
        <strong>Did your next bill match?</strong>
        Pull up the latest statement from the provider and tell us how it landed.
      </div>
      <div class="outcome-verify-actions">
        <button type="button" class="btn btn-ghost" data-outcome-action="no">No / partial</button>
        <button type="button" class="btn btn-primary" data-outcome-action="yes">Yes, matched</button>
      </div>
    </div>`;
  slot.querySelector('[data-outcome-action="yes"]').addEventListener("click", () => {
    void submitOutcomeVerification(row, "yes");
  });
  slot.querySelector('[data-outcome-action="no"]').addEventListener("click", () => {
    openOutcomeNoMatchModal(row);
  });
}

function renderDrawerTab(which) {
  const body = $("#drawer-body");
  const { row, report } = drawerState;
  if (which === "activity") {
    body.innerHTML = renderActivityTimeline(row, report);
  } else if (which === "feedback") {
    body.innerHTML = renderDrawerFeedback(row);
    wireDrawerFeedback(row);
  } else if (which === "attention") {
    body.innerHTML = renderDrawerAttention(row);
    wireDrawerAttention(row);
  } else if (which === "contact") {
    body.innerHTML = renderDrawerContact(row);
    wireDrawerContact(row);
  }
}

// ─── Contact tab ─────────────────────────────────────────────────
// Bonsai's agent dials/emails the support contact you provide here.
// At least one of support_email or support_phone is required before
// the Run/Resume agent button unlocks (the hard gate is enforced
// server-side in handleApprove / handleResumeNegotiation as well).

const BILL_KIND_OPTIONS = [
  ["medical", "Medical / hospital"],
  ["telecom", "Telecom (cell, internet, cable)"],
  ["utility", "Utility (gas, electric, water)"],
  ["subscription", "Subscription / SaaS"],
  ["insurance", "Insurance premium"],
  ["financial", "Financial (bank fee, credit card)"],
  ["other", "Other"],
];

function renderDrawerContact(row) {
  const audit = row?.audit ?? null;
  const c = audit?.contact ?? {};
  const billKind = c.bill_kind ?? audit?.bill_kind ?? "medical";
  const isFixture = !audit?.run_id; // mock bills have no run; nothing to save
  const helpLine = audit?.can_launch
    ? `<div class="contact-help-ok">Agent ready to launch.</div>`
    : `<div class="contact-help-warn">Add a billing email below — that's how Bonsai will reach the company. A phone number is optional. Save when you're done.</div>`;
  const disabled = isFixture ? " disabled" : "";

  const kindOptions = BILL_KIND_OPTIONS
    .map(([v, l]) => `<option value="${v}"${v === billKind ? " selected" : ""}>${escapeHtml(l)}</option>`)
    .join("");

  return `
    <form class="drawer-contact" id="drawer-contact-form" autocomplete="off">
      ${helpLine}
      <label class="contact-field">
        <span class="eyebrow">Bill type</span>
        <select id="contact-bill-kind" class="drawer-select"${disabled}>${kindOptions}</select>
      </label>
      <label class="contact-field">
        <span class="eyebrow">Account holder</span>
        <input type="text" id="contact-account-holder" class="drawer-input"
               placeholder="Name on the account"
               value="${escapeHtml(c.account_holder_name ?? "")}"${disabled}>
      </label>
      <label class="contact-field">
        <span class="eyebrow">Support email</span>
        <input type="email" id="contact-support-email" class="drawer-input"
               placeholder="billing@example.com"
               value="${escapeHtml(c.support_email ?? "")}"${disabled}>
      </label>
      <label class="contact-field">
        <span class="eyebrow">Support phone</span>
        <input type="tel" id="contact-support-phone" class="drawer-input"
               placeholder="+1 415 555 0123"
               value="${escapeHtml(c.support_phone ?? "")}"${disabled}>
        <span class="contact-field-hint">E.164 (+1...) preferred. Free-form OK; we normalize at dial time.</span>
      </label>
      <label class="contact-field">
        <span class="eyebrow">Support portal URL <span class="muted">(optional)</span></span>
        <input type="url" id="contact-portal-url" class="drawer-input"
               placeholder="https://billing.example.com/account"
               value="${escapeHtml(c.support_portal_url ?? "")}"${disabled}>
      </label>
      <div class="contact-actions">
        <button type="submit" class="contact-save-btn"${disabled}>Save contact</button>
        <span class="contact-status" id="contact-status" aria-live="polite"></span>
      </div>
      ${isFixture ? `<div class="contact-help-warn">This is a mock/sample bill. Upload a real bill to edit contact info.</div>` : ""}
    </form>`;
}

function wireDrawerContact(row) {
  const form = $("#drawer-contact-form");
  if (!form) return;
  // Format the support phone as the user types.
  attachPhoneFormatter(document.getElementById("contact-support-phone"));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void saveDrawerContact(row);
  });
}

async function saveDrawerContact(row) {
  const status = $("#contact-status");
  const runId = row?.audit?.run_id;
  if (!runId) {
    if (status) {
      status.textContent = "Mock bill — no save endpoint.";
      status.className = "contact-status warn";
    }
    return;
  }
  const body = {
    bill_kind: $("#contact-bill-kind")?.value || "medical",
    account_holder_name: $("#contact-account-holder")?.value?.trim() || null,
    support_email: $("#contact-support-email")?.value?.trim() || null,
    support_phone: $("#contact-support-phone")?.value?.trim() || null,
    support_portal_url: $("#contact-portal-url")?.value?.trim() || null,
  };
  if (!body.support_email && !body.support_phone) {
    if (status) {
      status.textContent = "Add at least one of email or phone.";
      status.className = "contact-status warn";
    }
    return;
  }
  if (status) {
    status.textContent = "Saving…";
    status.className = "contact-status";
  }
  try {
    const res = await apiFetch(`/api/bill/${encodeURIComponent(runId)}/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error === "support_phone is not a parseable phone number"
        ? "Phone number couldn't be parsed. Try +1 415 555 0123."
        : data?.message || data?.error || "Save failed.";
      if (status) {
        status.textContent = msg;
        status.className = "contact-status warn";
      }
      return;
    }
    // Mutate the in-memory row so the rest of the drawer sees the new state
    // immediately — bills list refresh below will reconcile from /api/history.
    if (row.audit) {
      row.audit.contact = data.contact;
      row.audit.can_launch = data.can_launch;
      row.audit.bill_kind = data.contact?.bill_kind ?? "medical";
    }
    if (status) {
      status.textContent = data.can_launch ? "Saved. Agent unlocked." : "Saved.";
      status.className = data.can_launch ? "contact-status ok" : "contact-status";
    }
    // Re-render the agent button so the gate updates without a manual refresh.
    if (typeof renderDrawerStats === "function") renderDrawerStats(row, drawerState.report);
    if (typeof updateDrawerAgentButton === "function") updateDrawerAgentButton(row);
    if (currentNav === "bills" && typeof renderBills === "function") renderBills();
  } catch (err) {
    console.error("[contact] save failed", err);
    if (status) {
      status.textContent = "Network error. Try again.";
      status.className = "contact-status warn";
    }
  }
}

// What to show on the Needs-attention tab for each of the four states.
// Each entry is one short instruction + a primary CTA that funnels into
// the existing Start / Resume machinery.
const ATTENTION_CONTENT = {
  awaiting: {
    tone: "awaiting",
    title: "Awaiting your approval",
    body: "Bonsai audited this bill and built a negotiation plan, but hasn't reached out to the provider yet. Review the plan on the Activity tab, then approve to kick off the first round.",
    steps: [
      "Open Activity to read the plan and the appeal letter.",
      "Use Feedback if you want to steer tone, channels, or talking points.",
      "Click Approve & start when you're ready.",
    ],
    primary: { id: "start", label: "Approve & lower my bill" },
  },
  escalated: {
    tone: "urgent",
    title: "Provider countered — review",
    body: "The provider responded with a counter-offer. The new amount is below — approve to accept it and close the bill, or keep negotiating to push for an even lower price.",
    steps: [
      "Review the counter amount and savings shown below.",
      "Use Feedback first if you want to steer the next round (e.g. 'reject, anchor at $200 lower').",
      "Approve to accept, or Keep negotiating to send another round.",
    ],
    primary: { id: "approve_counter", label: "Approve counter" },
    secondary: { id: "keep_negotiating", label: "Keep negotiating" },
  },
  paused: {
    tone: "neutral",
    title: "You paused this agent",
    body: "Negotiation is on hold. Use the Feedback tab to redirect the agent — change tone, restrict channels, share new info — then click Resume when you're ready.",
    steps: [
      "Open Feedback and tell the agent what to change for the next round.",
      "Click Resume to pick up where you left off.",
    ],
    primary: { id: "resume", label: "Resume agent" },
  },
  error: {
    tone: "urgent",
    title: "Agent ran into an error",
    body: "The last round crashed before completing. Most errors are transient — a single retry usually clears them. Activity has the underlying error message.",
    steps: [
      "Open Activity to read what failed.",
      "Click Retry to try the round again.",
      "If it keeps failing, leave a note in Feedback so the agent skips that channel next time.",
    ],
    primary: { id: "retry", label: "Retry now" },
  },
  verify_outcome: {
    tone: "neutral",
    title: "Did your next bill match?",
    body: "We negotiated this bill down a few weeks ago. Take a quick look at your most recent statement from the provider — does the agreed-upon amount actually show up? Your answer helps Bonsai measure outcomes.",
    steps: [
      "Pull up the latest statement from the provider.",
      "Compare the amount due to the agreed amount shown in this drawer.",
      "Tell us how it landed below.",
    ],
    primary: { id: "outcome_yes", label: "Yes, it matched" },
    secondary: { id: "outcome_no_match", label: "No, or partial" },
  },
};

function renderCounterPanel(row) {
  const c = row.counter;
  if (!c) return "";
  const original = c.original ?? row.balance ?? 0;
  const counterAmt = c.counter_amount ?? c.amount ?? 0;
  const saves = c.saves ?? (original - counterAmt);
  const pct = original > 0 ? Math.round((saves / original) * 100) : 0;
  return `
    <div class="dattn-counter">
      <div class="dattn-counter-grid">
        <div class="dattn-counter-cell">
          <div class="dattn-counter-label">Original</div>
          <div class="dattn-counter-amt"><span class="offer-amt-strike">${fmt$(original)}</span></div>
        </div>
        <div class="dattn-counter-arrow" aria-hidden="true">→</div>
        <div class="dattn-counter-cell">
          <div class="dattn-counter-label">Provider's counter</div>
          <div class="dattn-counter-amt dattn-counter-amt-green">${fmt$(counterAmt)}</div>
        </div>
        <div class="dattn-counter-cell dattn-counter-saves">
          <div class="dattn-counter-label">If you approve, you save</div>
          <div class="dattn-counter-amt"><strong>${fmt$(saves)}</strong>${pct > 0 ? ` <span class="dattn-counter-pct">(${pct}%)</span>` : ""}</div>
        </div>
      </div>
      ${c.notes ? `<div class="dattn-counter-notes">“${escapeHtml(c.notes)}” — billing rep</div>` : ""}
    </div>`;
}

function renderDrawerAttention(row) {
  const reason = row.attentionReason ?? (row.audit ? attentionReason(row.audit) : null);
  if (!reason) {
    return `<div class="dact-empty">Nothing to resolve right now.</div>`;
  }
  const content = ATTENTION_CONTENT[reason.key];
  if (!content) {
    return `<div class="dact-empty">${escapeHtml(reason.label)}</div>`;
  }
  const stepsHtml = content.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  const secondaryBtn = content.secondary
    ? `<button type="button" class="btn btn-ghost" data-attn-action="${escapeHtml(content.secondary.id)}">${escapeHtml(content.secondary.label)}</button>`
    : "";
  const counterPanel = (reason.key === "escalated" && row.counter) ? renderCounterPanel(row) : "";
  // Inline chat surface — same IDs the Feedback tab uses, so the existing
  // sendFeedback / loadFeedback helpers work without modification. Hidden
  // for "paused" because that state has its own dedicated Feedback tab.
  const showInlineChat = reason.key !== "paused";
  const chatPanel = showInlineChat ? `
    <div class="dattn-chat">
      <div class="dattn-chat-eyebrow">Chat with the agent</div>
      <div class="dattn-chat-sub">Anything you say here will steer the next round.</div>
      <div class="qa-log dattn-chat-log" id="drawer-feedback-log"></div>
      <form class="qa-form qa-form-chat" id="drawer-feedback-form">
        <input type="text" id="drawer-feedback-input" placeholder="e.g. 'Reject and counter at $1,500' · 'Add HIPAA card on file'" autocomplete="off" />
        <button type="submit" class="qa-send" aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
        </button>
      </form>
    </div>` : "";
  return `
    <div class="dattn dattn-${escapeHtml(content.tone)}">
      <div class="dattn-eyebrow">${escapeHtml(reason.label)}</div>
      <div class="dattn-title">${escapeHtml(content.title)}</div>
      <div class="dattn-body">${escapeHtml(content.body)}</div>
      ${counterPanel}
      <ol class="dattn-steps">${stepsHtml}</ol>
      ${chatPanel}
      <div class="dattn-actions">
        ${secondaryBtn}
        <button type="button" class="btn btn-primary dattn-primary" data-attn-action="${escapeHtml(content.primary.id)}">${escapeHtml(content.primary.label)}</button>
      </div>
    </div>`;
}

function wireDrawerAttention(row) {
  const body = $("#drawer-body");
  if (!body) return;
  body.querySelectorAll("[data-attn-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleAttentionAction(btn.dataset.attnAction, row));
  });
  // If the inline chat surface is rendered (escalated / awaiting / error)
  // wire the same submit + load handlers the Feedback tab uses.
  const form = body.querySelector("#drawer-feedback-form");
  if (form) {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      sendFeedback();
    });
    void loadFeedback(row);
  }
}

async function promptResumeMode(row) {
  const startNow = await confirmModal({
    title: "Resume agent",
    body: "Start a fresh negotiation round now, or just take this bill off pause and wait for the next scheduled run?",
    confirmText: "Start now",
    cancelText: "Resume on schedule",
  });
  const isMock = !row?.audit?.run_id;
  if (isMock) {
    setMockPaused(row.id, false);
    row.attentionReason = null;
    if (startNow) {
      // Active immediately — chip flips to Negotiating.
      row.lifecycle = "active";
    } else {
      // Off the paused list but waiting for the schedule — chip falls
      // back to Watching until the next tick fires.
      row.lifecycle = null;
    }
    if (currentNav === "bills") renderBills();
    updateNavCounts();
    void openBillDrawer(row);
    return;
  }
  // Real audit: only the "start now" path has a backend hook today.
  // "Resume on schedule" is a no-op until scheduling is wired up.
  if (startNow) {
    void resumeAgent();
  }
}

function handleAttentionAction(action, row, opts) {
  const silent = opts?.silent === true;
  const runId = row?.audit?.run_id;
  // verify_outcome lives outside the start/resume machinery — it just
  // POSTs the user's verdict and re-renders. "Yes" submits immediately;
  // "No or partial" pops a small modal so we can capture notes.
  if (action === "outcome_yes") {
    void submitOutcomeVerification(row, "yes", undefined, { silent });
    return;
  }
  if (action === "outcome_no_match") {
    openOutcomeNoMatchModal(row);
    return;
  }
  // start / resume / retry / keep_negotiating all = "kick off the next round".
  // approve_counter = "accept the counter, close out as resolved".
  // For real audits this is /api/resume (or a future /api/accept-counter);
  // for mock rows we toggle the local flag so the demo round-trips.
  if (action === "approve_counter") {
    if (runId) {
      // Real backend doesn't have a dedicated accept endpoint yet — fall
      // through to resume so the agent's next round can confirm. The user
      // can also leave a Feedback note ("accept their counter, no further
      // negotiation") to make it explicit.
      void resumeAgent({ silent });
      // Close the drawer once the user's approved — keeping it open after
      // they hit the primary action feels like the action didn't take.
      // From the carousel the drawer isn't open; closeBillDrawer is a no-op.
      if (!silent) closeBillDrawer();
      return;
    }
    setMockPaused(row.id, false);
    row.attentionReason = null;
    row.lifecycle = "resolved";
    if (currentNav === "bills") renderBills();
    updateNavCounts();
    if (!silent) closeBillDrawer();
    return;
  }
  if (action === "start" || action === "resume" || action === "retry" || action === "keep_negotiating") {
    if (runId) {
      void resumeAgent({ silent });
      if (!silent) closeBillDrawer();
      return;
    }
    setMockPaused(row.id, false);
    row.attentionReason = null;
    row.lifecycle = "active";
    if (currentNav === "bills") renderBills();
    updateNavCounts();
    if (!silent) closeBillDrawer();
  }
}

// POST the user's outcome verdict to the server. After it lands, refresh
// the bills list so the row drops out of the attention bucket and the
// drawer re-renders with the verified state.
async function submitOutcomeVerification(row, verified, notes, opts) {
  const silent = opts?.silent === true;
  const runId = row?.audit?.run_id;
  if (!runId) return;
  try {
    const res = await apiFetch("/api/bills/verify-outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ run_id: runId, verified, ...(notes ? { notes } : {}) }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(`Couldn't save: ${j.error ?? res.statusText}`);
      return;
    }
    const j = await res.json().catch(() => ({}));
    if (row.audit) {
      row.audit.outcome_verified = j.outcome_verified ?? verified;
      row.audit.outcome_verified_at = j.outcome_verified_at ?? Date.now();
      row.audit.outcome_notes = j.outcome_notes ?? notes ?? null;
      row.audit.needs_outcome_check = false;
    }
    row.attentionReason = null;
    if (currentNav === "bills") renderBills();
    updateNavCounts();
    // From the carousel the drawer was never open — re-opening it after
    // the user hits "Yes, it matched" feels like the action backfired.
    if (silent) return;
    // Re-open so the drawer reflects the new state (e.g. status pill).
    void openBillDrawer(row);
  } catch (err) {
    alert(`Couldn't save: ${err?.message ?? err}`);
  }
}

function openOutcomeNoMatchModal(row) {
  document.querySelector("#outcome-modal")?.remove();
  const wrap = document.createElement("div");
  wrap.id = "outcome-modal";
  wrap.className = "modal-scrim";
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="outcome-modal-title">
      <h2 class="modal-title" id="outcome-modal-title">What landed instead?</h2>
      <p class="modal-body">Pick what's closest, then add any notes Bonsai should know — we use this to tune the next negotiation.</p>
      <div class="outcome-choice-row" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button type="button" class="btn btn-ghost" data-outcome="partial">Partial — some discount, not full</button>
        <button type="button" class="btn btn-ghost" data-outcome="no">No — original amount stuck</button>
      </div>
      <label class="auth-field" style="margin-top:14px">
        <span>Notes (optional)</span>
        <textarea id="outcome-notes" rows="3" placeholder="What did the latest statement say?"></textarea>
      </label>
      <div class="auth-error" id="outcome-error" hidden></div>
      <div class="modal-actions" style="margin-top:14px">
        <button type="button" class="btn btn-ghost" id="outcome-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="outcome-confirm" disabled>Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector("#outcome-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (ev) => { if (ev.target === wrap) close(); });
  document.addEventListener("keydown", function onKey(ev) {
    if (ev.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  });

  let chosen = null;
  for (const btn of wrap.querySelectorAll("[data-outcome]")) {
    btn.addEventListener("click", () => {
      chosen = btn.dataset.outcome;
      for (const b of wrap.querySelectorAll("[data-outcome]")) b.classList.remove("btn-primary");
      btn.classList.add("btn-primary");
      wrap.querySelector("#outcome-confirm").disabled = false;
    });
  }

  const confirm = wrap.querySelector("#outcome-confirm");
  const errEl = wrap.querySelector("#outcome-error");
  confirm.addEventListener("click", async () => {
    if (!chosen) return;
    const notes = wrap.querySelector("#outcome-notes").value.trim();
    confirm.disabled = true;
    confirm.textContent = "Saving…";
    try {
      await submitOutcomeVerification(row, chosen, notes);
      close();
    } catch (err) {
      errEl.textContent = err?.message ?? "Network error.";
      errEl.hidden = false;
      confirm.disabled = false;
      confirm.textContent = "Save";
    }
  });
}

function renderDrawerFeedback(row) {
  return `
    <div class="dfb-tab">
      <div class="dfb-head">
        <div class="eyebrow">Feedback for next round</div>
        <div class="dfb-sub">The agent's paused on this bill. Tell it what to change — it'll apply your notes on resume.</div>
      </div>
      <div class="qa-log" id="drawer-feedback-log"></div>
      <form class="qa-form qa-form-chat" id="drawer-feedback-form">
        <input type="text" id="drawer-feedback-input" placeholder="e.g. 'Stop being aggressive' · 'Only email, no calls'" autocomplete="off" />
        <button type="submit" class="qa-send" aria-label="Send feedback">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
        </button>
      </form>
    </div>`;
}

function wireDrawerFeedback(row) {
  if (!row) return;
  const form = $("#drawer-feedback-form");
  if (form) {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      sendFeedback();
    });
  }
  void loadFeedback(row);
}

// Per-state synthetic timeline used when an attention row has no real
// negotiation report. Mirrors the cadence of a real audit (intake →
// extract → findings → plan → action) tailored to the reason.
function buildSyntheticAttentionTimeline(row) {
  const now = Date.now();
  const balance = row.balance ?? 0;
  const events = [
    {
      ts: now - 4 * 3600 * 1000,
      headline: `Bill received from ${row.vendor}`,
      detail: `Amount ${fmt$(balance)}${row.rate ?? ""}.`,
      channel: "intake",
      actor: "You",
      tone: "ink",
    },
    {
      ts: now - 3.5 * 3600 * 1000,
      headline: `Parsed bill & supporting docs`,
      detail: `Bonsai's analyzer pulled the line items, totals, and provider details from the document.`,
      channel: "claude",
      actor: "Bonsai · analyzer",
      tone: "ink",
    },
    {
      ts: now - 3 * 3600 * 1000,
      headline: `Audited for billing errors`,
      detail: `Found 3 high-confidence and 2 medium-confidence findings worth disputing.`,
      channel: "finding",
      actor: "Bonsai · analyzer",
      tone: "amber",
    },
    {
      ts: now - 2.5 * 3600 * 1000,
      headline: `Plan built`,
      detail: `Drafted appeal letter + chosen channels (email → call escalation).`,
      channel: "claude",
      actor: "Bonsai · planner",
      tone: "ink",
    },
  ];
  const reasonKey = row.attentionReason?.key;
  if (reasonKey === "awaiting") {
    events.push({
      ts: now - 30 * 60 * 1000,
      headline: `Waiting for your approval`,
      detail: `Open the Needs attention tab to review the plan and approve.`,
      channel: "watch",
      actor: "Bonsai",
      tone: "amber",
    });
  } else if (reasonKey === "escalated") {
    events.push({
      ts: now - 90 * 60 * 1000,
      headline: `First round dispatched`,
      detail: `Email sent to billing dept citing the high-confidence findings.`,
      channel: "mail",
      actor: "Bonsai · agent",
      tone: "ink",
    });
    const c = row.counter;
    events.push({
      ts: now - 35 * 60 * 1000,
      headline: c
        ? `Provider counter-offered ${fmt$(c.counter_amount)}`
        : `Provider counter-offered`,
      detail: c?.notes ?? `Counter is above the agent's target — your call to accept or push back.`,
      channel: "inbox",
      actor: row.vendor,
      tone: "red",
    });
  } else if (reasonKey === "paused") {
    events.push({
      ts: now - 80 * 60 * 1000,
      headline: `Negotiation in progress`,
      detail: `Email round sent to ${row.vendor}, awaiting reply.`,
      channel: "mail",
      actor: "Bonsai · agent",
      tone: "ink",
    });
    events.push({
      ts: now - 25 * 60 * 1000,
      headline: `You paused the agent`,
      detail: `Bonsai is holding off on the next round until you resume.`,
      channel: "system",
      actor: "You",
      tone: "amber",
    });
  } else if (reasonKey === "error") {
    events.push({
      ts: now - 90 * 60 * 1000,
      headline: `First round dispatched`,
      detail: `Email sent to billing dept.`,
      channel: "mail",
      actor: "Bonsai · agent",
      tone: "ink",
    });
    events.push({
      ts: now - 22 * 60 * 1000,
      headline: `Round failed`,
      detail: `Voice call simulator timed out reaching the provider line. Retrying usually clears it.`,
      channel: "system",
      actor: "Bonsai · agent",
      tone: "red",
    });
  }
  return events.sort((a, b) => b.ts - a.ts);
}

/* Build a sequenced activity timeline from the full report. */
function buildTimelineEvents(row, report) {
  const events = [];
  // Synthetic timeline for attention test rows that don't have a real
  // backend report yet — the user still needs to see *something* coherent
  // so they understand what landed them in this state.
  if (!report && row.attentionReason) {
    return buildSyntheticAttentionTimeline(row);
  }
  if (!report && row.kind !== "audit") {
    // Mock recurring bill — synthesize a simple watchlist timeline
    events.push({
      ts: Date.now() - 2 * 24 * 3600 * 1000,
      headline: `Added to watchlist`,
      detail: `Bonsai is continuously price-checking ${row.vendor}.`,
      channel: "system",
      tone: "ink",
    });
    events.push({
      ts: Date.now() - 24 * 3600 * 1000,
      headline: `Market scan complete`,
      detail: `Score ${row.score}/100 — ${row.scoreLabel}.`,
      channel: "scan",
      tone: row.score >= 70 ? "green" : row.score >= 50 ? "amber" : "red",
    });
    const offer = (typeof MOCK_OFFERS !== "undefined" ? MOCK_OFFERS : [])
      .find((o) => o.baseline?.current_provider === row.vendor);
    if (offer) {
      events.push({
        ts: Date.now() - 6 * 3600 * 1000,
        headline: `Cheaper alternative found — ${offer.source}`,
        detail: `${fmt$(offer.current)} → ${fmt$(offer.offered)}${offer.unit}. ${offer.why}`,
        channel: "offer",
        tone: "green",
      });
    }
    events.push({
      ts: Date.now() - Math.max(1, parseRelTime(row.lastCheck)),
      headline: `Last check`,
      detail: `Amount ${fmt$(row.balance)}${row.rate}.`,
      channel: "watch",
      tone: "ink",
    });
    return events.sort((a, b) => b.ts - a.ts);
  }

  if (!report) return events;

  const baseTs = row?.audit?.modified ?? Date.now();
  const meta = report.analyzer?.metadata ?? {};
  const findings = report.analyzer?.errors ?? [];
  const summary = report.summary ?? {};
  const strategy = report.strategy ?? {};

  // 1. Bill received
  events.push({
    ts: baseTs - 120 * 1000,
    headline: `Bill received from ${meta.provider_name ?? row.vendor}`,
    detail: [
      meta.date_of_service ? `Service date ${meta.date_of_service}` : null,
      meta.claim_number ? `Claim ${meta.claim_number}` : null,
      summary.original_balance != null ? `Amount ${fmt$(summary.original_balance)}` : null,
    ].filter(Boolean).join(" · "),
    channel: "intake",
    actor: "Patient",
    tone: "ink",
  });

  // 2. Extract
  events.push({
    ts: baseTs - 90 * 1000,
    headline: `Parsed bill & supporting docs`,
    detail: `Pulled ${findings.length || "all"} findings from the itemized bill${report.analyzer?.eob ? " and EOB" : ""}.`,
    channel: "claude",
    actor: "Bonsai · analyzer",
    tone: "ink",
  });

  // 3. HIGH-confidence findings
  const highs = findings.filter((f) => (f.confidence ?? "").toUpperCase() === "HIGH");
  highs.slice(0, 5).forEach((f, i) => {
    events.push({
      ts: baseTs - (80 - i) * 1000,
      headline: `Flagged: ${labelForFinding(f)}`,
      detail: f.line_quote ? `"${f.line_quote}"` : (f.description ?? ""),
      detailClass: "quote",
      channel: "finding",
      actor: `Confidence ${f.confidence}`,
      tone: "red",
    });
  });
  const mediums = findings.filter((f) => (f.confidence ?? "").toUpperCase() === "MEDIUM");
  if (mediums.length > 0) {
    events.push({
      ts: baseTs - 65 * 1000,
      headline: `${mediums.length} additional MEDIUM-confidence issues queued`,
      detail: mediums.slice(0, 3).map((m) => `· ${labelForFinding(m)}`).join("\n"),
      channel: "finding",
      actor: "Bonsai · analyzer",
      tone: "amber",
    });
  }

  // 4. Appeal drafted
  const appeal = report.appeal || report.letter;
  if (appeal?.markdown || appeal?.subject) {
    events.push({
      ts: baseTs - 50 * 1000,
      headline: `Appeal letter drafted`,
      detail: appeal.subject ? `Subject: ${appeal.subject}` : `${(appeal.markdown || "").length} chars`,
      channel: "letter",
      actor: "Bonsai · drafter",
      tone: "ink",
    });
  }

  // 5. Strategy picked
  if (strategy.chosen) {
    events.push({
      ts: baseTs - 45 * 1000,
      headline: `Channel selected — ${strategy.chosen.toUpperCase()}`,
      detail: strategy.rationale ?? "",
      channel: "strategy",
      actor: "Bonsai · router",
      tone: "ink",
    });
  }

  // 6. Email thread — messages use { role, subject, body, ts }
  const email = report.email_thread;
  if (email && Array.isArray(email.messages)) {
    email.messages.forEach((m) => {
      const isOut = m.role === "outbound";
      events.push({
        ts: Date.parse(m.ts),
        headline: isOut
          ? `Email sent — ${m.subject ?? "(no subject)"}`
          : `Reply received — ${m.subject ?? "(no subject)"}`,
        detail: (m.body ?? "").trim().split("\n").slice(0, isOut ? 4 : 6).join("\n"),
        channel: "email",
        actor: isOut ? "Bonsai → billing" : "Billing dept → Bonsai",
        tone: isOut ? "ink" : "amber",
      });
    });
  }

  // 7. Voice
  const voice = report.voice_call;
  if (voice) {
    events.push({
      ts: Date.parse(voice.started_at ?? new Date(baseTs).toISOString()),
      headline: `Voice call placed — ${voice.destination ?? "billing dept"}`,
      detail: voice.opener ? `Opener: "${voice.opener}"` : "",
      channel: "voice",
      actor: "Bonsai · caller",
      tone: "ink",
    });
    (voice.turns ?? []).slice(0, 8).forEach((t, i) => {
      events.push({
        ts: Date.parse(t.ts ?? new Date(baseTs + i * 1000).toISOString()),
        headline: t.speaker === "agent" ? "Bonsai (on call)" : "Rep (on call)",
        detail: t.text ?? "",
        channel: "voice",
        actor: t.speaker === "agent" ? "Bonsai" : (voice.destination ?? "Rep"),
        tone: t.speaker === "agent" ? "ink" : "amber",
      });
    });
  }

  // 9. Persistent run attempts
  const persistent = report.persistent_run;
  if (persistent && Array.isArray(persistent.attempts)) {
    persistent.attempts.forEach((a, i) => {
      const isBest = persistent.best && persistent.best.channel === a.channel
        && persistent.best.final_amount === a.final_amount;
      events.push({
        ts: baseTs + (i + 1) * 200,
        headline: `Persistent · ${a.channel.toUpperCase()} landed at ${a.final_amount != null ? fmt$(a.final_amount) : "—"}${isBest ? " · best" : ""}`,
        detail: a.outcome_detail ?? "",
        channel: "persistent",
        actor: a.outcome,
        tone: isBest ? "green" : a.outcome === "escalated" ? "amber" : "ink",
      });
    });
  }

  // 10. Resolution
  if (summary.outcome) {
    events.push({
      ts: baseTs,
      headline: summary.outcome === "resolved"
        ? `Resolved — settled at ${fmt$(summary.final_balance ?? 0)}`
        : summary.outcome === "escalated"
          ? `Escalated — needs your approval`
          : `Outcome: ${summary.outcome}`,
      detail: summary.patient_saved
        ? `Patient saved ${fmt$(summary.patient_saved)} vs original ${fmt$(summary.original_balance ?? 0)}.`
        : "",
      channel: "result",
      actor: "Bonsai",
      tone: summary.outcome === "resolved" ? "green" : summary.outcome === "escalated" ? "amber" : "ink",
    });
  }

  return events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function renderActivityTimeline(row, report) {
  const events = buildTimelineEvents(row, report);
  if (events.length === 0) {
    return `<div class="dact-empty">No activity yet. Run an audit to start the log.</div>`;
  }
  const rows = events.map((ev) => {
    const timeStr = ev.ts ? formatClockTs(ev.ts) : "";
    return `
      <div class="dact-event tone-${ev.tone || "ink"}">
        <div class="dact-headline">${escapeHtml(ev.headline)}</div>
        <div class="dact-time">${escapeHtml(timeStr)}</div>
        ${ev.actor ? `<div class="dact-actor">${escapeHtml(ev.channel.toUpperCase())} · ${escapeHtml(ev.actor)}</div>` : `<div class="dact-channel">${escapeHtml((ev.channel || "").toUpperCase())}</div>`}
        ${ev.detail ? `<div class="dact-detail ${ev.detailClass || ""}">${escapeHtml(ev.detail)}</div>` : ""}
      </div>`;
  }).join("");
  return `<div class="dact-timeline">${rows}</div>`;
}

function renderDrawerFindings(row, report) {
  const errs = report?.analyzer?.errors ?? [];
  if (errs.length === 0) return `<div class="dact-empty">No findings.</div>`;
  return errs.map((e) => {
    const conf = (e.confidence ?? "").toUpperCase();
    return `
      <div class="dfind-row">
        <div class="dfind-row-head">
          <div class="dfind-title">${escapeHtml(labelForFinding(e))}</div>
          <span class="mono">${conf} · ${e.overcharge_amount != null ? fmt$(e.overcharge_amount) : ""}</span>
        </div>
        ${e.description ? `<div style="font-size:12.5px;color:var(--ink-soft);line-height:1.5">${escapeHtml(e.description)}</div>` : ""}
        ${e.line_quote ? `<div class="dfind-quote">"${escapeHtml(e.line_quote)}"</div>` : ""}
      </div>`;
  }).join("");
}

// Build a high-level "what the agent did" step list from the email thread —
// not a transcript, but the negotiator's reasoning trail. Reads the
// outcome state for the final step. Classifies inbound replies by keyword
// since we don't yet persist the agent's classification (planned).
function buildAgentSteps(email) {
  if (!email?.messages?.length) return [];
  const steps = [];
  const messages = [...email.messages].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isOut = m.role === "outbound";
    if (isOut && i === 0) {
      steps.push({
        label: "Drafted initial appeal",
        detail: "Letter grounded in analyzer findings; cited NSA where applicable.",
        kind: "outbound",
      });
      continue;
    }
    if (!isOut) {
      const cls = classifyInbound(m.body ?? "");
      steps.push({
        label: `Reply received — classified as ${cls.label}`,
        detail: cls.hint,
        kind: cls.kind,
      });
      continue;
    }
    // Subsequent outbound: agent's response after seeing a reply.
    const tactic = inferOutboundTactic(m.body ?? "");
    steps.push({
      label: `Drafted follow-up — ${tactic.label}`,
      detail: tactic.hint,
      kind: "outbound",
    });
  }
  // Outcome step from saved NegotiationState.
  const outcome = email?.state?.outcome;
  if (outcome) {
    if (outcome.status === "resolved") {
      steps.push({
        label: `Marked resolved — ${(outcome.resolution || "").replace(/_/g, " ")}`,
        detail: outcome.notes || "",
        kind: "resolved",
      });
    } else if (outcome.status === "escalated") {
      steps.push({
        label: `Escalated — ${outcome.reason}`,
        detail: outcome.notes || "",
        kind: "escalated",
      });
    }
  }
  return steps;
}

function classifyInbound(body) {
  const t = String(body || "").toLowerCase();
  if (/lawyer|attorney|legal action|collections agency/.test(t))
    return { label: "legal pressure", kind: "danger", hint: "Provider escalated to legal language." };
  if (/(approv|adjust|credit|reduce|reduced|zero out|write off|forgive|removed)/.test(t))
    return { label: "concession", kind: "good", hint: "Provider conceded part or all of the dispute." };
  if (/(deny|denied|decline|won't|will not|unable to|cannot adjust)/.test(t))
    return { label: "denial", kind: "warn", hint: "Provider rejected the appeal — counter with NSA + EOB." };
  if (/(review|looking into|investigate|we will|please allow|processing|pending)/.test(t))
    return { label: "stall", kind: "warn", hint: "Provider asked for time without committing — keep pressure on." };
  if (/(send.*records|provide.*documentation|need.*itemized|please send)/.test(t))
    return { label: "request for info", kind: "warn", hint: "Provider asked for more documentation." };
  return { label: "ambiguous", kind: "warn", hint: "Reply did not match a known pattern." };
}

function inferOutboundTactic(body) {
  const t = String(body || "").toLowerCase();
  if (/no surprises act|nsa|surprise billing/.test(t))
    return { label: "cited No Surprises Act", hint: "Anchored on federal law for balance billing." };
  if (/duplicate|billed twice|same procedure|same date of service/.test(t))
    return { label: "called out duplicate billing", hint: "Pointed to repeated charges in the bill." };
  if (/14 day|14-day|deadline|within 14|by \d/.test(t))
    return { label: "set 14-day response deadline", hint: "Pressed a concrete reply window." };
  if (/escalat|supervis|manager/.test(t))
    return { label: "asked for a supervisor", hint: "Requested escalation in the billing dept." };
  if (/cfpb|fcra|credit report/.test(t))
    return { label: "cited credit-reporting protection", hint: "Anchored on FCRA / CFPB rules." };
  return { label: "restated the dispute", hint: "Quoted the EOB and reasserted the patient responsibility." };
}

function renderAgentTimeline(email) {
  const steps = buildAgentSteps(email);
  if (steps.length === 0) return "";
  const items = steps
    .map((s, i) => {
      const last = i === steps.length - 1;
      return `
        <li class="agent-step kind-${s.kind}">
          <div class="agent-step-dot" aria-hidden="true">${i + 1}</div>
          <div class="agent-step-body">
            <div class="agent-step-label">${escapeHtml(s.label)}</div>
            ${s.detail ? `<div class="agent-step-detail">${escapeHtml(s.detail)}</div>` : ""}
          </div>
          ${last ? "" : '<div class="agent-step-bar" aria-hidden="true"></div>'}
        </li>`;
    })
    .join("");
  return `
    <div class="agent-timeline">
      <div class="dmsg-section-head"><div class="eyebrow">Agent reasoning</div><div class="mono" style="font-size:11px;color:var(--ink-mute)">${steps.length} step${steps.length === 1 ? "" : "s"}</div></div>
      <ol class="agent-steps">${items}</ol>
    </div>`;
}

function renderDrawerMessages(row, report) {
  const parts = [];
  const email = report?.email_thread;
  if (email) {
    const tl = renderAgentTimeline(email);
    if (tl) parts.push(tl);
  }
  if (email?.messages?.length) {
    parts.push(`<div class="dmsg-section-head"><div class="eyebrow">Email thread</div><div class="mono" style="font-size:11px;color:var(--ink-mute)">${email.messages.length} msgs</div></div>`);
    email.messages.forEach((m) => {
      const isOut = m.role === "outbound";
      parts.push(`
        <div class="dmsg-msg ${isOut ? "out" : ""}">
          <div class="dmsg-meta"><span>${isOut ? "→ billing" : "← billing"}</span><span>${escapeHtml(formatClockTs(Date.parse(m.ts)))}</span></div>
          <div class="dmsg-subject">${escapeHtml(m.subject ?? "(no subject)")}</div>
          <div class="dmsg-body">${escapeHtml(m.body ?? "")}</div>
        </div>`);
    });
  }
  const voice = report?.voice_call;
  if (voice?.turns?.length) {
    parts.push(`<div class="dmsg-section-head"><div class="eyebrow">Voice call</div><div class="mono" style="font-size:11px;color:var(--ink-mute)">${voice.turns.length} turns</div></div>`);
    voice.turns.forEach((t) => {
      parts.push(`
        <div class="dmsg-msg ${t.speaker === "agent" ? "out" : ""}">
          <div class="dmsg-meta"><span>${t.speaker === "agent" ? "Bonsai" : escapeHtml(voice.destination ?? "Rep")}</span><span>${t.ts ? escapeHtml(formatClockTs(Date.parse(t.ts))) : ""}</span></div>
          <div class="dmsg-body">${escapeHtml(t.text ?? "")}</div>
        </div>`);
    });
  }
  if (parts.length === 0) return `<div class="dact-empty">No messages yet.</div>`;
  return parts.join("");
}

function renderDrawerReport(row, report) {
  if (!report) return `<div class="dact-empty">No report payload.</div>`;
  return `<pre class="drawer-pre">${escapeHtml(JSON.stringify(report, null, 2))}</pre>`;
}

function labelForFinding(f) {
  const base = (f.type || f.category || f.kind || "issue").replace(/_/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function formatClockTs(ms) {
  if (!ms || Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${date} · ${time}`;
}

function parseRelTime(str) {
  if (!str) return 60 * 1000;
  const m = String(str).match(/(\d+)\s*(s|min|hour|day)/);
  if (!m) return 60 * 1000;
  const n = parseInt(m[1], 10);
  if (m[2] === "s") return n * 1000;
  if (m[2] === "min") return n * 60 * 1000;
  if (m[2] === "hour") return n * 3600 * 1000;
  if (m[2] === "day") return n * 86400 * 1000;
  return 60 * 1000;
}

// Global drawer bindings (once)
document.addEventListener("DOMContentLoaded", () => {
  const scrim = $("#drawer-scrim");
  const closeBtn = $("#drawer-close");
  if (scrim) scrim.addEventListener("click", closeBillDrawer);
  if (closeBtn) closeBtn.addEventListener("click", closeBillDrawer);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && $("#bill-drawer")?.classList.contains("open")) closeBillDrawer();
  });
});

/**
 * Voice-call pre-dial confirmation modal. Fetches the operator's pinned
 * cost estimate, shows the user the provider + phone they're about to call
 * and the price range, and only fires POST /api/voice/dial on Confirm.
 *
 * Errors from the dial endpoint (429 daily-limit / 429 budget-cap / 412
 * missing phone) are rendered inline in the modal body — the user can
 * cancel without leaving the bill they were viewing.
 *
 * Exposed on `window.dialVoiceWithConfirm` so any future "Negotiate by
 * phone" button can call it without further rewiring.
 */
async function dialVoiceWithConfirm({ runId, providerName, providerPhone, onSuccess, onError } = {}) {
  if (!runId) throw new Error("dialVoiceWithConfirm: missing runId");
  const modal = document.getElementById("voice-confirm-modal");
  const scrim = document.getElementById("voice-confirm-scrim");
  const costEl = document.getElementById("voice-confirm-cost");
  const targetEl = document.getElementById("voice-confirm-target");
  const errEl = document.getElementById("voice-confirm-error");
  const goBtn = document.getElementById("voice-confirm-go");
  const cancelBtn = document.getElementById("voice-confirm-cancel");
  if (!modal || !scrim || !costEl || !goBtn || !cancelBtn) return;

  const friendlyTarget = providerName
    ? `Bonsai will call ${escapeHtml(providerName)}${providerPhone ? ` at ${escapeHtml(providerPhone)}` : ""}.`
    : providerPhone
    ? `Bonsai will call ${escapeHtml(providerPhone)}.`
    : "Bonsai will place an outbound call to the provider on file.";
  if (targetEl) targetEl.innerHTML = friendlyTarget;

  errEl.hidden = true;
  errEl.textContent = "";
  goBtn.disabled = false;

  try {
    const res = await apiFetch("/api/voice/cost");
    if (res.ok) {
      const j = await res.json();
      const min = typeof j?.min_usd === "number" ? `$${j.min_usd.toFixed(2)}` : "$0.82";
      const max = typeof j?.max_usd === "number" ? `$${j.max_usd.toFixed(2)}` : "$2.46";
      costEl.textContent = `${min}–${max}`;
    }
  } catch {
    /* fall back to the placeholder copy already in the DOM */
  }

  modal.hidden = false;
  scrim.hidden = false;

  const close = () => {
    modal.hidden = true;
    scrim.hidden = true;
    goBtn.removeEventListener("click", onGo);
    cancelBtn.removeEventListener("click", onCancel);
    scrim.removeEventListener("click", onCancel);
  };
  function onCancel() {
    close();
  }
  async function onGo() {
    goBtn.disabled = true;
    errEl.hidden = true;
    errEl.textContent = "";
    try {
      const res = await apiFetch("/api/voice/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          body?.message ||
          body?.error ||
          (res.status === 429
            ? "Daily voice call limit hit. Try again tomorrow."
            : "Couldn't start the call. Try again in a moment.");
        errEl.textContent = msg;
        errEl.hidden = false;
        goBtn.disabled = false;
        if (typeof onError === "function") onError({ status: res.status, body });
        return;
      }
      close();
      if (typeof onSuccess === "function") onSuccess(body);
    } catch (err) {
      errEl.textContent = `Network error: ${String(err?.message ?? err)}`;
      errEl.hidden = false;
      goBtn.disabled = false;
      if (typeof onError === "function") onError({ status: 0, body: { error: String(err?.message ?? err) } });
    }
  }
  goBtn.addEventListener("click", onGo);
  cancelBtn.addEventListener("click", onCancel);
  scrim.addEventListener("click", onCancel);
}
window.dialVoiceWithConfirm = dialVoiceWithConfirm;

init();
