// Bonsai front-end — vanilla JS driving the editorial UI.
// Four views: Overview (upload + approvals), Bills (tracked bills status),
// Offers (agent-hunted deals), Settings (agent config + integrations).
// Progress/Results/Error are overlay-style views inside the main content area.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const FLOW_STAGES = ["Extract", "Audit", "Negotiate", "Finalize"];

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
    sub: "Email, SMS, or phone — choosing the fastest path to the person who can say yes." },
  { stage: 2, kind: "phone", title: "Opening negotiation",
    sub: "Real outbound: email sent, call placed, or text thread started with the provider's billing contact." },
  { stage: 3, kind: "check", title: "Building your report",
    sub: "Findings, appeal letter, and savings summary — ready for you to review or sign." },
];

let timelineTimer = null;
let currentNav = "overview";
let historyCache = null;

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

function setWorkflowView(view) {
  // overview | progress | review | results | error — all sub-views inside the main content area.
  // Only one of these is visible at a time when nav=overview.
  for (const v of ["overview", "progress", "review", "results", "error"]) {
    const el = $(`#view-${v}`);
    if (!el) continue;
    if (v === view) el.classList.remove("hidden");
    else el.classList.add("hidden");
  }
}

function showNav(name) {
  currentNav = name;
  if (name !== "bills") stopBillsPoll();
  // Toggle sidebar nav active state
  for (const n of $$(".nav-item")) {
    n.classList.toggle("active", n.dataset.nav === name);
  }
  // Hide every view; the nav-specific ones get revealed below
  for (const v of ["overview", "progress", "review", "results", "error", "bills", "offers", "settings"]) {
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

// ─── Init ──────────────────────────────────────────────────────

async function init() {
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

  // Fixture dropdown
  const fixtures = await fetch("/api/fixtures").then((r) => r.json()).catch(() => ({ fixtures: [] }));
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

  // ─── Multi-file staging: drop/pick up to 10 files, review, then "Next" ──
  const uploadForm = $("#upload-form");
  const MAX_BILL_FILES = 10;
  /** @type {File[]} Files queued for upload, in order. */
  let stagedFiles = [];
  let uploadSubmittedOnce = false;

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
      prefetchPromise = fetch("/api/audit", { method: "POST", body: form, signal: controller.signal })
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
    const p = fetch("/api/thumbnail", { method: "POST", body: form })
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
    if (!block || !grid || !count) return;
    if (stagedFiles.length === 0) {
      block.hidden = true;
      grid.innerHTML = "";
      count.textContent = "0";
      return;
    }
    block.hidden = false;
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
  // The review view has a single unified chat panel (plan-chat). Q&A is
  // folded into it — the routing brain figures out whether the message is
  // a question or a plan edit.
  $("#review-plan-chat-form")?.addEventListener("submit", (ev) => { ev.preventDefault(); submitPlanMessage(); });
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
  renderApprovalsOnOverview();

  // Default view
  showNav("overview");
}

async function loadHistory() {
  try {
    historyCache = await fetch("/api/history").then((r) => r.json());
  } catch {
    historyCache = { audits: [], letters: [] };
  }
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

  // Bills: audits that finished (resolved or escalated) since the last visit.
  const newlyFinished = audits.filter(
    (a) => (a.outcome === "resolved" || a.outcome === "escalated") && !billSeen(a.name),
  ).length;
  setNavCount("#nav-bills-count", newlyFinished);

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
    title: "Auditing the bill &amp; running grounded negotiation.",
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

async function runPhasedFromSample(fixture, channel) {
  setWorkflowView("progress");
  updatePageHeader({
    eyebrow: "Audit in progress",
    title: "Reading the bill &amp; finding every overcharge.",
  });
  startTimeline();
  try {
    const res = await fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixture, channel }),
    });
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

async function runPhasedFromUpload(formData) {
  setWorkflowView("progress");
  updatePageHeader({
    eyebrow: "Audit in progress",
    title: "Reading the bill &amp; finding every overcharge.",
  });
  startTimeline();
  try {
    const res = await fetch("/api/audit", { method: "POST", body: formData });
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
    title: "Reading the bill &amp; finding every overcharge.",
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
}

async function loadOpportunities(report) {
  const runId = reviewState?.run_id;
  if (!runId) return;
  try {
    const res = await fetch("/api/opportunities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { opportunities } = await res.json();
    // Guard: if the current reviewState has moved on, bail.
    if (reviewState?.run_id !== runId) return;
    const normalized = (opportunities ?? []).map((o) => ({
      icon: ICONS[o.icon] ?? ICONS.pulse,
      title: o.title,
      desc: o.description,
      estimate: Number(o.dollar_estimate) || 0,
    }));
    const total = normalized.reduce((s, o) => s + (o.estimate ?? 0), 0);
    const provider = report.analyzer?.metadata?.provider_name ?? "the provider";
    $("#review-title").textContent = total > 0
      ? `We think we can save you ${fmt$(total)} on this ${providerKindLabel(report)}.`
      : "Bill reviewed — a few angles to try.";
    $("#review-sub").textContent = `${provider}. Original ${fmt$2(report.summary.original_balance ?? 0)}. Accept the plan or chat with Bonsai below to customize.`;
    renderOpportunities(normalized, total);
  } catch (err) {
    console.warn("[opps] falling back to synthesized", err);
    const fallback = buildOpportunities(report);
    const total = fallback.reduce((s, o) => s + (o.estimate ?? 0), 0);
    $("#review-title").textContent = total > 0
      ? `We think we can save you ${fmt$(total)} on this bill.`
      : "Bill reviewed — a few angles to try.";
    renderOpportunities(fallback, total);
  }
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

function renderOpportunities(opps, total) {
  $("#opps-total").textContent = total > 0 ? fmt$(total) : "—";
  const ul = $("#opps-list");
  ul.innerHTML = "";
  if (opps.length === 0) {
    const li = document.createElement("li");
    li.className = "opp-empty";
    li.textContent = "No clear savings angles on this one — the provider seems to be charging fairly. We'll still try a prompt-pay ask.";
    ul.appendChild(li);
    return;
  }
  for (const o of opps) {
    const li = document.createElement("li");
    li.className = "opp-item";
    li.innerHTML = `
      <div class="opp-icon">${o.icon ?? ICONS.pulse}</div>
      <div class="opp-body">
        <div class="opp-title">${escapeHtml(o.title)}</div>
        <div class="opp-desc">${escapeHtml(o.desc)}</div>
      </div>
      <div class="opp-amount">${o.estimate > 0 ? fmt$(o.estimate) : "—"}</div>`;
    ul.appendChild(li);
  }
}

/**
 * Synthesize a list of strategies to lower this bill with dollar estimates.
 * Pulls from analyzer findings where available, then layers on universal
 * levers (prompt-pay, competitor threat, financial hardship) so the user
 * always sees multiple angles — not just billing errors.
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
      icon: ICONS.shield,
      title: `Dispute ${high.length} billing error${high.length === 1 ? "" : "s"}`,
      desc: "Grounded citations against the bill. Duplicates, denied services, and balance-billing overlap all defensible on paper.",
      estimate: defensible,
    });
  }

  // 2. Worth-reviewing items — lower confidence but worth surfacing
  if (worth.length > 0) {
    const worthTotal = worth.reduce((s, e) => s + (e.dollar_impact ?? 0), 0);
    out.push({
      icon: ICONS.scan,
      title: `Challenge ${worth.length} questionable charge${worth.length === 1 ? "" : "s"}`,
      desc: "Unbundling, markup, and other soft flags. Lower win rate, but often negotiable.",
      estimate: Math.round(worthTotal * 0.5),
    });
  }

  // 3. Prompt-pay / negotiate the remaining balance
  if (remainingAfterDispute > 200) {
    const estimate = Math.round(remainingAfterDispute * 0.15);
    out.push({
      icon: ICONS.pulse,
      title: "Negotiate the remaining balance",
      desc: "Ask for a prompt-pay discount (10–20% is typical) and a single-settlement write-off on whatever's left.",
      estimate,
    });
  }

  // 4. Terms & loopholes
  out.push({
    icon: ICONS.doc,
    title: "Hunt for T&C loopholes",
    desc: "Review the provider's own policy — late-fee caps, good-faith-estimate discrepancies (No Surprises Act), charity care thresholds, or hidden itemization rules.",
    estimate: Math.round(original * 0.05),
  });

  // 5. Competitor leverage / threat to cancel
  out.push({
    icon: ICONS.phone,
    title: "Leverage a competitor offer",
    desc: "If there's a cheaper provider or a cancel-threat angle (subscriptions, utilities, pet insurance), we use it.",
    estimate: Math.round(original * 0.08),
  });

  return out;
}


async function submitPlanMessage() {
  if (!reviewState) return;
  const input = $("#review-plan-chat-input");
  const msg = input.value.trim();
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
    const res = await fetch("/api/plan-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: reviewState.run_id, message: msg }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { reply, strategy } = await res.json();
    thinking.querySelector(".qa-body").textContent = reply;
    if (strategy && reviewState.partial_report) {
      // Store the new strategy on the report so approve() picks it up. The
      // receipt + opportunities panels don't depend on channel choice, so
      // no re-render is needed here.
      reviewState.partial_report.strategy = strategy;
    }
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
  // Negotiation runs in the background. Kick it off, then hand the user
  // off to the Bills view — updates will stream in as the bg job progresses
  // (polled via /api/history).
  try {
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: reviewState.run_id }),
    });
    if (!res.ok) throw new Error(await res.text());
    await res.json();
    reviewState = null;
    await loadHistory();
    updateNavCounts();
    showNav("bills");
  } catch (err) {
    $("#error-body").textContent = String(err?.message ?? err);
    setWorkflowView("error");
  }
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
      eyebrow: "Bills",
      title: "Every bill monitored",
      stats: null,
    });
  } else if (currentNav === "offers") {
    updatePageHeader({
      eyebrow: "Offers",
      title: "Cheaper alternatives, found for you.",
      stats: null,
    });
  } else if (currentNav === "settings") {
    updatePageHeader({
      eyebrow: "Settings",
      title: "Tune the agent.",
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
  const savedPositive = typeof s.patient_saved === "number" && s.patient_saved > 0;
  const heroTitle = $("#hero-title");
  const heroAmount = document.createElement("span");
  heroAmount.className = "hero-amount";
  heroAmount.textContent = savedPositive ? fmt$2(s.patient_saved) : (s.patient_saved != null ? fmt$2(s.patient_saved) : "—");
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
  $("#stat-saved").textContent = savedPositive ? fmt$2(s.patient_saved) : "—";
  $("#stat-channel").textContent = s.channel_used ? s.channel_used.toUpperCase() : "—";

  updatePageHeader({
    eyebrow: "Audit complete",
    title: report.analyzer.metadata.provider_name
      ? `${escapeHtml(report.analyzer.metadata.provider_name)}.`
      : "Audit results.",
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
      ? `<span class="tag tag-mono tag-green">FLOOR HIT</span>`
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
      <div class="persistent-meta">Floor: <strong>${fmt$(pr.floor)}</strong> · Original: <strong>${fmt$(pr.original_balance)}</strong> · Total saved: <strong>${pr.total_saved ? fmt$(pr.total_saved) : "—"}</strong></div>
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

  if (report.sms_thread) {
    addSection(report.sms_thread.handed_off_to_voice ? "SMS — handed off to voice" : "SMS");
    for (const msg of report.sms_thread.messages) {
      const el = document.createElement("div");
      el.className = `conv-msg sms ${msg.role === "outbound" ? "us" : "them"}`;
      const meta = document.createElement("div");
      meta.className = "conv-meta";
      const who = document.createElement("span");
      who.className = msg.role === "outbound" ? "who-us" : "who-them";
      who.textContent = msg.role === "outbound" ? "→ BONSAI" : "← PROVIDER";
      meta.appendChild(who);
      const ts = document.createElement("span");
      ts.textContent = new Date(msg.ts).toLocaleString();
      meta.appendChild(ts);
      const seg = document.createElement("span");
      const len = msg.body?.length ?? 0;
      const segs = msg.segments ?? (len <= 160 ? 1 : Math.ceil(len / 153));
      seg.textContent = `${len} chars · ${segs} seg`;
      meta.appendChild(seg);
      const bodyEl = document.createElement("div");
      bodyEl.className = "conv-body sms-body";
      bodyEl.textContent = msg.body;
      el.append(meta, bodyEl);
      root.appendChild(el);
    }
    rendered = true;
  }

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

// ─── Approvals (Overview) ───────────────────────────────────────

function renderApprovalsOnOverview() {
  const root = $("#approvals-grid");
  const block = $("#approvals-block");
  const title = $("#approvals-title");
  if (!root || !block) return;
  const audits = historyCache?.audits ?? [];
  const escalated = audits.filter((a) => a.outcome === "escalated");
  if (!escalated.length) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  title.textContent = escalated.length === 1
    ? "One negotiation needs your sign-off."
    : `${escalated.length} negotiations need your sign-off.`;
  root.innerHTML = "";
  for (const a of escalated) {
    const card = document.createElement("div");
    card.className = "approval-card";
    card.innerHTML = `
      <div class="approval-card-head">
        <div class="approval-card-icon">${ICONS.hospital}</div>
        <div class="approval-card-meta">${(a.channel_used ?? "email").toUpperCase()} · ${a.date_of_service ?? "—"}</div>
        <div class="approval-card-save">${fmt$(a.patient_saved ?? 0)}</div>
      </div>
      <div class="approval-card-title">${escapeHtml(a.provider_name ?? a.name)}</div>
      <div class="approval-card-body">Provider countered. Defensible floor: <strong>${fmt$(a.defensible_disputed ?? 0)}</strong>. Approve to accept or push back.</div>
      <div class="approval-card-actions">
        <button class="btn btn-ghost" data-act="reject">Push back</button>
        <button class="btn btn-primary" data-act="approve">Approve</button>
      </div>`;
    root.appendChild(card);
  }
}

// ─── Mock recurring bills + offers + settings ──────────────────
// Real audit data from /api/history + these recurring medical bills fill out the Bills table.
// These represent the long-tail the agent watches month-over-month.

const MOCK_RECURRING_BILLS = [
  {
    id: "mock-cell-1", kind: "cell", vendor: "Verizon Wireless",
    account: "4 lines · unlimited plan",
    lastCheck: "3 minutes ago",
    addedAt: Date.now() - 45 * 24 * 3600 * 1000,
    balance: 187, rate: "/mo",
    category: "Cell phone",
    score: 58,
    auto: true,
  },
  {
    id: "mock-cable-1", kind: "cable", vendor: "Xfinity",
    account: "Gigabit internet + TV bundle",
    lastCheck: "18 minutes ago",
    addedAt: Date.now() - 12 * 24 * 3600 * 1000,
    balance: 159, rate: "/mo",
    category: "Internet",
    score: 32,
    auto: true,
  },
  {
    id: "mock-security-1", kind: "security", vendor: "ADT Home Security",
    account: "Monitored alarm · 24/7",
    lastCheck: "1 hour ago",
    addedAt: Date.now() - 75 * 24 * 3600 * 1000,
    balance: 52, rate: "/mo",
    category: "Security system",
    score: 78,
    auto: false,
  },
  {
    id: "mock-electric-1", kind: "electricity", vendor: "PG&E",
    account: "Residential · account 8821-A",
    lastCheck: "42 minutes ago",
    addedAt: Date.now() - 6 * 24 * 3600 * 1000,
    balance: 234, rate: "/mo",
    category: "Electricity",
    score: 48,
    auto: true,
  },
  {
    id: "mock-carins-1", kind: "car-insurance", vendor: "Geico",
    account: "2 vehicles · full coverage",
    lastCheck: "2 hours ago",
    addedAt: Date.now() - 90 * 24 * 3600 * 1000,
    balance: 168, rate: "/mo",
    category: "Car insurance",
    score: 44,
    auto: true,
  },
  {
    id: "mock-other-1", kind: "other", vendor: "Planet Fitness",
    account: "Black Card · annual renewal",
    lastCheck: "6 hours ago",
    addedAt: Date.now() - 20 * 24 * 3600 * 1000,
    balance: 25, rate: "/mo",
    category: "Other",
    score: 66,
    auto: false,
  },
];
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
  audit: ICONS.doc,
};

// Each offer carries a backend `baseline` so "Switch for me" runs a real
// /api/offer-hunt against the matching source directory. The cheaper numbers
// you see on the card are what the hunt typically produces — clicking
// triggers a live reach-out (email/sms/voice simulation) to the directory and
// surfaces the actual quotes.
const MOCK_OFFERS = [
  {
    id: "off-1", category: "Prescriptions", source: "GoodRx coupon",
    icon: "pill",
    confidence: "HIGH",
    current: 214, offered: 62, saves: 152, unit: "/mo",
    why: "Same atorvastatin 20mg, same CVS — GoodRx negotiated rate beats your plan's copay.",
    friction: "Show the coupon at pickup. No switching pharmacies.",
    eta: "Apply in 2 min",
    recommended: true,
    baseline: {
      label: "Atorvastatin 20mg monthly", category: "prescription",
      current_provider: "CVS (insurance copay)", current_price: 214,
      specifics: "atorvastatin 20mg, 30 tablets/mo", region: "SF 94114",
    },
  },
  {
    id: "off-2", category: "Premium", source: "Covered California silver",
    icon: "shield",
    confidence: "HIGH",
    current: 487, offered: 312, saves: 175, unit: "/mo",
    why: "Household income qualifies you for APTC subsidy. Same network, lower premium.",
    friction: "30-min enrollment call, takes effect 1st of next month.",
    eta: "Enroll in 30 min",
    recommended: true,
    baseline: {
      label: "Individual Silver plan", category: "insurance_plan",
      current_provider: "Blue Shield PPO", current_price: 487,
      specifics: "silver tier, single coverage, SF zip", region: "SF 94114",
    },
  },
  {
    id: "off-3", category: "Hospital bill", source: "Sutter Health charity care",
    icon: "hospital",
    confidence: "MEDIUM",
    current: 3420, offered: 0, saves: 3420, unit: "",
    why: "Household AGI under 400% FPL — you qualify for 100% charity write-off under Sutter's policy.",
    friction: "Submit last 2 pay stubs + tax return. Approval 2-3 weeks.",
    eta: "Submit in 15 min",
    recommended: true,
    baseline: {
      label: "Outstanding hospital balance", category: "hospital_bill",
      current_provider: "Sutter Health", current_price: 3420,
      specifics: "post-insurance patient responsibility, household AGI ~$78k",
      region: "SF",
    },
  },
  {
    id: "off-4", category: "Lab", source: "Labcorp direct-pay",
    icon: "doc",
    confidence: "HIGH",
    current: 186, offered: 49, saves: 137, unit: "",
    why: "Same CBC + lipid panel, cash price at Labcorp instead of in-network Quest billing.",
    friction: "Have your doctor send the order to Labcorp for your next draw.",
    eta: "Next visit",
    recommended: false,
    baseline: {
      label: "CBC + lipid panel", category: "lab_work",
      current_provider: "Quest (insurance)", current_price: 186,
      specifics: "standard CBC with differential plus lipid panel",
      region: "SF 94114",
    },
  },
  {
    id: "off-5", category: "Payment plan", source: "Kaiser 0% APR",
    icon: "hospital",
    confidence: "HIGH",
    current: 0, offered: 0, saves: 340, unit: "/yr",
    why: "Spread the outstanding balance over 18 months at 0% interest vs. the 7.9% financing offer.",
    friction: "5-min call to billing. No credit check.",
    eta: "Enroll in 5 min",
    recommended: true,
    baseline: {
      label: "Kaiser payment plan alternative", category: "hospital_bill",
      current_provider: "Kaiser Permanente", current_price: 2100,
      specifics: "outstanding balance with 7.9% financing offered",
      region: "SF",
    },
  },
  {
    id: "off-6", category: "Dental", source: "Anthem Dental Complete",
    icon: "shield",
    confidence: "MEDIUM",
    current: 82, offered: 54, saves: 28, unit: "/mo",
    why: "Your dentist is in-network on Anthem too, at a lower premium for equivalent coverage.",
    friction: "Switch at open enrollment (Nov). Agent will remind you.",
    eta: "Schedule Nov 1",
    recommended: false,
    baseline: {
      label: "Individual dental plan", category: "dental",
      current_provider: "Delta Dental", current_price: 82,
      specifics: "individual PPO, monthly premium",
      region: "SF 94114",
    },
  },
];

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
    eyebrow: "Bills",
    title: "Every bill monitored",
    stats: null,
  });

  const audits = historyCache?.audits ?? [];
  const auditRows = audits.map((a) => {
    const score = scoreFromAudit(a);
    const isNegotiating = a.status === "negotiating" || a.outcome === "negotiating";
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
    else lifecycle = "attention"; // audited but no negotiation dispatched yet
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
    };
  });
  const rows = [...auditRows, ...MOCK_RECURRING_BILLS];

  // Three numbers the user cares about: how many negotiations are running,
  // how many need attention, and total saved lifetime.
  const activeCount = auditRows.filter((r) => r.lifecycle === "active").length;
  const attentionCount = auditRows.filter((r) => r.lifecycle === "attention").length;
  const totalSaved = audits.reduce((s, a) => s + (a.patient_saved ?? 0), 0);

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

function bindBillsFilters(allRowsRef) {
  const onChange = () => {
    BILLS_FILTER.q = $("#bills-filter-q")?.value?.trim().toLowerCase() ?? "";
    BILLS_FILTER.category = $("#bills-filter-category")?.value ?? "";
    BILLS_FILTER.date = $("#bills-filter-date")?.value ?? "";
    BILLS_FILTER.price = $("#bills-filter-price")?.value ?? "";
    BILLS_FILTER.score = $("#bills-filter-score")?.value ?? "";
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
    renderBills();
  });
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
    const activePill = r.lifecycle === "active"
      ? `<span class="bill-inline-active"><span class="status-dot"></span>Negotiating</span>`
      : "";
    const barColor = r.score >= 70 ? "var(--green)" : r.score >= 50 ? "var(--amber)" : "var(--red)";
    const scoreCell = `<div class="bill-score-head">
              <span class="bill-score-num">${r.score}</span>
              <span class="mono" style="font-size:10.5px;color:var(--ink-mute);letter-spacing:.04em;text-transform:uppercase">${r.scoreLabel}</span>
            </div>
            <div class="bill-score-bar"><div class="bill-score-fill" style="width:${r.score}%;background:${barColor}"></div></div>`;
    row.innerHTML = `
      <div class="bill-main">
        <div class="bill-ic">${KIND_ICON[r.kind] ?? ICONS.doc}</div>
        <div style="min-width:0">
          <div class="bill-name">${escapeHtml(r.vendor)}${activePill}</div>
          <div class="bill-account mono">${escapeHtml(r.account)} · ${r.lastCheck}</div>
        </div>
      </div>
      <div>
        <div class="bill-price">${fmt$(r.balance)}</div>
        ${r.rate ? `<div class="bill-price-sub">${r.rate}</div>` : ""}
      </div>
      <div class="bill-category"><span class="tag tag-mono">${escapeHtml(r.category.toUpperCase())}</span></div>
      <div class="bill-score">
        ${scoreCell}
      </div>
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

let offersFilter = "All";

function renderOffers() {
  const total = MOCK_OFFERS
    .filter((o) => o.recommended)
    .reduce((s, o) => s + (o.unit === "/mo" ? o.saves * 12 : o.saves), 0);

  updatePageHeader({
    eyebrow: "Offers",
    title: "Cheaper alternatives, found for you.",
    stats: [
      { label: "Opportunities", value: String(MOCK_OFFERS.length) },
      { label: "Recommended", value: String(MOCK_OFFERS.filter((o) => o.recommended).length), tone: "green" },
      { label: "Annualized", value: fmt$(total), tone: "green" },
    ],
  });

  $("#banner-amount").textContent = fmt$(total);
  $("#banner-sub").textContent = `Agent running continuously — ${MOCK_OFFERS.length} offers across ${new Set(MOCK_OFFERS.map((o) => o.category)).size} categories. Accept individually or all recommended at once.`;

  // Filters
  const filtersRoot = $("#offers-filters");
  filtersRoot.innerHTML = "";
  const cats = ["All", ...Array.from(new Set(MOCK_OFFERS.map((o) => o.category)))];
  for (const c of cats) {
    const chip = document.createElement("button");
    chip.className = "filter-chip" + (c === offersFilter ? " active" : "");
    chip.textContent = c;
    chip.addEventListener("click", () => { offersFilter = c; renderOffers(); });
    filtersRoot.appendChild(chip);
  }

  const grid = $("#offers-grid");
  grid.innerHTML = "";
  const visible = offersFilter === "All" ? MOCK_OFFERS : MOCK_OFFERS.filter((o) => o.category === offersFilter);
  for (const o of visible) {
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
          <div class="offer-current">${o.current ? fmt$(o.current) + (o.unit ? ' <span style="font-size:11px">' + o.unit + '</span>' : "") : "—"}</div>
        </div>
        <div class="offer-arrow">${ICONS.arrow}</div>
        <div>
          <div class="col-label">Offer</div>
          <div class="offer-new">${o.offered ? fmt$(o.offered) + (o.unit ? ' <span style="font-size:11px">' + o.unit + '</span>' : "") : "Free"}</div>
        </div>
        <div class="offer-pad"></div>
        <div class="offer-right">
          <div class="col-label">You save</div>
          <div class="offer-saves">${fmt$(o.saves)}${o.unit ? ' <span style="font-size:11px">' + o.unit + '</span>' : ""}</div>
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
    grid.appendChild(card);
  }

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
    const res = await fetch("/api/offer-hunt", {
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

// ─── Settings ──────────────────────────────────────────────────

async function renderSettings() {
  updatePageHeader({
    eyebrow: "Settings",
    title: "Tune the agent.",
    stats: null,
  });
  const root = $("#settings-groups");
  root.innerHTML = '<div class="tl-sub">Loading…</div>';

  let sdata;
  try {
    sdata = await fetch("/api/settings").then((r) => r.json());
  } catch {
    sdata = { integrations: [], fixtures: { count: 0 }, port: 3333 };
  }

  root.innerHTML = "";

  // Account — editable name, email + digest toggle, phone + mobile alert toggle.
  root.appendChild(mkAccountCard(sdata.account ?? {}));

  // Telegram — editable credentials card.
  root.appendChild(mkTelegramCard(sdata.telegram ?? {}));

  // Connected accounts — real integration statuses from /api/settings
  const integRows = (sdata.integrations ?? [])
    .filter((i) => i.key !== "telegram") // telegram has its own editable card above
    .map((i) => ({
      label: i.label,
      help: i.detail,
      value: mkStatusPill(i.status),
    }));
  if (integRows.length === 0) {
    integRows.push({ label: "No integrations detected", help: "Set ANTHROPIC_API_KEY to enable the agent.", value: mkStatusPill("missing") });
  }
  root.appendChild(mkSettingsGroup("Connected accounts", integRows));

  // Data
  const dataGroup = document.createElement("div");
  dataGroup.className = "settings-group";
  dataGroup.innerHTML = `
    <div class="settings-group-title">Data</div>
    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Export all data</div>
          <div class="settings-row-help">Download every audit, letter, and transcript as a ZIP.</div>
        </div>
        <button class="btn btn-ghost">Export</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Delete account</div>
          <div class="settings-row-help">Removes stored bills, EOBs, and negotiation history. Irreversible.</div>
        </div>
        <button class="btn btn-ghost" style="color:var(--red);border-color:rgba(139,30,46,.3)">Delete</button>
      </div>
    </div>`;
  root.appendChild(dataGroup);

  // Wire toggles
  for (const t of root.querySelectorAll(".toggle")) {
    t.addEventListener("click", () => t.classList.toggle("on"));
  }
}

function mkAccountCard(acc) {
  const g = document.createElement("div");
  g.className = "settings-group";
  const digestOn = acc.email_digest !== false;
  const mobileOn = acc.mobile_alerts !== false;
  g.innerHTML = `
    <div class="settings-group-title">Account</div>
    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Name</div>
          <div class="settings-row-help">Shown on appeal letters and outreach.</div>
          <input type="text" id="acc-name" class="settings-input" value="${escapeHtml(acc.name ?? "")}" placeholder="Jane Doe" autocomplete="name" />
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="acc-label-row">
            <div class="settings-row-label">Email</div>
            <div class="acc-toggle-group">
              <span class="acc-toggle-label">Weekly digest</span>
              <button type="button" class="toggle ${digestOn ? "on" : ""}" id="acc-digest-toggle" aria-label="Email digest"></button>
            </div>
          </div>
          <div class="settings-row-help">Inbound replies from providers and your weekly summary both route here.</div>
          <input type="email" id="acc-email" class="settings-input" value="${escapeHtml(acc.email ?? "")}" placeholder="you@example.com" autocomplete="email" />
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="acc-label-row">
            <div class="settings-row-label">Phone</div>
            <div class="acc-toggle-group">
              <span class="acc-toggle-label">Real-time alerts</span>
              <button type="button" class="toggle ${mobileOn ? "on" : ""}" id="acc-mobile-toggle" aria-label="Mobile alerts"></button>
            </div>
          </div>
          <div class="settings-row-help">Voice calls from the agent and real-time approval alerts both go to this number.</div>
          <input type="tel" id="acc-phone" class="settings-input" value="${escapeHtml(acc.phone ?? "")}" placeholder="+1 (415) 555-0134" autocomplete="tel" />
        </div>
      </div>
      <div class="settings-row" style="justify-content:flex-end;gap:10px">
        <span id="acc-save-status" class="tg-save-status"></span>
        <button class="btn btn-primary" id="acc-save-btn" type="button">Save</button>
      </div>
    </div>`;
  // Toggles flip in-place; server save happens on explicit Save click.
  g.querySelector("#acc-digest-toggle").addEventListener("click", (ev) => {
    ev.currentTarget.classList.toggle("on");
  });
  g.querySelector("#acc-mobile-toggle").addEventListener("click", (ev) => {
    ev.currentTarget.classList.toggle("on");
  });
  const saveBtn = g.querySelector("#acc-save-btn");
  const status = g.querySelector("#acc-save-status");
  saveBtn.addEventListener("click", async () => {
    const body = {
      name: g.querySelector("#acc-name").value.trim(),
      email: g.querySelector("#acc-email").value.trim(),
      phone: g.querySelector("#acc-phone").value.trim(),
      email_digest: g.querySelector("#acc-digest-toggle").classList.contains("on"),
      mobile_alerts: g.querySelector("#acc-mobile-toggle").classList.contains("on"),
    };
    saveBtn.disabled = true;
    status.textContent = "Saving…";
    status.className = "tg-save-status";
    try {
      const res = await fetch("/api/settings/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      status.textContent = "Saved ✓";
      status.className = "tg-save-status ok";
    } catch (err) {
      status.textContent = `Error: ${err?.message ?? err}`;
      status.className = "tg-save-status err";
    } finally {
      saveBtn.disabled = false;
    }
  });
  return g;
}

function mkTelegramCard(tg) {
  const g = document.createElement("div");
  g.className = "settings-group";
  const connected = !!(tg.bot_token_set && tg.chat_id_set);
  g.innerHTML = `
    <div class="settings-group-title">Telegram</div>
    <div class="settings-card">
      <div class="settings-row tg-row-help">
        <div class="settings-row-main">
          <div class="settings-row-label">Text your agent</div>
          <div class="settings-row-help">
            Get live updates on negotiations and reply to approve, stop, or ask anything.
            <ol class="tg-help-steps">
              <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> in Telegram → <code>/newbot</code> → follow prompts → copy the token.</li>
              <li>Start a chat with your new bot (search for its @handle) and send any message.</li>
              <li>Paste the token below and click Save. Bonsai will auto-detect your chat ID from your first message.</li>
            </ol>
          </div>
        </div>
        <span class="tag tag-mono ${connected ? "tag-green" : "tag-red"}">${connected ? "Connected" : "Not connected"}</span>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Bot token</div>
          <div class="settings-row-help">Keep this private. Stored locally in out/user-settings.json.</div>
          <input type="password" id="tg-bot-token" class="settings-input" placeholder="${tg.bot_token_set ? "•••••••• (already set — paste to replace)" : "123456:ABC-…"}" autocomplete="off" />
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-label">Chat ID</div>
          <div class="settings-row-help">Your personal chat with the bot. Leave blank and send the bot a message — we'll fill this in automatically on first message.</div>
          <input type="text" id="tg-chat-id" class="settings-input" value="${escapeHtml(tg.chat_id_preview ?? "")}" placeholder="123456789" autocomplete="off" />
        </div>
      </div>
      <div class="settings-row" style="justify-content:flex-end;gap:10px">
        <span id="tg-save-status" class="tg-save-status"></span>
        <button class="btn btn-primary" id="tg-save-btn" type="button">Save</button>
      </div>
    </div>`;
  // Wire save handler
  const saveBtn = g.querySelector("#tg-save-btn");
  const status = g.querySelector("#tg-save-status");
  saveBtn.addEventListener("click", async () => {
    const botTokenInput = g.querySelector("#tg-bot-token").value.trim();
    const chatIdInput = g.querySelector("#tg-chat-id").value.trim();
    saveBtn.disabled = true;
    status.textContent = "Saving…";
    status.className = "tg-save-status";
    try {
      const body = {};
      if (botTokenInput) body.botToken = botTokenInput;
      // Chat ID: explicitly send (even if blank — allows clearing).
      body.chatId = chatIdInput;
      const res = await fetch("/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      status.textContent = "Saved ✓";
      status.className = "tg-save-status ok";
      setTimeout(() => renderSettings(), 600); // refresh to reflect connected state
    } catch (err) {
      status.textContent = `Error: ${err?.message ?? err}`;
      status.className = "tg-save-status err";
    } finally {
      saveBtn.disabled = false;
    }
  });
  return g;
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
  const tone = status === "connected" ? "tag-green"
             : status === "simulated" ? "tag-amber"
             : status === "missing"   ? "tag-red"
             : "";
  span.className = `tag tag-mono ${tone}`;
  span.textContent = status === "connected" ? "CONNECTED"
                   : status === "simulated" ? "SIMULATED"
                   : status === "missing"   ? "NOT SET"
                   : status.toUpperCase();
  return span;
}

// ─── Bill detail drawer (CRM-style audit log) ──────────────────

let drawerState = { row: null, report: null, activeTab: "activity" };
const reportCache = new Map();

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
  $("#drawer-sub").textContent = `${row.account ?? ""} · last activity ${row.lastCheck}`;

  // Stats (initial — will be enriched after fetch for audits)
  renderDrawerStats(row, null);

  // If this is an audited bill, fetch the full report
  if (row.kind === "audit" && row.audit?.name) {
    const name = row.audit.name;
    $("#drawer-body").innerHTML = `<div class="dact-empty">Loading activity…</div>`;
    let report = reportCache.get(name);
    if (!report) {
      try {
        const res = await fetch(`/api/report/${name}`);
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
  // rounds. Active → Stop. Anything else (completed, cancelled, failed,
  // audited-but-not-yet-approved) → Start the next round.
  const agentBtn = $("#drawer-agent-btn");
  const feedbackPanel = $("#drawer-feedback");
  const runId = row?.audit?.run_id;
  const isActive = row.lifecycle === "active" && !!runId;
  const isStopped = (row.status === "cancelled" || row.status === "failed") && !!runId;

  if (agentBtn) {
    if (!runId) {
      // Mock recurring bills with no real run_id → no button.
      agentBtn.hidden = true;
      agentBtn.onclick = null;
    } else if (isActive) {
      agentBtn.hidden = false;
      agentBtn.className = "drawer-agent-btn drawer-stop-btn";
      agentBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
        <span>Stop</span>`;
      agentBtn.onclick = () => stopAgent();
    } else {
      agentBtn.hidden = false;
      agentBtn.className = "drawer-agent-btn drawer-resume-btn";
      agentBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>
        <span>Start</span>`;
      agentBtn.onclick = () => resumeAgent();
    }
  }
  if (feedbackPanel) {
    feedbackPanel.hidden = !isStopped;
    if (isStopped) void loadFeedback(runId);
    if (!feedbackPanel._bound) {
      feedbackPanel._bound = true;
      $("#drawer-feedback-form").addEventListener("submit", (ev) => {
        ev.preventDefault();
        sendFeedback();
      });
    }
  }


  // Tabs
  bindDrawerTabs();
  renderDrawerTab("activity");
}

async function loadFeedback(runId) {
  const log = $("#drawer-feedback-log");
  if (!log) return;
  log.innerHTML = "";
  try {
    const res = await fetch(`/api/feedback/${runId}`);
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
  const runId = drawerState?.row?.audit?.run_id;
  if (!runId) return;
  const input = $("#drawer-feedback-input");
  const msg = input.value.trim();
  if (!msg) return;
  appendFeedbackMessage("user", msg);
  input.value = "";
  input.disabled = true;
  const btn = $("#drawer-feedback-form button");
  if (btn) btn.disabled = true;
  const thinking = document.createElement("div");
  thinking.className = "qa-msg a";
  thinking.innerHTML = `<div class="qa-role">Bonsai</div><div class="qa-body"><span class="dots"><span></span><span></span><span></span></span></div>`;
  $("#drawer-feedback-log").appendChild(thinking);

  try {
    const res = await fetch("/api/feedback", {
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
  const runId = row?.audit?.run_id;
  if (!runId) return;
  const vendor = row.vendor ?? "this bill";
  const ok = await confirmModal({
    title: `Delete ${vendor}?`,
    body: "This removes the audit, appeal letter, and uploaded files. Can't be undone.",
    confirmText: "Delete",
    cancelText: "Cancel",
  });
  if (!ok) return;
  try {
    const res = await fetch("/api/delete", {
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

async function resumeAgent() {
  const row = drawerState?.row;
  const runId = row?.audit?.run_id;
  if (!runId) return;
  try {
    const res = await fetch("/api/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    if (!res.ok) throw new Error(await res.text());
    await loadHistory();
    updateNavCounts();
    if (currentNav === "bills") renderBills();
    // Stay in the drawer so the user can see the state flip back to
    // Negotiating with the Stop button ready.
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
    const res = await fetch("/api/stop", {
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
    const res = await fetch(`/api/bill/${encodeURIComponent(runId)}`);
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
  const saved = summary.patient_saved ?? 0;
  const channel = summary.channel_used ?? "—";

  // Traffic-light status lives inside the drawer only. Active = yellow,
  // resolved = green, attention (escalated/failed/not-started) = red.
  let statusTone = "attention";
  let statusLabel = "Needs attention";
  if (row.status === "cancelled" || summary.outcome === "cancelled") {
    statusTone = "attention";
    statusLabel = "Stopped";
  } else if (row.lifecycle === "active" || summary.outcome === "in_progress" || row.status === "negotiating") {
    statusTone = "active";
    statusLabel = "Negotiating";
  } else if (row.lifecycle === "resolved" || summary.outcome === "resolved") {
    statusTone = "resolved";
    statusLabel = "Resolved";
  } else if (row.kind !== "audit") {
    statusTone = "resolved";
    statusLabel = row.scoreLabel ?? "Watching";
  }

  const hasRunId = !!row?.audit?.run_id;
  $("#drawer-stats").innerHTML = `
    <div class="drawer-stat"><div class="eyebrow">Original</div><div class="drawer-stat-val ${saved ? "strike" : ""}">${fmt$(was)}</div></div>
    <div class="drawer-stat"><div class="eyebrow">Current</div><div class="drawer-stat-val">${fmt$(now)}</div></div>
    <div class="drawer-stat"><div class="eyebrow">Saved</div><div class="drawer-stat-val green">${saved ? fmt$(saved) : "—"}</div></div>
    <div class="drawer-stat drawer-stat-status-wrap">
      <div class="drawer-stat-status-lead">
        <div class="eyebrow">Status</div>
        <div class="drawer-stat-status bill-status bill-status-${statusTone}">
          <span class="status-dot"></span><span>${escapeHtml(statusLabel)}</span>
        </div>
      </div>
      ${hasRunId ? `
        <button type="button" id="drawer-delete-btn" class="drawer-delete-icon" title="Delete this bill" aria-label="Delete this bill">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
        </button>` : ""}
    </div>`;
  // Wire delete on every re-render since innerHTML replaces it.
  $("#drawer-delete-btn")?.addEventListener("click", () => deleteBill());
}

function renderDrawerTab(which) {
  const body = $("#drawer-body");
  const { row, report } = drawerState;
  if (which === "activity") {
    body.innerHTML = renderActivityTimeline(row, report);
  } else if (which === "messages") {
    body.innerHTML = renderDrawerMessages(row, report);
  }
}

/* Build a sequenced activity timeline from the full report. */
function buildTimelineEvents(row, report) {
  const events = [];
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
    return events.sort((a, b) => a.ts - b.ts);
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

  // 7. SMS thread — messages use { role, body, ts, segments }
  const sms = report.sms_thread;
  if (sms && Array.isArray(sms.messages)) {
    sms.messages.forEach((m) => {
      const isOut = m.role === "outbound";
      events.push({
        ts: Date.parse(m.ts),
        headline: isOut ? "SMS sent" : "SMS received",
        detail: m.body ?? "",
        channel: "sms",
        actor: isOut
          ? `Bonsai → billing${m.segments ? ` · ${m.segments} seg` : ""}`
          : "Billing dept → Bonsai",
        tone: isOut ? "ink" : "amber",
      });
    });
  }

  // 8. Voice
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

  return events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
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

function renderDrawerMessages(row, report) {
  const parts = [];
  const email = report?.email_thread;
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
  const sms = report?.sms_thread;
  if (sms?.messages?.length) {
    parts.push(`<div class="dmsg-section-head"><div class="eyebrow">SMS thread</div><div class="mono" style="font-size:11px;color:var(--ink-mute)">${sms.messages.length} msgs</div></div>`);
    sms.messages.forEach((m) => {
      const isOut = m.role === "outbound";
      parts.push(`
        <div class="dmsg-msg ${isOut ? "out" : ""}">
          <div class="dmsg-meta"><span>${isOut ? "→ billing" : "← billing"}${m.segments ? ` · ${m.segments} seg` : ""}</span><span>${escapeHtml(formatClockTs(Date.parse(m.ts)))}</span></div>
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

init();
