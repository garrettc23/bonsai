// Bonsai onboarding pill — sits above the sidebar tagline. Clicking it
// toggles the Bonsai Product Tour panel (a chapter list rendered by
// /assets/tour.js in browse mode). Progress shown on the pill is the
// number of chapters the user has visited at least once across tour
// runs (persisted to localStorage by tour.js).

(function () {
  "use strict";

  function $(s, root = document) { return root.querySelector(s); }

  let pillEl = null;

  function ensureMounted() {
    if (pillEl) return;
    const sidebarFoot = $(".sidebar-foot");
    const sidebar = $(".sidebar");
    if (!sidebar) return;
    pillEl = document.createElement("button");
    pillEl.type = "button";
    pillEl.className = "gs-pill";
    pillEl.setAttribute("aria-label", "Open Bonsai Product Tour");
    if (sidebarFoot) sidebarFoot.insertBefore(pillEl, sidebarFoot.firstChild);
    else sidebar.appendChild(pillEl);
    pillEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (typeof window.toggleBonsaiTourPanel === "function") {
        window.toggleBonsaiTourPanel();
      }
    });
  }

  function render() {
    ensureMounted();
    if (!pillEl) return;
    const progress = (typeof window.__bonsaiTourProgress === "function"
      ? window.__bonsaiTourProgress()
      : { visited: 0, total: 6 });
    const { visited, total } = progress;
    const allDone = visited >= total && total > 0;
    pillEl.hidden = allDone;
    pillEl.classList.toggle("is-complete", allDone);
    pillEl.innerHTML = `
      <span class="gs-pill-label">Getting started</span>
      <span class="gs-pill-progress">${visited}/${total}</span>`;
  }

  function attach(user) {
    if (!user) return;
    render();
    // Refresh whenever a tour chapter is visited or the tour finishes.
    // Both events fire from tour.js — they keep the pill in sync without
    // polling.
    window.addEventListener("bonsai:tour-visited", render);
    window.addEventListener("bonsai:tour-completed", render);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) render();
    });
  }

  window.__bonsaiGettingStartedAttach = attach;
  window.__bonsaiGettingStartedRefresh = render;
})();
