// Bonsai first-login product tour.
//
// Loaded after app.js (vanilla classic script — no modules). Exposes
// `window.startBonsaiTour()` and auto-fires on first init when the
// authenticated user has no `tour_completed_at` timestamp.
//
// Visual style: Ramp-style scripted tour with a chapter rail (title +
// progress bar + step list) on the left and a popover with an arrow tail
// pointing at the highlighted target. Spotlight is a single ring whose
// 9999px box-shadow creates the dim — that lets us read the target's
// border-radius and round the cutout to match. No clip-path math.
//
// Flow ("auto-driven, no real side effects" — option C):
//   1. Upload chapter — narrate the dropzone, then auto-call
//      runPhasedFromSample("bill-001", "persistent") to load a real audit.
//   2. Opportunities — point at the first opp card.
//   3. Chat — point at the plan-customization input.
//   4. Accept — point at the approve button. Tour does NOT click it
//      (that would start a real outbound negotiation). Tour explains
//      the button, then advances to chapter 5 via showNav("bills").
//   5. Negotiation tab — auto-navigate, narrate.
//   6. Comparison tab — auto-navigate, narrate. Final "Done" CTA.
//
// Persistence: dismissing or completing fires POST /api/auth/tour-completed,
// which stamps the user row so the tour doesn't re-fire. "Replay tour" in
// Settings hits DELETE /api/auth/tour-completed to reset.

(function () {
  "use strict";

  /** @typedef {{
   *   id: string,
   *   railLabel: string,
   *   railSub?: string,
   *   title: string,
   *   body: string,
   *   anchor?: () => Element | null,
   *   placement?: "top" | "bottom" | "left" | "right" | "auto",
   *   centered?: boolean,
   *   primaryLabel?: string,
   *   onEnter?: (mgr: TourManager) => void | Promise<void>,
   *   onLeave?: (mgr: TourManager) => void | Promise<void>,
   *   waitFor?: () => boolean,
   *   waitTimeoutMs?: number,
   * }} Chapter
   */

  const POP_WIDTH = 340;
  const POP_GAP = 18; // distance between anchor and popover (room for the arrow tail)

  const VISITED_KEY = "bonsai.tour.visited";

  function loadVisited() {
    try {
      const raw = localStorage.getItem(VISITED_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }
  function saveVisited(set) {
    try {
      localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
    } catch { /* ignore */ }
  }

  class TourManager {
    /** @param {{chapters: Chapter[], onComplete?: () => void, onSkip?: () => void}} opts */
    constructor(opts) {
      this.chapters = opts.chapters;
      this.onComplete = opts.onComplete ?? (() => {});
      this.onSkip = opts.onSkip ?? (() => {});
      this.index = -1;          // -1 = browse mode, no active chapter
      this.active = false;
      this.mode = "active";     // "active" (overlay + popover) or "browse" (rail only)
      this._reanchorHandler = null;
      this._keyHandler = null;
      this._waitingFor = null;
      // Watches the active chapter's anchor for size changes (e.g. the
      // chat card growing as messages are appended) so the spotlight
      // ring follows along instead of staying stuck on the old rect.
      this._anchorObserver = null;
      this.visited = loadVisited();
    }

    /** Open the chapter list as a panel (no overlay/popover). User can
     * click any chapter to jump into the active tour. */
    openBrowse() {
      if (this.active) return;
      this.active = true;
      this.mode = "browse";
      this.index = -1;
      document.body.classList.add("tour-browse-active");
      this._buildDom();
      this._anchorRailToPill();
      this._installListeners();
      this._renderRail();
      // Click-outside to close, but only after a tick (so the click that
      // opened the panel doesn't immediately close it).
      setTimeout(() => {
        this._outsideClickHandler = (ev) => {
          if (!this.active || this.mode !== "browse") return;
          if (this.rail?.contains(ev.target)) return;
          const pill = document.querySelector(".gs-pill");
          if (pill?.contains(ev.target)) return;
          this.closeBrowse();
        };
        document.addEventListener("click", this._outsideClickHandler);
      }, 0);
    }

    closeBrowse() {
      if (!this.active || this.mode !== "browse") return;
      this._teardown();
    }

    start(atIndex = 0) {
      if (this.active && this.mode === "active") {
        // Already running — just jump.
        this._go(atIndex);
        return;
      }
      // Promote browse mode → active mode without rebuilding.
      if (this.active && this.mode === "browse") {
        this.mode = "active";
        document.body.classList.remove("tour-browse-active");
        document.body.classList.add("tour-active");
        if (this._outsideClickHandler) {
          document.removeEventListener("click", this._outsideClickHandler);
          this._outsideClickHandler = null;
        }
        this._ensureActiveDom();
        this._go(atIndex);
        return;
      }
      this.active = true;
      this.mode = "active";
      document.body.classList.add("tour-active");
      this._buildDom();
      this._anchorRailToPill();
      this._installListeners();
      this._go(atIndex);
    }

    startAt(i) { this.start(i); }

    _installListeners() {
      this._reanchorHandler = () => {
        this._anchorRailToPill();
        if (this.mode === "active") this._position();
      };
      window.addEventListener("resize", this._reanchorHandler);
      window.addEventListener("scroll", this._reanchorHandler, true);
      this._keyHandler = (ev) => {
        // Always check the event's own target first — activeElement can
        // lag a frame behind during fast typing/submits. If the event
        // originated from any form element, anywhere, leave it alone.
        const target = ev.target;
        const inForm =
          this._isFormElement(target) ||
          this._isFormElement(document.activeElement);
        if (ev.key === "Escape") {
          if (inForm) return;     // let inputs handle Esc themselves
          ev.preventDefault();
          if (this.mode === "browse") this.closeBrowse();
          else this.skip();
        } else if (this.mode === "active" && ev.key === "Enter" && !inForm) {
          ev.preventDefault();
          this.next();
        }
      };
      // Capture phase: catch the keydown before any input/form handler
      // can run so we can decide whether it's "ours" first. (We still
      // bail out via `inForm` when the target is an input, so chat
      // submit etc. work normally.)
      window.addEventListener("keydown", this._keyHandler, true);
    }

    /** Position the chapter rail so its bottom-left lines up with the
     * Getting Started pill's bottom-left. The rail "replaces" the pill
     * while the tour is active — same pattern as the GS panel. */
    _anchorRailToPill() {
      if (!this.rail) return;
      const pill = document.querySelector(".gs-pill");
      if (!pill) return;
      const rect = pill.getBoundingClientRect();
      if (!rect.width) return;
      const bottom = Math.max(8, window.innerHeight - rect.bottom);
      this.rail.style.setProperty("--tour-rail-bottom", `${bottom}px`);
      this.rail.style.setProperty("--tour-rail-left", `${Math.round(rect.left)}px`);
    }

    destroy({ wasCompleted = false, wasSkipped = false } = {}) {
      if (!this.active) return;
      this._teardown();
      if (wasCompleted) this.onComplete();
      else if (wasSkipped) this.onSkip();
    }

    _teardown() {
      this.active = false;
      this._cancelWait();
      this._unobserveAnchor();
      uninstallApproveTourGuard();
      uninstallBillsClickGuard();
      uninstallOfferActionsGuard();
      uninstallDropzoneClickGuard();
      document.body.classList.remove("tour-active", "tour-browse-active", "tour-allow-scroll");
      window.removeEventListener("resize", this._reanchorHandler);
      window.removeEventListener("scroll", this._reanchorHandler, true);
      window.removeEventListener("keydown", this._keyHandler, true);
      if (this._outsideClickHandler) {
        document.removeEventListener("click", this._outsideClickHandler);
        this._outsideClickHandler = null;
      }
      this._reanchorHandler = null;
      this._keyHandler = null;
      this.ring?.remove();
      this.rail?.remove();
      this.pop?.remove();
      this.ring = this.rail = this.pop = null;
      // Restore real Bills + Offers state — the tour injected demo rows
      // for chapters 5/6 and we don't want them lingering after the
      // tour closes.
      clearDemoData();
    }

    next() {
      if (!this.active) return;
      if (this.index >= this.chapters.length - 1) {
        this.destroy({ wasCompleted: true });
        return;
      }
      this._go(this.index + 1);
    }

    back() {
      if (!this.active || this.index <= 0) return;
      this._go(this.index - 1);
    }

    skip() {
      if (!this.active) return;
      this.destroy({ wasSkipped: true });
    }

    async _go(i) {
      this._cancelWait();
      // Drop the previous chapter's anchor observer before any onLeave
      // hooks fire — onLeave may rip the anchor out of the DOM, and a
      // disconnected observer is one less subtle leak.
      this._unobserveAnchor();
      const prev = this.chapters[this.index];
      const next = this.chapters[i];
      if (prev && prev !== next && typeof prev.onLeave === "function") {
        try { await prev.onLeave(this); } catch (err) { console.warn("[tour] onLeave error", err); }
      }
      this.index = i;
      // Mark this chapter as visited (persisted to localStorage). The
      // pill and rail render done states off this set.
      if (next?.id && !this.visited.has(next.id)) {
        this.visited.add(next.id);
        saveVisited(this.visited);
        // Notify the pill / anything listening so progress updates without
        // waiting for the next refresh tick.
        window.dispatchEvent(new CustomEvent("bonsai:tour-visited", { detail: { id: next.id } }));
      }
      this._renderRail();
      this._renderPopover(next);
      // If this chapter has a waitFor (e.g. waiting for the bills view
      // to mount + demo data to inject, or the drawer to finish its
      // slide-in), the anchor's rect isn't stable yet. Hide the popover
      // and ring during the wait — anchoring against an unstable rect
      // briefly snaps the popover to the wrong place ("bottom" / "top
      // left" glitch) before the real position is computed.
      // Toggle body scroll lock per-chapter. Chapters with allowScroll
      // (chat, accept) sit in tall pages where the user needs to be
      // able to scroll; default is locked so they don't accidentally
      // scroll away from the spotlight on most chapters.
      document.body.classList.toggle("tour-allow-scroll", !!next.allowScroll);
      const hasWait = typeof next.waitFor === "function";
      if (hasWait) {
        this._hideForWait();
      }
      // onEnter runs FIRST so it can navigate / set up the screen the
      // chapter expects to anchor against. Without this, _position()
      // would run against whatever surface was previously visible —
      // e.g. when the pre-loaded audit completes between chapter 1
      // entering and being positioned, the dropzone is hidden under
      // the review view, _position falls through to the noTarget
      // branch, and the popover snaps to a centered modal.
      if (typeof next.onEnter === "function") {
        try { await next.onEnter(this); } catch (err) { console.warn("[tour] onEnter error", err); }
      }
      if (!hasWait) {
        // scrollIntoView fires once per chapter — never inside _position()
        // (a scroll-event handler would re-scroll on every tick).
        this._scrollAnchorIntoView(next);
        this._position();
        this._observeAnchor(next.anchor?.());
        // One more position pass after layout settles — guards against
        // misalignment when an anchor's rect changes after onEnter
        // (e.g. the review panel reflowing because chapter 3's chat
        // grew, pushing the chapter 4 accept button further down).
        requestAnimationFrame(() => {
          if (this.mode === "active") this._position();
        });
      } else {
        this._setStatus(true);
        await this._waitUntil(next.waitFor, next.waitTimeoutMs ?? 90000);
        this._setStatus(false);
        this._showAfterWait();
        this._scrollAnchorIntoView(next);
        this._position();
        this._observeAnchor(next.anchor?.());
        requestAnimationFrame(() => {
          if (this.mode === "active") this._position();
        });
      }
    }

    /** Hide popover while a chapter is waiting for its anchor to
     * become visible/measurable. Keep the dim by snapping the ring
     * to its no-target state — the screen stays fully dimmed through
     * the transition instead of flashing bright between chapters,
     * which read as glitchy on the 5→6 (drawer) handoff. */
    _hideForWait() {
      if (this.pop) this.pop.style.visibility = "hidden";
      if (!this.ring) return;
      this.ring.classList.add("tour-no-target");
      this.ring.style.left = "";
      this.ring.style.top = "";
      this.ring.style.width = "";
      this.ring.style.height = "";
      this.ring.style.borderRadius = "";
    }
    _showAfterWait() {
      if (this.pop) this.pop.style.visibility = "";
      // Ring no-target class is cleared by _position when it picks
      // the next anchor — leave it alone here.
    }

    /** Watch the chapter's anchor for size/layout changes — e.g. the
     * "Customize the plan" card growing as the user chats with Bonsai —
     * and re-position the spotlight ring + popover whenever it shifts. */
    _observeAnchor(target) {
      this._unobserveAnchor();
      if (!target || typeof ResizeObserver === "undefined") return;
      try {
        this._anchorObserver = new ResizeObserver(() => {
          if (this.mode === "active") this._position();
        });
        this._anchorObserver.observe(target);
      } catch { /* observer unsupported — fall back to scroll/resize */ }
    }
    _unobserveAnchor() {
      if (this._anchorObserver) {
        try { this._anchorObserver.disconnect(); } catch { /* ignore */ }
        this._anchorObserver = null;
      }
    }

    _scrollAnchorIntoView(chapter) {
      if (!chapter || chapter.centered) return;
      const target = chapter.anchor?.();
      if (!target) return;
      try {
        target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      } catch {
        target.scrollIntoView();
      }
    }

    _waitUntil(pred, timeoutMs) {
      return new Promise((resolve) => {
        if (pred()) return resolve();
        let done = false;
        // Tighter polling = snappier chapter transitions. The pred()
        // checks are cheap (DOM queries) so 50ms × ~ a couple ticks
        // for the typical case is fine.
        const interval = setInterval(() => {
          if (done) return;
          if (pred()) {
            done = true;
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
          }
        }, 50);
        const timeout = setTimeout(() => {
          if (done) return;
          done = true;
          clearInterval(interval);
          resolve();
        }, timeoutMs);
        this._waitingFor = { interval, timeout };
      });
    }

    _cancelWait() {
      if (this._waitingFor) {
        clearInterval(this._waitingFor.interval);
        clearTimeout(this._waitingFor.timeout);
        this._waitingFor = null;
      }
    }

    _setStatus(isWaiting) {
      const status = this.pop?.querySelector(".tour-pop-status");
      const primary = this.pop?.querySelector(".tour-btn-primary");
      if (status) status.hidden = !isWaiting;
      if (primary) primary.disabled = !!isWaiting;
    }

    _isFormElement(el) {
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }

    _buildDom() {
      // The rail is always built — both browse and active modes use it.
      // The ring + popover are only relevant during active mode (browse
      // mode is just the chapter list, no spotlight or instruction tip).
      this.rail = document.createElement("aside");
      this.rail.className = "tour-rail";
      this.rail.setAttribute("aria-label", "Product tour chapters");
      document.body.appendChild(this.rail);

      if (this.mode === "active") {
        this._ensureActiveDom();
      }
    }

    _ensureActiveDom() {
      // Lazily build the spotlight ring + popover when transitioning
      // from browse → active mode. Idempotent — safe to call repeatedly.
      if (!this.ring) {
        this.ring = document.createElement("div");
        this.ring.className = "tour-spotlight-ring tour-no-target";
        this.ring.setAttribute("aria-hidden", "true");
        document.body.appendChild(this.ring);
      }
      if (!this.pop) {
        this.pop = document.createElement("div");
        this.pop.className = "tour-pop";
        this.pop.setAttribute("role", "dialog");
        this.pop.setAttribute("aria-live", "polite");
        document.body.appendChild(this.pop);
      }
    }

    _renderRail() {
      // Chapters with `hideFromRail` (currently just the centered
      // finale modal) don't represent a step the user navigates
      // between — they're a celebration screen — so skip them in
      // both the progress fraction and the list itself.
      const railChapters = this.chapters.filter((c) => !c.hideFromRail);
      const total = railChapters.length;
      // Progress is based on visited chapters, not the current index —
      // so the panel reflects total progress over time, not just where
      // the user is right now.
      const doneCount = railChapters.filter((c) => this.visited.has(c.id)).length;
      const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
      const isBrowse = this.mode === "browse";
      const items = this.chapters.map((c, i) => {
        if (c.hideFromRail) return "";
        const isActive = !isBrowse && i === this.index;
        const isDone = this.visited.has(c.id);
        const cls = [
          "tour-rail-item",
          isActive ? "is-active" : "",
          isDone && !isActive ? "is-done" : "",
        ].filter(Boolean).join(" ");
        const sub = c.railSub ? `<div class="tour-rail-sub">${escapeText(c.railSub)}</div>` : "";
        return `
          <li>
            <button type="button" class="${cls}" data-tour-chapter="${i}">
              <span class="tour-rail-bullet" aria-hidden="true"></span>
              <span class="tour-rail-text">
                <span class="tour-rail-label">${escapeText(c.railLabel)}</span>
                ${sub}
              </span>
            </button>
          </li>`;
      }).join("");
      const headRight = isBrowse
        ? `<button type="button" class="tour-rail-close" aria-label="Close panel">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
           </button>`
        : `<button type="button" class="tour-rail-skip" aria-label="Skip tour">Skip</button>`;
      this.rail.innerHTML = `
        <div class="tour-rail-head">
          <h2 class="tour-rail-title">Bonsai Product Tour</h2>
          ${headRight}
        </div>
        <div class="tour-rail-progress-row">
          <div class="tour-rail-progress-track" aria-hidden="true">
            <div class="tour-rail-progress-fill" style="width:${pct}%"></div>
          </div>
          <span class="tour-rail-progress-pct">${pct}%</span>
        </div>
        <ol class="tour-rail-list">${items}</ol>`;
      this.rail.querySelector(".tour-rail-skip")?.addEventListener("click", () => this.skip());
      this.rail.querySelector(".tour-rail-close")?.addEventListener("click", () => this.closeBrowse());
      // Each chapter row is a button — clicking it jumps the active tour
      // to that chapter (promoting from browse mode if needed).
      for (const btn of this.rail.querySelectorAll("[data-tour-chapter]")) {
        btn.addEventListener("click", (ev) => {
          const i = Number(ev.currentTarget.dataset.tourChapter);
          if (Number.isInteger(i)) this.startAt(i);
        });
      }
    }

    _renderPopover(chapter) {
      if (this.mode === "browse") return;
      // Counter only counts rail-visible chapters — the finale modal
      // (`hideFromRail`) isn't a "step" the user navigates between, so
      // chapter 5 reads "5 of 7" not "5 of 8".
      const railChapters = this.chapters.filter((c) => !c.hideFromRail);
      const visibleIndex = this.chapters
        .slice(0, this.index + 1)
        .filter((c) => !c.hideFromRail).length;
      const counter = `${visibleIndex} of ${railChapters.length}`;
      const isLast = this.index === this.chapters.length - 1;
      const primaryLabel = chapter.primaryLabel ?? (isLast ? "Done" : "Next");
      const showBack = this.index > 0 && !chapter.hideBack;
      const showCounter = !chapter.hideCounter;
      this.pop.classList.toggle("tour-pop-centered", !!chapter.centered);
      this.pop.classList.toggle("tour-pop-finale", !!(chapter.centered && chapter.hideBack));
      // Reset arrow until _placePopover decides direction.
      this.pop.removeAttribute("data-arrow");
      this.pop.style.removeProperty("--arrow-pos");
      // Layout (Ramp-style): close X tucked top-right, title + body, then
      // a 3-column footer Back | counter | Next. Back / counter become
      // placeholder spans when hidden so the primary stays centered.
      const backHtml = showBack
        ? `<button type="button" class="tour-btn tour-btn-back">Back</button>`
        : `<span class="tour-pop-foot-spacer" aria-hidden="true"></span>`;
      const counterHtml = showCounter
        ? `<span class="tour-pop-counter">${escapeText(counter)}</span>`
        : `<span class="tour-pop-counter" aria-hidden="true"></span>`;
      const titleHtml = chapter.title
        ? `<h3 class="tour-pop-title">${escapeText(chapter.title)}</h3>`
        : "";
      this.pop.innerHTML = `
        <button type="button" class="tour-pop-close" aria-label="Close tour">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
        ${titleHtml}
        <p class="tour-pop-body">${escapeText(chapter.body)}</p>
        <div class="tour-pop-status" hidden>
          <span class="tour-spinner" aria-hidden="true"></span>
          <span>Working…</span>
        </div>
        <div class="tour-pop-actions">
          ${backHtml}
          ${counterHtml}
          <button type="button" class="tour-btn tour-btn-primary">${escapeText(primaryLabel)}</button>
        </div>`;
      this.pop.querySelector(".tour-pop-close").addEventListener("click", () => this.skip());
      this.pop.querySelector(".tour-btn-primary").addEventListener("click", () => this.next());
      this.pop.querySelector(".tour-btn-back")?.addEventListener("click", () => this.back());
    }

    _position() {
      if (this.mode === "browse") return;
      const chapter = this.chapters[this.index];
      if (!chapter) return;
      // Always reset the ring's inline styles up front. Without this,
      // when transitioning from an anchored chapter (with inline
      // top/left/width/height set on the ring) to a centered chapter,
      // the inline styles outrank the .tour-no-target class CSS — the
      // ring stays sized to the previous anchor and the box-shadow's
      // dim spreads outside the OLD rect, leaving the previous
      // chapter's element visibly bright while the new modal opens.
      this.ring.style.left = "";
      this.ring.style.top = "";
      this.ring.style.width = "";
      this.ring.style.height = "";
      this.ring.style.borderRadius = "";
      // Centered chapter: shrink ring off-screen (dim stays), center popover.
      if (chapter.centered) {
        this.ring.classList.add("tour-no-target");
        this.pop.classList.add("tour-pop-centered");
        this.pop.removeAttribute("data-arrow");
        this.pop.style.left = "";
        this.pop.style.top = "";
        return;
      }
      const target = chapter.anchor?.();
      const rect = target?.getBoundingClientRect();
      // Treat 0×0 rects as no-target — happens when chapter 2's anchor
      // (#opps-list) exists but has no children yet because the audit
      // hasn't completed. Without this guard the popover snaps to the
      // top-left corner during the wait, then jumps to its real spot
      // when the rect becomes real.
      const noTarget = !target || !rect || (rect.width === 0 && rect.height === 0);
      if (noTarget) {
        this.ring.classList.add("tour-no-target");
        this.pop.classList.add("tour-pop-centered");
        this.pop.removeAttribute("data-arrow");
        this.pop.style.left = "";
        this.pop.style.top = "";
        return;
      }
      this.pop.classList.remove("tour-pop-centered");
      this.ring.classList.remove("tour-no-target");
      // No scrollIntoView here — _go() / waitFor handle scrolling once per
      // chapter. Calling it from a scroll-event handler caused the
      // popover to drift upward over time.
      const pad = 6;
      const r = {
        left: Math.max(4, rect.left - pad),
        top: Math.max(4, rect.top - pad),
        right: Math.min(window.innerWidth - 4, rect.right + pad),
        bottom: Math.min(window.innerHeight - 4, rect.bottom + pad),
      };
      // Pull the target's actual rounded corners. Add a few px so the
      // ring's rounded corner sits *outside* the element's rounded corner
      // — otherwise the white border looks pinched at the radius.
      const cs = window.getComputedStyle(target);
      const targetRadius = parseInt(cs.borderTopLeftRadius || "0", 10) || 0;
      const ringRadius = targetRadius > 0 ? targetRadius + pad : 8;
      this.ring.classList.remove("tour-no-target");
      this.ring.style.left = `${r.left}px`;
      this.ring.style.top = `${r.top}px`;
      this.ring.style.width = `${r.right - r.left}px`;
      this.ring.style.height = `${r.bottom - r.top}px`;
      this.ring.style.borderRadius = `${ringRadius}px`;
      this._placePopover(rect, chapter.placement ?? "auto");
    }

    _placePopover(rect, placement) {
      const popH = this.pop.offsetHeight || 200;
      const margin = 16;
      const isMobile = window.innerWidth <= 720;
      if (isMobile) {
        this.pop.style.left = "";
        this.pop.style.top = "";
        this.pop.removeAttribute("data-arrow");
        return;
      }
      const space = {
        right: window.innerWidth - rect.right,
        left: rect.left,
        top: rect.top,
        bottom: window.innerHeight - rect.bottom,
      };
      let chosen = placement;
      if (chosen === "auto") {
        if (space.right >= POP_WIDTH + POP_GAP + margin) chosen = "right";
        else if (space.left >= POP_WIDTH + POP_GAP + margin) chosen = "left";
        else if (space.bottom >= popH + POP_GAP + margin) chosen = "bottom";
        else chosen = "top";
      }
      let left, top;
      switch (chosen) {
        case "right":
          left = rect.right + POP_GAP;
          top = rect.top + rect.height / 2 - popH / 2;
          break;
        case "left":
          left = rect.left - POP_GAP - POP_WIDTH;
          top = rect.top + rect.height / 2 - popH / 2;
          break;
        case "top":
          left = rect.left + rect.width / 2 - POP_WIDTH / 2;
          top = rect.top - POP_GAP - popH;
          break;
        case "bottom":
        default:
          left = rect.left + rect.width / 2 - POP_WIDTH / 2;
          top = rect.bottom + POP_GAP;
          break;
      }
      const clampedLeft = Math.max(margin, Math.min(window.innerWidth - POP_WIDTH - margin, left));
      const clampedTop = Math.max(margin, Math.min(window.innerHeight - popH - margin, top));
      this.pop.style.left = `${clampedLeft}px`;
      this.pop.style.top = `${clampedTop}px`;
      // Arrow tail. Inverse of the popover placement (popover on right of
      // anchor → arrow on left of popover, pointing back at the anchor).
      // --arrow-pos is the offset along the arrow's edge so the tail lines
      // up with the *anchor's center*, even when the popover got clamped.
      const arrowOpposite = {
        right: "left",
        left: "right",
        top: "bottom",
        bottom: "top",
      }[chosen];
      this.pop.setAttribute("data-arrow", arrowOpposite);
      const anchorCenterX = rect.left + rect.width / 2;
      const anchorCenterY = rect.top + rect.height / 2;
      let arrowPos;
      if (arrowOpposite === "left" || arrowOpposite === "right") {
        // Vertical edge; --arrow-pos is a top offset relative to popover.
        const local = anchorCenterY - clampedTop;
        arrowPos = clamp(local, 16, popH - 16);
        this.pop.style.setProperty("--arrow-pos", `${arrowPos}px`);
      } else {
        const local = anchorCenterX - clampedLeft;
        arrowPos = clamp(local, 22, POP_WIDTH - 22);
        this.pop.style.setProperty("--arrow-pos", `${arrowPos}px`);
      }
    }
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function escapeText(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ─── Bonsai chapter script ─────────────────────────────────────

  function $(s) { return document.querySelector(s); }

  function reviewReady() {
    const opps = $("#opps-list");
    return !!(opps && opps.children.length > 0);
  }

  function triggerSampleAudit() {
    if (reviewReady()) return;
    if (typeof window.runPhasedFromSample !== "function") {
      console.warn("[tour] runPhasedFromSample not on window — skipping auto-trigger");
      return;
    }
    try {
      // silent:true makes runPhasedFromSample skip the progress timeline
      // and the artificial 1.5s minimum loading delay — the tour goes
      // straight to the review screen. The real /api/audit call still
      // runs but for a cached fixture it's <100ms.
      window.runPhasedFromSample("bill-001", "persistent", { silent: true });
    } catch (err) {
      console.warn("[tour] failed to start sample audit", err);
    }
  }

  /** Fire the audit *while the user is reading chapter 1* so the result
   * is already on the review screen by the time they click Next. The
   * call is silent (no progress view, no min-loading delay) and
   * idempotent — calling triggerSampleAudit a second time on chapter 1
   * leave is a no-op once reviewReady() is true. */
  function preloadSampleAudit() {
    if (reviewReady()) return;
    if (typeof window.runPhasedFromSample !== "function") return;
    try {
      window.runPhasedFromSample("bill-001", "persistent", { silent: true });
    } catch (err) {
      console.warn("[tour] preload audit failed", err);
    }
  }

  function navTo(name) {
    if (typeof window.showNav !== "function") return;
    // keepReviewState across every tour-driven nav: chapter 5 jumps to
    // Bills mid-flow, and showNav's homeFromMidFlow / force+tabSwitch
    // branch would otherwise null out reviewState — silently breaking
    // the chat panel if the user navigates back to chapter 3.
    try {
      window.showNav(name, { force: true, keepReviewState: true });
    } catch (err) { console.warn("[tour] showNav failed", err); }
  }

  // Hooks the real "Accept & lower my bill" button so that, while
  // chapter 4 is on screen, a click *advances the tour* instead of
  // firing the actual approval flow (which would draft + send a real
  // email on the demo's contact). Capture phase + stopImmediatePropagation
  // beats the existing click handler in app.js.
  let approveTourGuard = null;
  function installApproveTourGuard(mgr) {
    uninstallApproveTourGuard();
    const btn = document.querySelector("#review-approve-btn");
    if (!btn || !mgr) return;
    const handler = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (mgr.active) mgr.next();
    };
    btn.addEventListener("click", handler, true);
    approveTourGuard = { btn, handler };
  }
  function uninstallApproveTourGuard() {
    if (!approveTourGuard) return;
    try {
      approveTourGuard.btn.removeEventListener("click", approveTourGuard.handler, true);
    } catch { /* ignore */ }
    approveTourGuard = null;
  }

  // While chapter 5 is on screen, a click anywhere on a demo bill row
  // should advance the tour into chapter 6 (Inside a bill / drawer)
  // — same intent as the existing approve-button guard. Without this,
  // the user clicks a bill expecting "drill in" behavior and nothing
  // happens because the demo rows have no real handlers.
  let billsClickGuard = null;
  function installBillsClickGuard(mgr) {
    uninstallBillsClickGuard();
    const root = document.querySelector("#bills-rows");
    if (!root || !mgr) return;
    const handler = (ev) => {
      const row = ev.target?.closest?.(".bills-row[data-tour-demo]");
      if (!row) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (mgr.active) mgr.next();
    };
    root.addEventListener("click", handler, true);
    billsClickGuard = { root, handler };
  }
  function uninstallBillsClickGuard() {
    if (!billsClickGuard) return;
    try {
      billsClickGuard.root.removeEventListener("click", billsClickGuard.handler, true);
    } catch { /* ignore */ }
    billsClickGuard = null;
  }

  // Same pattern for chapter 7: Dismiss / Compare / Switch on the demo
  // Lemonade card all advance the tour to the finale (chapter 8). Real
  // handlers would dismiss the card or open a compare flow — neither
  // makes sense for a fake offer, so we just treat each as Next.
  let offerActionsGuard = null;
  function installOfferActionsGuard(mgr) {
    uninstallOfferActionsGuard();
    const grid = document.querySelector("#offers-grid");
    if (!grid || !mgr) return;
    const handler = (ev) => {
      const card = ev.target?.closest?.(".offer-card[data-tour-demo]");
      if (!card) return;
      const btn = ev.target?.closest?.("button");
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (mgr.active) mgr.next();
    };
    grid.addEventListener("click", handler, true);
    offerActionsGuard = { grid, handler };
  }
  function uninstallOfferActionsGuard() {
    if (!offerActionsGuard) return;
    try {
      offerActionsGuard.grid.removeEventListener("click", offerActionsGuard.handler, true);
    } catch { /* ignore */ }
    offerActionsGuard = null;
  }

  // While chapter 1 is on screen, treat any click inside the dropzone
  // as a Next — including the "Choose files" button, the "Try a sample"
  // link, etc. Without this guard the user clicks into the upload area
  // (the natural CTA on chapter 1) and the file picker pops or a real
  // audit kicks off, both of which break the tour flow.
  let dropzoneClickGuard = null;
  function installDropzoneClickGuard(mgr) {
    uninstallDropzoneClickGuard();
    const dz = document.querySelector("#dropzone");
    if (!dz || !mgr) return;
    const handler = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (mgr.active) mgr.next();
    };
    dz.addEventListener("click", handler, true);
    dropzoneClickGuard = { dz, handler };
  }
  function uninstallDropzoneClickGuard() {
    if (!dropzoneClickGuard) return;
    try {
      dropzoneClickGuard.dz.removeEventListener("click", dropzoneClickGuard.handler, true);
    } catch { /* ignore */ }
    dropzoneClickGuard = null;
  }

  // Switches the user to the Overview tab and forces the workflow view
  // to the audit-review screen. Used by chapters 2–4 so back-navigation
  // from later chapters (which switch tabs) restores the right surface
  // — without this, going Back lands the user on Bills/Offers with the
  // chapter's anchor invisible, so the popover snaps to a centered
  // modal instead of pointing at the relevant element.
  //
  // keepReviewState matters: showNav's "homeFromMidFlow" branch clears
  // reviewState whenever you navigate-to-overview while review is up,
  // which would null out the just-audited fixture and break the chat
  // panel on chapter 3 ("no reviewState — chat fired before audit
  // completed"). The opt-in flag tells showNav to leave it alone.
  function ensureReviewView() {
    if (typeof window.showNav === "function") {
      try {
        window.showNav("overview", { force: true, keepReviewState: true });
      } catch (err) { console.warn("[tour] showNav failed", err); }
    }
    if (typeof window.setWorkflowView === "function") {
      try { window.setWorkflowView("review"); } catch (err) { console.warn("[tour] setWorkflowView failed", err); }
    }
    closeTourDrawer();
    // If the audit hasn't run (e.g. user jumped straight to chapter 2
    // via the rail panel without going through chapter 1), kick it off
    // now. triggerSampleAudit() is a no-op when reviewReady is true,
    // so this is safe to call on every chapter enter.
    if (!reviewReady()) triggerSampleAudit();
  }

  function billsViewReady() {
    const view = $("#view-bills");
    return !!(view && !view.classList.contains("hidden"));
  }
  function offersViewReady() {
    const view = $("#view-offers");
    return !!(view && !view.classList.contains("hidden"));
  }

  // ─── Demo data for chapters 5 + 6 ─────────────────────────────
  //
  // A first-time user has no real bills or offers, so the tour would
  // land them on empty screens. Inject realistic-looking sample rows
  // when the tour reaches those chapters; clear them on chapter leave
  // (or tour end) so the user's real (empty) state is back when they
  // return. The HTML mirrors what renderBillsRows / buildOfferCard
  // would produce for live data — same classes, same layout.

  function demoBillsHtml() {
    return `
      <div class="bills-row bill-item bill-item-active" data-tour-demo>
        <div class="bill-main">
          <div class="bill-ic">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14h-4v4h-2v-4H9v-2h4V8h2v4h4v2z"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          </div>
          <div style="min-width:0">
            <div class="bill-name">Synthetic Regional Hospital <span class="bill-inline-active"><span class="status-dot"></span>Negotiating</span></div>
            <div class="bill-account mono">Last reply 3h ago · claim 47821</div>
          </div>
        </div>
        <div>
          <div class="bill-price">$3,760</div>
          <div class="bill-price-sub">est. save $2,140</div>
        </div>
        <div class="bill-category"><span class="tag tag-mono">MEDICAL</span></div>
        <div class="bill-arrow">→</div>
      </div>
      <div class="bills-row bill-item" data-tour-demo>
        <div class="bill-main">
          <div class="bill-ic">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
          </div>
          <div style="min-width:0">
            <div class="bill-name">Comcast Xfinity <span class="bill-inline-attention bill-inline-awaiting">Awaiting your approval</span></div>
            <div class="bill-account mono">Account 8841-2117 · monthly</div>
          </div>
        </div>
        <div>
          <div class="bill-price">$89.00</div>
          <div class="bill-price-sub">per month</div>
        </div>
        <div class="bill-category"><span class="tag tag-mono">INTERNET</span></div>
        <div class="bill-arrow">→</div>
      </div>
      <div class="bills-row bill-item" data-tour-demo>
        <div class="bill-main">
          <div class="bill-ic">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div style="min-width:0">
            <div class="bill-name">State Farm Auto <span class="bill-inline-attention bill-inline-resolved">Resolved</span></div>
            <div class="bill-account mono">Saved $312/yr · 6 months coverage</div>
          </div>
        </div>
        <div>
          <div class="bill-price">$1,108</div>
          <div class="bill-price-sub">was $1,420</div>
        </div>
        <div class="bill-category"><span class="tag tag-mono">INSURANCE</span></div>
        <div class="bill-arrow">→</div>
      </div>`;
  }

  function demoOffersHtml() {
    const sparkle = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z"/></svg>';
    const arrow = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
    function card({ category, source, current, offered, saves, why, recommended }) {
      const offeredHtml = offered != null
        ? `<span class="offer-amt">$${offered.toLocaleString()}</span>`
        : "Free";
      return `
        <div class="offer-card${recommended ? " recommended" : ""}" data-tour-demo>
          <div class="offer-head">
            <div class="offer-ic">${sparkle}</div>
            <div class="offer-head-main">
              <div class="offer-meta">${category}</div>
              <div class="offer-source">${source}</div>
            </div>
          </div>
          <div class="offer-price-row">
            <div>
              <div class="col-label">Current</div>
              <div class="offer-current">${current != null ? `<span class="offer-amt offer-amt-strike">$${current.toLocaleString()}</span>` : "—"}</div>
            </div>
            <div class="offer-arrow">${arrow}</div>
            <div>
              <div class="col-label">Offer</div>
              <div class="offer-new">${offeredHtml}</div>
            </div>
            <div class="offer-pad"></div>
            <div class="offer-right">
              <div class="col-label">You save</div>
              <div class="offer-saves"><span class="offer-amt">$${saves.toLocaleString()}</span></div>
            </div>
          </div>
          <div><div class="offer-sub-title">Why it fits</div><div class="offer-sub">${why}</div></div>
          <div class="offer-actions">
            <button class="btn btn-ghost" type="button">Dismiss</button>
            <button class="btn btn-ghost" type="button">Compare</button>
            <button class="btn btn-primary" type="button">Switch</button>
          </div>
        </div>`;
    }
    return [
      card({
        category: "AUTO_INSURANCE",
        source: "Lemonade Auto",
        current: 180,
        offered: 125,
        saves: 55,
        why: "Quote based on your stated mileage and clean record. Match coverage exactly — same liability limits, same deductibles. Lemonade refunds unused premium quarterly.",
        recommended: true,
      }),
    ].join("");
  }

  function injectDemoBills() {
    // Fresh accounts have no audits, so renderBills() replaces the
    // entire #view-bills children with an "empty hero" — meaning
    // #bills-rows isn't in the DOM. Restore the chrome first so the
    // table container exists, then write demo rows into it.
    const view = $("#view-bills");
    if (view && typeof window.__bonsaiRestoreViewChildren === "function") {
      window.__bonsaiRestoreViewChildren(view);
    }
    const root = $("#bills-rows");
    if (!root) return;
    if (!root.dataset.tourBackup) {
      root.dataset.tourBackup = root.innerHTML;
    }
    root.innerHTML = demoBillsHtml();
    // Hide bits of the bills view that don't make sense for the tour
    // (filters, attention banner, stats strip).
    document.querySelector("#bills-filters")?.setAttribute("data-tour-hidden", "1");
    document.querySelector("#approvals-block")?.setAttribute("data-tour-hidden", "1");
    document.querySelector("#bills-stats")?.setAttribute("data-tour-hidden", "1");
  }

  function injectDemoOffers() {
    const view = $("#view-offers");
    if (view && typeof window.__bonsaiRestoreViewChildren === "function") {
      window.__bonsaiRestoreViewChildren(view);
    }
    const grid = $("#offers-grid");
    if (!grid) return;
    if (!grid.dataset.tourBackup) {
      grid.dataset.tourBackup = grid.innerHTML;
    }
    grid.innerHTML = demoOffersHtml();
    document.querySelector("#offers-filter-row")?.setAttribute("data-tour-hidden", "1");
  }

  function clearDemoData() {
    const billsRoot = $("#bills-rows");
    if (billsRoot?.dataset.tourBackup != null) {
      billsRoot.innerHTML = billsRoot.dataset.tourBackup;
      delete billsRoot.dataset.tourBackup;
    }
    const offersGrid = $("#offers-grid");
    if (offersGrid?.dataset.tourBackup != null) {
      offersGrid.innerHTML = offersGrid.dataset.tourBackup;
      delete offersGrid.dataset.tourBackup;
    }
    for (const el of document.querySelectorAll('[data-tour-hidden="1"]')) {
      el.removeAttribute("data-tour-hidden");
    }
    closeTourDrawer();
  }

  // ─── Demo bill drawer ─────────────────────────────────────────
  // Used by the "Inside a bill" chapter — opens the existing
  // #bill-drawer with hardcoded demo content so the user sees what a
  // single negotiation thread looks like (header, stats, activity log).
  // No real audit data is touched.

  function demoDrawerStats() {
    // Mirror renderDrawerStats() in app.js exactly — 4-column grid:
    // Original (struck-through when there's a saved figure), Current,
    // Saved (green), Status (traffic-light pill). Same class names so
    // the .strike / .green / .bill-status-active rules in app.css apply.
    return `
      <div class="drawer-stat">
        <div class="eyebrow">Original</div>
        <div class="drawer-stat-val strike">$3,760</div>
      </div>
      <div class="drawer-stat">
        <div class="eyebrow">Current</div>
        <div class="drawer-stat-val">$1,620</div>
      </div>
      <div class="drawer-stat">
        <div class="eyebrow">Saved</div>
        <div class="drawer-stat-val green">$2,140</div>
      </div>
      <div class="drawer-stat">
        <div class="eyebrow">Status</div>
        <div class="drawer-stat-status bill-status bill-status-active">
          <span class="status-dot"></span><span>Negotiating</span>
        </div>
      </div>`;
  }

  function demoDrawerContact() {
    // Mirrors the real renderDrawerContact() shape so the layout
    // looks identical — fields disabled because there's nothing to
    // save on a fake row.
    return `
      <form class="drawer-contact" autocomplete="off" onsubmit="return false">
        <div class="contact-help-ok">Agent ready to launch.</div>
        <label class="contact-field">
          <span class="eyebrow">Bill type</span>
          <select class="drawer-select" disabled>
            <option selected>Medical / hospital</option>
          </select>
        </label>
        <label class="contact-field">
          <span class="eyebrow">Account holder</span>
          <input type="text" class="drawer-input" value="Sample Account Holder" disabled>
        </label>
        <label class="contact-field">
          <span class="eyebrow">Billing email</span>
          <input type="email" class="drawer-input" value="billing@srh.example" disabled>
        </label>
        <label class="contact-field">
          <span class="eyebrow">Billing phone</span>
          <input type="tel" class="drawer-input" value="(555) 010-4781" disabled>
        </label>
      </form>`;
  }

  function demoDrawerActivity() {
    // Mirror renderActivityTimeline() in app.js — same `.dact-timeline`
    // container, same `.dact-event tone-X` events with `.dact-headline`,
    // `.dact-time`, `.dact-actor`, `.dact-detail`. The vertical timeline
    // line + colored bullets all come from app.css automatically.
    return `
      <div class="dact-timeline">
        <div class="dact-event tone-ink">
          <div class="dact-headline">Sent appeal letter to billing@srh.example</div>
          <div class="dact-time">3 days ago</div>
          <div class="dact-actor">EMAIL · Bonsai</div>
          <div class="dact-detail">"After itemized review, charges 47821-A and 47821-C appear to be duplicate. We're requesting a refund of $1,860 plus a written explanation of the disputed line items."</div>
        </div>
        <div class="dact-event tone-amber">
          <div class="dact-headline">Reply: "Reviewing your claim"</div>
          <div class="dact-time">2 days ago</div>
          <div class="dact-actor">EMAIL · Synthetic Regional Hospital</div>
          <div class="dact-detail">Acknowledged receipt. Internal review opened with case number RV-9921. Expected response in 5–7 business days.</div>
        </div>
        <div class="dact-event tone-ink">
          <div class="dact-headline">Follow-up sent — citing 26 CCR §1300.71</div>
          <div class="dact-time">3h ago</div>
          <div class="dact-actor">EMAIL · Bonsai</div>
          <div class="dact-detail">No response after the stated 7-day window. Escalating with a citation of state billing-error regulation.</div>
        </div>
      </div>`;
  }

  function openTourDrawer() {
    const drawer = $("#bill-drawer");
    const scrim = $("#drawer-scrim");
    if (!drawer || !scrim) return;
    drawer.removeAttribute("hidden");
    scrim.removeAttribute("hidden");
    drawer.classList.add("open");
    scrim.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    drawer.setAttribute("data-tour-demo-drawer", "1");
    // The drawer slides in over ~280ms via transform:translateX. Mark
    // it as "open" only after the slide completes — the chapter's
    // waitFor uses this to delay positioning until the drawer's rect
    // is stable, otherwise the popover anchors mid-animation.
    drawer.removeAttribute("data-tour-drawer-ready");
    // Tour CSS disables the slide-in animation entirely (see tour.css
    // `body.tour-active #bill-drawer { transition: none }`), so the
    // rect is stable on the next frame. Stamp ready immediately —
    // the spotlight + popover land on the same paint as the drawer.
    requestAnimationFrame(() => {
      if (drawer.classList.contains("open")) {
        drawer.setAttribute("data-tour-drawer-ready", "1");
      }
    });
    const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
    const setHtml = (sel, html) => { const el = $(sel); if (el) el.innerHTML = html; };
    setText("#drawer-title", "Synthetic Regional Hospital");
    setText("#drawer-sub", "Last reply 3h ago · claim 47821");
    setHtml("#drawer-stats", demoDrawerStats());
    setHtml("#drawer-body", demoDrawerActivity());
    // Mirror the real drawer's chrome so the demo looks identical to
    // what a user sees when they click into a real bill: frequency
    // dropdown defaults to Monthly, agent button shows "Stop" because
    // this demo bill is actively negotiating, default tab = Activity,
    // attention/feedback tabs hidden (no attention reason on this row).
    const freq = $("#drawer-frequency");
    if (freq) freq.value = "monthly";
    const agentBtn = $("#drawer-agent-btn");
    if (agentBtn) {
      agentBtn.hidden = false;
      agentBtn.className = "drawer-agent-btn drawer-stop-btn";
      agentBtn.disabled = false;
      agentBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
        <span>Stop</span>`;
      // Click is a no-op during the tour — taps shouldn't actually
      // pause anything since this isn't a real run.
      agentBtn.onclick = (ev) => { ev.preventDefault(); };
    }
    const tabButtons = document.querySelectorAll(".drawer-tab");
    tabButtons.forEach((b) => {
      b.classList.toggle("active", b.dataset.dtab === "activity");
      // Hide tabs that wouldn't show on a clean active negotiation.
      if (b.dataset.dtab === "attention" || b.dataset.dtab === "feedback") {
        b.hidden = true;
      } else {
        b.hidden = false;
      }
      // Bind a tour-only tab handler that swaps demo content for the
      // tab. Real `bindDrawerTabs()` references `drawerState.row` /
      // server data — useless here. Capture phase + stopImmediate so
      // the real listener (if previously bound) doesn't double-fire
      // and overwrite our demo content with "No activity yet".
      if (!b._tourBound) {
        b._tourBound = true;
        b.addEventListener("click", (ev) => {
          if (!document.body.classList.contains("tour-active")) return;
          const which = b.dataset.dtab;
          if (!which || b.hidden) return;
          ev.stopPropagation();
          ev.stopImmediatePropagation();
          tabButtons.forEach((x) => x.classList.toggle("active", x === b));
          const body = document.querySelector("#drawer-body");
          if (!body) return;
          if (which === "contact") body.innerHTML = demoDrawerContact();
          else if (which === "activity") body.innerHTML = demoDrawerActivity();
        }, true);
      }
    });
    // Delete is the only control that's meaningfully destructive —
    // keep it suppressed so a tour-curious tap can't actually nuke a
    // bill record on whatever account is replaying.
    document.querySelector("#drawer-delete-btn")?.setAttribute("data-tour-hidden", "1");
  }

  function closeTourDrawer() {
    const drawer = $("#bill-drawer");
    const scrim = $("#drawer-scrim");
    if (!drawer?.dataset.tourDemoDrawer) return;
    // The drawer has display:flex with translateX(100%) for the closed
    // state — removing .open slides it off-screen. The `hidden`
    // attribute alone doesn't hide it (display:flex outranks [hidden]
    // in author CSS). After the slide animation completes we add
    // `hidden` so it's also removed from the accessibility tree.
    drawer.classList.remove("open");
    scrim?.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    drawer.removeAttribute("data-tour-demo-drawer");
    setTimeout(() => {
      // Belt-and-braces: only re-hide if no one re-opened the drawer
      // in the meantime.
      if (!drawer.classList.contains("open")) {
        drawer.setAttribute("hidden", "");
        scrim?.setAttribute("hidden", "");
      }
    }, 320);
  }

  const CHAPTERS = [
    {
      id: "upload",
      railLabel: "Upload a bill",
      railSub: "Any PDF, photo, or screenshot",
      title: "Drop in any bill",
      body:
        "Drag a PDF, photo, or screenshot — medical, insurance, internet, " +
        "subscriptions, anything. We'll use a sample for this tour so you " +
        "can see what Bonsai finds.",
      anchor: () => $("#dropzone"),
      // Popover sits below the dropzone so its arrow tail points up at
      // the target — that's what the user sees when they're about to
      // drop a file in.
      placement: "bottom",
      // Always navigate to Home + clear any review state so the
      // dropzone is visible. Triggered from first-login, Settings →
      // Product Tour, GS pill, or Back from chapter 2 — every entry
      // point should land on the spotlighted dropzone, never a modal.
      onEnter: (mgr) => {
        if (typeof window.showNav === "function") {
          try { window.showNav("overview", { force: true }); } catch {}
        }
        closeTourDrawer();
        installDropzoneClickGuard(mgr);
      },
      // Sample audit kicks off when the user clicks Next so chapter 2
      // can land on the result screen without a loading flash.
      onLeave: () => {
        uninstallDropzoneClickGuard();
        triggerSampleAudit();
      },
    },
    {
      id: "opportunities",
      railLabel: "Find the savings",
      railSub: "Every overcharge, ranked",
      title: "Every overcharge, ranked",
      body:
        "Each opportunity is a defensible angle — duplicate charge, " +
        "out-of-network surprise, billing error — tied to the exact line " +
        "it came from. The total is what we estimate Bonsai can recover.",
      anchor: () => $("#opps-list"),
      placement: "left",
      // Going Back from a later chapter (Bills/Offers/drawer) needs to
      // pop the user back onto the review screen so #opps-list is
      // visible — without this the anchor is hidden, _position()
      // hits the noTarget branch, and the popover collapses to a
      // centered modal.
      onEnter: () => ensureReviewView(),
      waitFor: () => reviewReady(),
      waitTimeoutMs: 90000,
    },
    {
      id: "chat",
      railLabel: "Refine with chat",
      railSub: "Steer the strategy in plain English",
      title: "Talk to your bill",
      body:
        "Want to push harder on a specific charge or skip a tactic? Chat " +
        "with Bonsai to refine the plan — ask why a code is on there, lead " +
        "with the charity-care angle, whatever you want.",
      // Anchor the entire "Customize the plan" card (not just the input)
      // so the spotlight covers the chat log + form together. The card
      // grows as messages are appended; an observer below re-positions
      // the spotlight whenever the anchor's size changes.
      anchor: () => document.querySelector("section.review-chat"),
      placement: "auto",
      // The chat panel grows past the viewport as messages stack up —
      // let the user scroll the page so the input + send arrow stay
      // reachable. Tour CSS keys off `body.tour-allow-scroll` to relax
      // the global overflow:hidden.
      allowScroll: true,
      onEnter: () => ensureReviewView(),
    },
    {
      id: "accept",
      railLabel: "Accept the plan",
      railSub: "Bonsai sends the appeal in your voice",
      title: "Hit accept when you're ready",
      body:
        "When this is your real bill, hitting accept here would have " +
        "Bonsai draft the appeal in your voice, send it from a real " +
        "domain, and CC you on every reply. Click Accept to keep going.",
      anchor: () => $("#review-approve-btn"),
      placement: "top",
      // Same as chapter 3 — review screen can be tall after a chat
      // session and the accept button might sit below the fold.
      allowScroll: true,
      onEnter: (mgr) => {
        ensureReviewView();
        installApproveTourGuard(mgr);
      },
      onLeave: () => uninstallApproveTourGuard(),
    },
    {
      id: "negotiations",
      railLabel: "Manage negotiations",
      railSub: "Read every email and transcript",
      title: "Every active negotiation, in one place",
      body:
        "Bills you've accepted live here. Click any one to see the full " +
        "thread — every email, every reply, every escalation.",
      anchor: () => $("#bills-rows"),
      placement: "auto",
      onEnter: (mgr) => {
        // Make sure the demo drawer (from a previous chapter or replay)
        // isn't sitting open when we land back on the list.
        closeTourDrawer();
        navTo("bills");
        // Inject demo rows + install click guard one frame after the
        // tab switch — that's enough for #bills-rows to be in the DOM
        // but fast enough that the chapter advance still feels snappy.
        requestAnimationFrame(() => {
          injectDemoBills();
          installBillsClickGuard(mgr);
        });
      },
      onLeave: () => uninstallBillsClickGuard(),
      waitFor: () => {
        const root = $("#bills-rows");
        return billsViewReady() && root?.querySelector("[data-tour-demo]") != null;
      },
    },
    {
      id: "bill-drawer",
      railLabel: "Inside a bill",
      railSub: "Email + voice timeline",
      title: "Open one to see the full thread",
      body:
        "Click any negotiation and Bonsai shows you the entire timeline — " +
        "every email sent, every reply, every escalation. You can pause, " +
        "resume, or take over at any point.",
      anchor: () => $("#bill-drawer"),
      placement: "left",
      onEnter: () => {
        // Coming back from chapter 7 (Offers): the user is on the wrong
        // tab and the demo bills may have been wiped. Get them onto the
        // Bills surface first so the drawer slides in over the right
        // backdrop, then open it. Single frame is enough — double-RAF
        // added perceptible lag on the 5→6 transition.
        navTo("bills");
        requestAnimationFrame(() => {
          injectDemoBills();
          openTourDrawer();
        });
      },
      onLeave: () => closeTourDrawer(),
      waitFor: () => {
        const drawer = $("#bill-drawer");
        // data-tour-drawer-ready is stamped after the drawer's slide-in
        // animation finishes — only then is its rect stable enough to
        // anchor the popover against.
        return !!(drawer && drawer.classList.contains("open") &&
                  drawer.hasAttribute("data-tour-drawer-ready"));
      },
    },
    {
      id: "comparison",
      railLabel: "Lower your rate",
      railSub: "Switch instead of fight",
      title: "Or just pay less, period",
      body:
        "For recurring bills (internet, insurance, subscriptions), " +
        "comparison shops the market and brings you better offers — so " +
        "you can switch instead of fight.",
      // Anchor the demo offer card itself, not the wrapping grid — the
      // grid is full-page-width with empty columns next to a single
      // card, which would dim the whole row instead of the offer.
      anchor: () => document.querySelector("#offers-grid .offer-card[data-tour-demo]"),
      placement: "auto",
      onEnter: (mgr) => {
        navTo("offers");
        // One frame is enough for view-offers to mount; double-RAF
        // added a visible lag on the 6→7 transition.
        requestAnimationFrame(() => {
          injectDemoOffers();
          installOfferActionsGuard(mgr);
        });
      },
      onLeave: () => uninstallOfferActionsGuard(),
      waitFor: () => {
        const grid = $("#offers-grid");
        return offersViewReady() && grid?.querySelector("[data-tour-demo]") != null;
      },
    },
    {
      // Final chapter — a centered modal celebration. Single "Get Started"
      // CTA, no Back, no counter, no secondary action. Clicking it
      // dismisses the tour and drops the user back on the real product.
      id: "ready",
      // No railLabel → omitted from the chapter rail. The finale is a
      // celebration modal, not a "step" the user navigates between,
      // so it shouldn't appear in the side panel as a checkbox item.
      railLabel: "",
      railSub: "",
      hideFromRail: true,
      title: "You're ready to save.",
      body:
        "Upload your real bill any time and Bonsai goes to work — finding " +
        "the overcharges, drafting the appeal, sending it on a real domain. " +
        "You approve every move.",
      centered: true,
      hideBack: true,
      hideCounter: true,
      primaryLabel: "Get Started",
    },
  ];

  async function markCompleted() {
    try {
      await fetch("/api/auth/tour-completed", {
        method: "POST",
        credentials: "same-origin",
      });
      // Notify the Getting Started checklist (if mounted) so its progress
      // pill updates without waiting for the next /api/auth/me poll.
      window.dispatchEvent(new CustomEvent("bonsai:tour-completed"));
    } catch (err) {
      console.warn("[tour] failed to mark completed", err);
    }
  }

  function startBonsaiTour() {
    if (window.__bonsaiTour?.active) return;
    // Clear any stale state from a previous tour run — demo bills/offers,
    // open drawer, hidden filter chrome, etc. — so the replay begins
    // identically to a fresh first login. Chapter 1 is a centered modal
    // so we DON'T navigate to Home here — the modal opens wherever the
    // user is (Settings, Bills, anywhere) and they advance from there.
    clearDemoData();
    // Nuclear option for "go to Home when the tour ends": navigate the
    // browser to /app. Every previous attempt to coordinate showNav +
    // setWorkflowView + nav-item-click has reportedly missed in real
    // browsers despite passing automated checks. A full page nav is
    // physically impossible to land on the wrong tab — /app's init()
    // always defaults to the Home/overview view, the auth cookie
    // survives the navigation, the tour is already marked complete on
    // the server, and any in-flight UI state from the tour is wiped.
    // We await markCompleted so the server-side flag is set BEFORE
    // the reload — otherwise the tour might re-fire on the next load.
    const finishHome = async () => {
      window.__bonsaiTour = null;
      try { clearDemoData(); } catch {}
      try { await markCompleted(); } catch {}
      // Suppress the app's beforeunload "leave this site?" dialog —
      // the sample audit is still in reviewState when the tour ends,
      // which the unsaved-work guard would otherwise prompt about.
      // The tour intentionally throws away that state on finale.
      window.__bonsaiSkipUnsavedPrompt = true;
      // location.replace doesn't add a history entry — the user can't
      // hit Back and land in the middle of the tour.
      try { window.location.replace("/app"); }
      catch { try { window.location.assign("/app"); } catch { /* */ } }
    };
    const mgr = new TourManager({
      chapters: CHAPTERS,
      onComplete: finishHome,
      onSkip: finishHome,
    });
    // Refresh the visited set from localStorage on every new tour
    // instance — the constructor reads it once but a replay button
    // might have just deleted the key.
    mgr.visited = loadVisited();
    window.__bonsaiTour = mgr;
    mgr.start();
    // Preload the sample audit while the user is reading chapter 1 —
    // by the time they click Next, the review screen is already
    // populated and chapter 2 lands instantly.
    setTimeout(preloadSampleAudit, 50);
  }

  function maybeAutoFire(user) {
    if (!user) return;
    if (user.tour_completed_at) return;
    setTimeout(() => startBonsaiTour(), 150);
  }

  /** Open the chapter list in browse mode (panel only, no overlay).
   * Used by the Getting Started pill click. Closes if already open. */
  function toggleBonsaiTourPanel() {
    const mgr = window.__bonsaiTour;
    if (mgr?.active) {
      if (mgr.mode === "browse") mgr.closeBrowse();
      else mgr.skip();
      return;
    }
    const fresh = new TourManager({
      chapters: CHAPTERS,
      onComplete: () => { window.__bonsaiTour = null; markCompleted(); },
      onSkip: () => { window.__bonsaiTour = null; markCompleted(); },
    });
    window.__bonsaiTour = fresh;
    fresh.openBrowse();
  }

  /** Read-only snapshot of visited chapter ids (for the pill progress). */
  function getVisitedCount() {
    return loadVisited().size;
  }
  // Total = chapters that show up in the rail (the user-navigable
  // steps). The finale modal (`hideFromRail`) is a celebration screen,
  // not a step, so the pill reads "X / 7" instead of "X / 8".
  function getTotalChapters() {
    return CHAPTERS.filter((c) => !c.hideFromRail).length;
  }
  function getVisitedRailCount() {
    return CHAPTERS.filter((c) => !c.hideFromRail && loadVisited().has(c.id)).length;
  }

  window.startBonsaiTour = startBonsaiTour;
  window.toggleBonsaiTourPanel = toggleBonsaiTourPanel;
  window.__bonsaiTourMaybeAutoFire = maybeAutoFire;
  window.__bonsaiTourProgress = () => ({
    visited: getVisitedRailCount(),
    total: getTotalChapters(),
  });
})();
