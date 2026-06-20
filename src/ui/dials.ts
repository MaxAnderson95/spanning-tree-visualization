import type { App } from "../app.ts";
import { DEFAULT_TIMING } from "../spanning-tree/index.ts";
import { el } from "./format.ts";

interface DialOptions {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly tooltip?: string;
  readonly read: () => number;
  readonly onInput: (value: number) => void;
}

interface Dial {
  readonly row: HTMLElement;
  sync(): void;
}

let tipDismissArmed = false;
function armTipDismiss(): void {
  if (tipDismissArmed) return;
  tipDismissArmed = true;
  document.addEventListener("click", () => {
    for (const open of document.querySelectorAll(".info.is-open")) open.classList.remove("is-open");
  });
}

function infoBadge(text: string): HTMLElement {
  armTipDismiss();
  const badge = el("span", "info", "i");
  badge.tabIndex = 0;
  badge.setAttribute("role", "button");
  badge.setAttribute("aria-label", text);
  const tip = el("span", "info-tip", text);
  badge.appendChild(tip);
  const toggle = (): void => {
    const willOpen = !badge.classList.contains("is-open");
    for (const open of document.querySelectorAll(".info.is-open")) open.classList.remove("is-open");
    badge.classList.toggle("is-open", willOpen);
  };
  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  return badge;
}

function dial(options: DialOptions): Dial {
  const row = el("div", "dial");
  const head = el("div", "dial-head");
  const label = el("span", "dial-label");
  label.append(el("span", "", options.label));
  if (options.tooltip) label.appendChild(infoBadge(options.tooltip));
  const value = el("span", "v", options.format(options.read()));
  head.append(label, value);

  const input = el("input") as HTMLInputElement;
  input.type = "range";
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(options.read());
  input.setAttribute("aria-label", options.label);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    value.textContent = options.format(v);
    options.onInput(v);
  });

  row.append(head, input);
  return {
    row,
    sync(): void {
      const v = options.read();
      if (Number(input.value) !== v) {
        input.value = String(v);
        value.textContent = options.format(v);
      }
    },
  };
}

function titleBar(name: string, onReset: () => void): HTMLElement {
  const title = el("div", "panel-title");
  const reset = el("button", "mini-reset", "reset");
  reset.addEventListener("click", onReset);
  title.append(el("span", "", name), reset);
  return title;
}

function togglePill(
  label: string,
  get: () => boolean,
  set: (v: boolean) => void,
): {
  row: HTMLElement;
  sync(): void;
} {
  const row = el("div", "toggle-row");
  const pill = el("button", "switch-pill");
  pill.setAttribute("role", "switch");
  pill.setAttribute("aria-label", label);
  pill.addEventListener("click", () => set(!get()));
  row.append(el("span", "", label), pill);
  return {
    row,
    sync(): void {
      pill.classList.toggle("is-on", get());
    },
  };
}

const sec = (v: number): string => `${v} s`;
const pct = (v: number): string => `${v}%`;
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** The protocol's own timers, applied live, plus the 802.1D stability check. */
export class TimingPanel {
  private readonly dials: Dial[];
  private readonly status: HTMLElement;

  constructor(container: HTMLElement, app: App) {
    const panel = el("div", "panel");
    panel.append(titleBar("protocol timing", () => app.setTiming({ ...DEFAULT_TIMING })));
    const body = el("div", "dials-body");

    this.dials = [
      dial({
        label: "hello",
        min: 1,
        max: 10,
        step: 1,
        format: sec,
        tooltip:
          "How often each bridge sends BPDUs. RSTP detects a dead neighbour after 3 missed Hellos.",
        read: () => app.sim.helloTime,
        onInput: (v) => app.setTiming({ helloTime: v }),
      }),
      dial({
        label: "forward delay",
        min: 4,
        max: 30,
        step: 1,
        format: sec,
        tooltip:
          "Time a port spends in Listening, then Learning, before Forwarding (STP, or the RSTP timer fallback).",
        read: () => app.sim.forwardDelay,
        onInput: (v) => app.setTiming({ forwardDelay: v }),
      }),
      dial({
        label: "max age",
        min: 6,
        max: 40,
        step: 1,
        format: sec,
        tooltip:
          "How long stored BPDU info lives without a refresh before it expires and the port reconverges.",
        read: () => app.sim.maxAge,
        onInput: (v) => app.setTiming({ maxAge: v }),
      }),
    ];
    body.append(...this.dials.map((d) => d.row));
    this.status = el("div", "dials-status");
    body.append(this.status);

    panel.append(body);
    container.appendChild(panel);
  }

  update(app: App): void {
    for (const d of this.dials) d.sync();
    const hello = app.sim.helloTime;
    const fd = app.sim.forwardDelay;
    const age = app.sim.maxAge;
    // IEEE 802.1D relationships: 2·(FwdDelay−1) ≥ MaxAge ≥ 2·(Hello+1).
    const ok = 2 * (fd - 1) >= age && age >= 2 * (hello + 1);
    this.status.classList.toggle("is-risky", !ok);
    this.status.textContent = ok
      ? "timers satisfy 2·(FwdDelay−1) ≥ MaxAge ≥ 2·(Hello+1)"
      : "⚠ timer relationship violated — a real bridge would reject these";
  }
}

/** Everything that stresses the network: chaos disruptions + link conditions. */
export class ChaosPanel {
  private readonly toggles: { row: HTMLElement; sync(): void }[];
  private readonly dials: Dial[];
  private readonly intensity: Dial;
  private readonly healBtn: HTMLButtonElement;
  private readonly splitBtn: HTMLButtonElement;
  private readonly status: HTMLElement;

  constructor(container: HTMLElement, app: App) {
    const panel = el("div", "panel");
    panel.append(
      titleBar("chaos", () => {
        const c = app.chaos;
        c.linkFlap = c.powerCycle = c.partition = c.priorityChurn = false;
        c.disarmRestores();
        app.sim.resetNetwork();
      }),
    );
    const body = el("div", "dials-body");
    const c = app.chaos;

    const dis = el("div", "sub-label");
    dis.append(
      document.createTextNode("disruptions"),
      infoBadge(
        "Armed disruptions fire on their own at a cadence set by intensity. All seeded and off by default.",
      ),
    );
    body.append(dis);
    this.toggles = [
      togglePill(
        "link flap",
        () => c.linkFlap,
        (v) => (c.linkFlap = v),
      ),
      togglePill(
        "switch power-cycle",
        () => c.powerCycle,
        (v) => (c.powerCycle = v),
      ),
      togglePill(
        "partition / heal",
        () => c.partition,
        (v) => (c.partition = v),
      ),
      togglePill(
        "priority churn",
        () => c.priorityChurn,
        (v) => (c.priorityChurn = v),
      ),
    ];
    body.append(...this.toggles.map((t) => t.row));

    this.intensity = dial({
      label: "intensity",
      min: 0,
      max: 100,
      step: 1,
      format: pct,
      tooltip: "How often chaos acts. Higher = more frequent disruptions.",
      read: () => Math.round(c.intensity * 100),
      onInput: (v) => (c.intensity = v / 100),
    });
    body.append(this.intensity.row);

    body.append(el("div", "sub-label", "manual partition"));
    const segRow = el("div", "seg-row");
    this.splitBtn = el("button", "btn", "Split");
    this.splitBtn.addEventListener("click", () => app.split());
    this.healBtn = el("button", "btn", "Heal");
    this.healBtn.addEventListener("click", () => app.heal());
    segRow.append(this.splitBtn, this.healBtn);
    body.append(segRow);
    this.status = el("div", "dials-status", "network whole");
    body.append(this.status);

    const net = el("div", "sub-label");
    net.append(
      document.createTextNode("link conditions"),
      infoBadge(
        "Losing ~3 BPDUs in a row on a healthy link ages out the port and triggers a spurious reconvergence.",
      ),
    );
    body.append(net);
    this.dials = [
      dial({
        label: "BPDU loss",
        min: 0,
        max: 100,
        step: 1,
        format: pct,
        tooltip: "Chance each BPDU is dropped in flight. A lost BPDU is never retransmitted.",
        read: () => Math.round(app.sim.network.loss * 100),
        onInput: (v) => (app.sim.network.loss = v / 100),
      }),
      dial({
        label: "latency",
        min: 0,
        max: 1,
        step: 0.01,
        format: (v) => `${v.toFixed(2)} s`,
        tooltip: "Base one-way delay before a BPDU arrives. Kept short relative to the timers.",
        read: () => round1(app.sim.network.latency * 100) / 100,
        onInput: (v) => (app.sim.network.latency = v),
      }),
      dial({
        label: "jitter",
        min: 0,
        max: 1,
        step: 0.01,
        format: (v) => `± ${v.toFixed(2)} s`,
        tooltip: "Random extra delay on top of latency, per BPDU.",
        read: () => Math.round(app.sim.network.jitter * 100) / 100,
        onInput: (v) => (app.sim.network.jitter = v),
      }),
    ];
    body.append(...this.dials.map((d) => d.row));

    panel.append(body);
    container.appendChild(panel);
  }

  update(app: App): void {
    for (const t of this.toggles) t.sync();
    for (const d of this.dials) d.sync();
    this.intensity.sync();

    const split = app.sim.activeSplit.length > 0 || app.frame().islands.length > 1;
    this.healBtn.disabled = app.sim.activeSplit.length === 0;
    this.healBtn.classList.toggle("is-danger", app.sim.activeSplit.length > 0);
    this.status.classList.toggle("is-split", split);
    const islands = app.frame().islands.length;
    this.status.textContent =
      islands > 1 ? `${islands} islands — each with its own root` : "network whole";
  }
}
