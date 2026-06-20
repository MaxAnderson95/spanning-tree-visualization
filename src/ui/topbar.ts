import type { App } from "../app.ts";
import { el } from "./format.ts";

const MODE_READOUT = {
  rstp: "handshake · sub-second",
  stp: "timers · ~30–50 s",
} as const;

export class Topbar {
  private readonly rootValue: HTMLElement;
  private readonly switchValue: HTMLElement;
  private readonly linkValue: HTMLElement;
  private readonly blockedValue: HTMLElement;
  private readonly statusValue: HTMLElement;
  private readonly rstpBtn: HTMLButtonElement;
  private readonly stpBtn: HTMLButtonElement;
  private readonly modeReadout: HTMLElement;
  private readonly drawBtn: HTMLButtonElement;
  private readonly menu: HTMLElement;

  constructor(container: HTMLElement, app: App) {
    const wordmark = el("div", "wordmark");
    wordmark.append(el("h1", "", "RSTP"), el("span", "tagline", "spanning tree, visualized"));

    const stats = el("div", "cluster-stats panel");
    this.rootValue = stat(stats, "root", "—");
    this.switchValue = stat(stats, "switches", "0");
    this.linkValue = stat(stats, "links", "0");
    this.blockedValue = stat(stats, "blocked", "0");
    this.statusValue = stat(stats, "state", "…");

    const right = el("div", "topbar-right");

    // Mode toggle (first-class teaching control).
    const modeWrap = el("div", "mode-toggle");
    const seg = el("div", "mode-seg");
    this.rstpBtn = el("button", "rstp", "RSTP");
    this.stpBtn = el("button", "stp", "STP");
    this.rstpBtn.addEventListener("click", () => app.setMode("rstp"));
    this.stpBtn.addEventListener("click", () => app.setMode("stp"));
    seg.append(this.rstpBtn, this.stpBtn);
    this.modeReadout = el("div", "mode-readout", MODE_READOUT.rstp);
    modeWrap.append(seg, this.modeReadout);

    // Editor actions.
    const actions = el("div", "topbar-actions");
    const addSwitch = el("button", "btn", "+ Switch");
    addSwitch.addEventListener("click", () => app.addSwitch());
    const addHost = el("button", "btn", "+ Host");
    addHost.addEventListener("click", () => app.addHost());
    this.drawBtn = el("button", "btn", "Draw link");
    this.drawBtn.title = "Toggle, then drag switch-to-switch to wire a link";
    this.drawBtn.addEventListener("click", () => {
      app.setLinkDrawMode(!app.linkDrawMode);
    });

    // Reset menu.
    this.menu = el("div", "menu");
    const resetBtn = el("button", "btn", "Reset ▾");
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.menu.classList.toggle("is-open");
    });
    const pop = el("div", "menu-pop");
    pop.append(
      menuItem("Re-converge", "Cold-restart the whole network", () => {
        app.reset();
        this.menu.classList.remove("is-open");
      }),
      menuItem("Reset to default", "Restore the 4-switch loop + 2 hosts", () => {
        app.resetToDefault();
        this.menu.classList.remove("is-open");
      }),
      menuItem("Clear canvas", "Remove everything — build from scratch", () => {
        app.clearCanvas();
        this.menu.classList.remove("is-open");
      }),
    );
    this.menu.append(resetBtn, pop);
    document.addEventListener("click", () => this.menu.classList.remove("is-open"));

    actions.append(addSwitch, addHost, this.drawBtn, this.menu);
    right.append(modeWrap, actions);
    container.append(wordmark, stats, right);
  }

  update(app: App): void {
    const frame = app.frame();
    const topo = app.sim.topology;

    const islands = frame.islands;
    if (islands.length === 0) {
      this.rootValue.textContent = "—";
    } else if (islands.length === 1) {
      const root = islands[0]!.rootSwitchId;
      this.rootValue.textContent = root ? root.toUpperCase() : "—";
    } else {
      this.rootValue.textContent = `${islands.length} islands`;
    }

    this.switchValue.textContent = String(topo.switches.size);
    this.linkValue.textContent = String(topo.links.size);

    let blocked = 0;
    for (const b of frame.bridges)
      for (const p of b.snapshot.ports) if (p.role === "alternate") blocked += 1;
    this.blockedValue.textContent = String(blocked);

    const converged = islands.length > 0 && islands.every((i) => i.converged);
    this.statusValue.textContent = converged ? "converged ✓" : "converging…";
    this.statusValue.classList.toggle("is-converged", converged);
    this.statusValue.classList.toggle("is-converging", !converged);

    const mode = app.mode;
    this.rstpBtn.classList.toggle("is-active", mode === "rstp");
    this.stpBtn.classList.toggle("is-active", mode === "stp");
    this.modeReadout.textContent = MODE_READOUT[mode];
    this.drawBtn.classList.toggle("is-on", app.linkDrawMode);
  }
}

function stat(container: HTMLElement, key: string, value: string): HTMLElement {
  const row = el("div", "stat");
  const v = el("span", "v", value);
  if (key === "root") v.classList.add("root-name");
  row.append(el("span", "k", key), v);
  container.appendChild(row);
  return v;
}

function menuItem(label: string, sub: string, onClick: () => void): HTMLElement {
  const item = el("button", "menu-item");
  item.append(el("span", "", label), el("small", "", sub));
  item.addEventListener("click", onClick);
  return item;
}
