import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./style.css";

import { App } from "./app.ts";
import type { ProtocolMode } from "./spanning-tree/index.ts";
import { BpduModal } from "./ui/bpdu-modal.ts";
import { ChaosPanel, TimingPanel } from "./ui/dials.ts";
import { Feed } from "./ui/feed.ts";
import { Inspector } from "./ui/inspector.ts";
import { MobileSheet } from "./ui/sheet.ts";
import { Timeline } from "./ui/timeline.ts";
import { createToaster } from "./ui/toasts.ts";
import { Topbar } from "./ui/topbar.ts";
import { TopologyScene } from "./viz/index.ts";

function need(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

// Same seed → same run (jitter, loss, chaos). Share with ?seed=1234.
const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed")) || Math.floor(Math.random() * 1_000_000);
const mode: ProtocolMode = params.get("mode") === "stp" ? "stp" : "rstp";

const app = new App(seed, mode);
app.onToast = createToaster(need("toasts"));

// Debug / shareable-scenario affordances. ?cut / ?split set up a failure, ?t
// fast-forwards the sim to that instant on load, ?paused freezes it there, and
// ?select pre-opens the inspector — so a single screenshot captures a known
// moment without waiting or clicking.
const cutParam = params.get("cut");
if (cutParam) app.sim.cutLink(cutParam);
if (params.get("split") === "1") app.sim.splitNetwork();

const advanceTo = Number(params.get("t"));
if (Number.isFinite(advanceTo) && advanceTo > 0) {
  app.sim.advanceTo(advanceTo);
  app.playhead = advanceTo;
}
if (params.get("paused") === "1") app.paused = true;

const selectParam = params.get("select");
if (selectParam) {
  if (app.sim.topology.links.has(selectParam)) app.selectLink(selectParam);
  else app.selectDevice(selectParam);
}

const sheet = new MobileSheet();

const scene = new TopologyScene(need("scene"), need("labels"), {
  onSelectDevice: (id) => {
    app.selectDevice(id);
    if (id) sheet.raise("side");
  },
  onSelectLink: (id) => {
    app.selectLink(id);
    if (id) sheet.raise("side");
  },
  onSelectFlight: (id) => app.inspectFlight(id),
  onMoveDevice: (id, pos) => app.moveDevice(id, pos),
  onDrawLink: (from, to) => app.drawLink(from, to),
  onBackground: () => {
    app.clearSelection();
    if (app.selectedFlight !== null) app.closeFlight();
  },
  onHoverLink: (id) => {
    app.hoveredLink = id;
  },
});
app.spawnPos = (i) => scene.spawnSpot(i);

const topbar = new Topbar(need("topbar"), app);
const dials = need("dials");
const chaosPanel = new ChaosPanel(dials, app);
const timingPanel = new TimingPanel(dials, app);
const side = need("side");
const inspector = new Inspector(side);
const feed = new Feed(side);
const timeline = new Timeline(need("timeline"), app);
const bpduModal = new BpduModal(need("modal"), app);

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  switch (e.key) {
    case " ":
      e.preventDefault();
      app.togglePause();
      break;
    case "l":
    case "L":
      app.goLive();
      break;
    case "Escape":
      if (app.selectedFlight !== null) app.closeFlight();
      else if (app.linkDrawMode) app.setLinkDrawMode(false);
      else app.clearSelection();
      break;
    case "Delete":
    case "Backspace": {
      const sel = app.selection;
      if (sel?.kind === "link") app.removeLink(sel.id);
      else if (sel?.kind === "device") app.removeDevice(sel.id);
      break;
    }
    case "ArrowLeft":
    case "ArrowRight": {
      e.preventDefault();
      const span = app.sim.duration - app.sim.horizon;
      const step = Math.max(span * 0.02, 0.1);
      app.scrub(app.playhead + (e.key === "ArrowLeft" ? -step : step));
      break;
    }
    case "[":
      app.setSpeed(app.speed / 1.5);
      break;
    case "]":
      app.setSpeed(app.speed * 1.5);
      break;
  }
});

declare global {
  interface Window {
    __rstp: App;
  }
}
window.__rstp = app;

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  app.tick(dt);
  scene.setLinkDrawMode(app.linkDrawMode);
  scene.update(app.renderView(), dt);
  topbar.update(app);
  chaosPanel.update(app);
  timingPanel.update(app);
  inspector.update(app);
  feed.update(app);
  timeline.update();
  bpduModal.update(app);

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
