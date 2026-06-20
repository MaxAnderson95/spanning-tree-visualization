import type { App } from "../app.ts";
import { shortMac } from "../model/index.ts";
import type { BpduFlight } from "../sim/index.ts";
import type { Bpdu, BpduFlags } from "../spanning-tree/index.ts";
import { BPDU_COLORS, hexCss } from "../theme.ts";
import { el } from "./format.ts";

interface Described {
  readonly label: string;
  readonly sub: string;
  readonly color: string;
}

function describe(bpdu: Bpdu): Described {
  if (bpdu.flags.proposal)
    return {
      label: "Proposal",
      sub: "designated port wants to forward",
      color: hexCss(BPDU_COLORS.proposal),
    };
  if (bpdu.flags.agreement)
    return {
      label: "Agreement",
      sub: "unblocks the proposer at once",
      color: hexCss(BPDU_COLORS.agreement),
    };
  if (bpdu.flags.topologyChange)
    return {
      label: "Topology Change",
      sub: "flush learned addresses",
      color: hexCss(BPDU_COLORS.tc),
    };
  return {
    label: bpdu.version === "rstp" ? "RST BPDU" : "Config BPDU",
    sub: bpdu.version === "rstp" ? "rapid hello" : "from the root, relayed outward",
    color: hexCss(BPDU_COLORS.hello),
  };
}

const FLAG_KEYS: { key: keyof BpduFlags; label: string; cls: string }[] = [
  { key: "proposal", label: "proposal", cls: "proposal" },
  { key: "agreement", label: "agreement", cls: "agreement" },
  { key: "learning", label: "learning", cls: "" },
  { key: "forwarding", label: "forwarding", cls: "" },
  { key: "topologyChange", label: "topology change", cls: "tc" },
];

export class BpduModal {
  private readonly app: App;
  private readonly overlay: HTMLElement;
  private readonly dialog: HTMLElement;
  private currentId: number | null = null;
  private dyn: { progress: HTMLElement; eta: HTMLElement } | null = null;

  constructor(mount: HTMLElement, app: App) {
    this.app = app;
    this.overlay = el("div", "msg-overlay");
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) app.closeFlight();
    });
    this.dialog = el("div", "panel msg-modal");
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.overlay.appendChild(this.dialog);
    mount.appendChild(this.overlay);
  }

  update(app: App): void {
    const id = app.selectedFlight;
    if (id === null) {
      this.hide();
      return;
    }
    const flight = app.findFlight(id);
    if (!flight) {
      app.closeFlight();
      this.hide();
      return;
    }
    if (id !== this.currentId) {
      this.currentId = id;
      this.build(flight);
    }
    this.refresh(flight, app.playhead);
    this.overlay.classList.add("is-open");
  }

  private hide(): void {
    if (this.currentId === null && !this.overlay.classList.contains("is-open")) return;
    this.overlay.classList.remove("is-open");
    this.currentId = null;
    this.dyn = null;
  }

  private build(flight: BpduFlight): void {
    const bpdu = flight.bpdu;
    const d = describe(bpdu);

    const head = el("div", "msg-head");
    const dot = el("span", "msg-dot");
    dot.style.color = d.color;
    const titles = el("div", "msg-titles");
    titles.append(el("div", "msg-kind", d.label), el("div", "msg-sub", d.sub));
    const close = el("button", "msg-close", "\u00d7");
    close.addEventListener("click", () => this.app.closeFlight());
    head.append(dot, titles, close);

    const route = el("div", "msg-route");
    route.append(
      el("span", "", flight.fromSwitch.toUpperCase()),
      el("span", "msg-arrow", "\u2192"),
      el("span", "", flight.toDevice.toUpperCase()),
    );

    const grid = el("div", "inspector-grid");
    const addRow = (k: string, v: string): HTMLElement => {
      const value = el("span", "v", v);
      grid.append(el("span", "k", k), value);
      return value;
    };
    addRow("root bridge", `${bpdu.rootId.priority} · ${shortMac(bpdu.rootId.mac)}`);
    addRow("root path cost", String(bpdu.rootPathCost));
    addRow(
      "sender bridge",
      `${bpdu.senderBridgeId.priority} · ${shortMac(bpdu.senderBridgeId.mac)}`,
    );
    addRow("sender port", `pri ${bpdu.senderPortId.priority} · P${bpdu.senderPortId.num}`);
    addRow("sender role", bpdu.flags.portRole);
    addRow("message age", `${bpdu.messageAge} / ${bpdu.maxAge}`);
    const progress = addRow("progress", "");
    const eta = addRow(flight.lost ? "drops in" : "arrives in", "");
    this.dyn = { progress, eta };

    const flagWrap = el("div", "flag-chips");
    for (const f of FLAG_KEYS) {
      const on = Boolean(bpdu.flags[f.key]);
      const chip = el("span", `flag-chip ${on ? `on ${f.cls}` : ""}`.trim(), f.label);
      flagWrap.append(chip);
    }

    this.dialog.replaceChildren(
      head,
      route,
      grid,
      el("div", "msg-section-label", "flags"),
      flagWrap,
    );
  }

  private refresh(flight: BpduFlight, playhead: number): void {
    if (!this.dyn) return;
    const span = flight.deliverAt - flight.sentAt;
    const frac = span > 0 ? Math.min(Math.max((playhead - flight.sentAt) / span, 0), 1) : 1;
    this.dyn.progress.textContent = `${Math.round(frac * 100)}%`;
    this.dyn.eta.textContent = `${Math.max(0, flight.deliverAt - playhead).toFixed(2)} s`;
  }
}
