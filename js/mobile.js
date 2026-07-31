/* =========================================================================
   myplanBYU — phone app mode
   Below 740px the three desktop panes become one view at a time, switched
   by the bottom app bar (#mnav). This module owns only that switching; all
   rendering stays in app.js. Everything here is inert on desktop: the CSS
   hides the bar above 740px, and body[data-mview] has no wide-screen rules.
   ========================================================================= */
(() => {
  const $ = s => document.querySelector(s);
  const bar = $("#mnav");
  if (!bar) return;
  const isPhone = () => window.matchMedia("(max-width: 740px)").matches;

  function setView(v) {
    document.body.dataset.mview = v;
    bar.querySelectorAll("button[data-view]").forEach(b =>
      b.classList.toggle("on", b.dataset.view === v));
  }
  setView("plan");

  bar.addEventListener("click", e => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    if (btn.dataset.view === "advisor") {
      // the chat is an overlay, not a pane — toggle it and keep the
      // underlying view; its lit state is synced by the observer below
      Chat.toggle(!$("#chatPanel").classList.contains("open"));
      return;
    }
    Chat.toggle(false);          // leaving via the bar always closes the chat
    setView(btn.dataset.view);
  });

  // light the Advisor tab whenever the chat is open, however it was opened
  new MutationObserver(() => {
    $("#mnavAdvisor").classList.toggle("lit", $("#chatPanel").classList.contains("open"));
  }).observe($("#chatPanel"), { attributes: true, attributeFilter: ["class"] });

  // choosing a plan is a destination, not a setting: tapping a plan card on
  // the My Plans view jumps to the board it just loaded (menu taps don't)
  $("#plansList").addEventListener("click", e => {
    if (!isPhone()) return;
    if (e.target.closest(".plan-menu-btn") || e.target.closest("input")) return;
    if (e.target.closest(".plan-card")) setView("plan");
  });

  // same instinct when the wizard hands over a fresh plan ("Generate plan"
  // is the final step's label; mid-wizard the button says "Next")
  $("#wizNext").addEventListener("click", () => {
    if (isPhone() && /generate/i.test($("#wizNext").textContent)) setView("plan");
  });

  // phone-only topbar icons stand in for the hidden nav tabs
  $("#topbarHowBtn").addEventListener("click", () => $("#navHow").click());
  $("#topbarFbBtn").addEventListener("click", () => $("#navFeedback").click());
})();
