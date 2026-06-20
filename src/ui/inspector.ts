import type { App } from "../app.ts";
import {
  BRIDGE_PRIORITY_STEP,
  MAX_BRIDGE_PRIORITY,
  MAX_PORT_PRIORITY,
  PORT_PRIORITY_STEP,
  parsePortId,
  portIdOf,
  type LinkConfig,
  type LinkSpeed,
} from "../model/index.ts";
import type { BridgeSnapshot, PortSnapshot } from "../spanning-tree/index.ts";
import { ROLE_LABEL, STATE_CSS } from "../theme.ts";
import { el } from "./format.ts";

const SPEEDS: LinkSpeed[] = [10, 100, 1000, 10000];
const SPEED_LABEL: Record<LinkSpeed, string> = { 10: "10M", 100: "100M", 1000: "1G", 10000: "10G" };

export class Inspector {
  private readonly body: HTMLElement;
  private key = "";
  private refresh: ((app: App) => void) | null = null;

  constructor(container: HTMLElement) {
    const panel = el("div", "panel");
    panel.append(titleBar("inspector"));
    this.body = el("div");
    panel.append(this.body);
    container.appendChild(panel);
    this.showEmpty();
  }

  update(app: App): void {
    const key = this.keyFor(app);
    if (key !== this.key) {
      this.key = key;
      this.build(app);
    }
    this.refresh?.(app);
  }

  // -------------------------------------------------------------------------

  private keyFor(app: App): string {
    const sel = app.selection;
    if (!sel) return "";
    if (sel.kind === "device" && app.sim.topology.hosts.has(sel.id)) return `host:${sel.id}`;
    if (sel.kind === "device") {
      const snap = bridgeSnap(app, sel.id);
      const portSig = snap ? snap.ports.map((p) => p.id).join(",") : "off";
      return `sw:${sel.id}:${portSig}`;
    }
    if (sel.kind === "link") return `link:${sel.id}`;
    return `port:${sel.id}`;
  }

  private showEmpty(): void {
    this.refresh = null;
    this.body.replaceChildren(
      el("div", "inspector-empty", "Click a switch, host, link, or port to inspect it."),
    );
  }

  private build(app: App): void {
    const sel = app.selection;
    if (!sel) {
      this.showEmpty();
      return;
    }
    if (sel.kind === "link") return this.buildLink(app, sel.id);
    if (sel.kind === "port") return this.buildPort(app, sel.id);
    if (app.sim.topology.hosts.has(sel.id)) return this.buildHost(app, sel.id);
    return this.buildSwitch(app, sel.id);
  }

  // ---- switch ----

  private buildSwitch(app: App, id: string): void {
    const sw = app.sim.topology.switches.get(id);
    if (!sw) {
      this.showEmpty();
      return;
    }
    const body = el("div", "inspector-body");

    const head = el("div", "inspector-head");
    const bigId = el("span", "big-id", sw.label);
    head.append(bigId, el("span", "kind-badge", "switch"));
    body.append(head);

    const grid = el("div", "inspector-grid");
    const rootRef = gridRow(grid, "is root");
    const costRef = gridRow(grid, "root path cost");
    const rpRef = gridRow(grid, "root port");
    gridRow(grid, "bridge id").textContent = `${sw.priority} · ${sw.mac}`;
    body.append(grid);

    body.append(el("div", "sub-label", "bridge priority"));
    const prio = stepper(sw.priority, BRIDGE_PRIORITY_STEP, 0, MAX_BRIDGE_PRIORITY, (v) =>
      app.setBridgePriority(id, v),
    );
    body.append(prio.row);

    body.append(el("div", "sub-label", "ports"));
    const table = el("table", "port-table");
    table.innerHTML =
      "<thead><tr><th>port</th><th>role</th><th>state</th><th>cost</th><th>pri</th><th></th></tr></thead>";
    const tbody = el("tbody");
    table.append(tbody);
    body.append(table);

    const actions = el("div", "inspector-actions");
    const power = el("button", "btn is-danger", "Power off");
    power.addEventListener("click", () => {
      const off = app.frame().poweredOff.includes(id);
      if (off) app.powerOn(id);
      else app.powerOff(id);
    });
    const restart = el("button", "btn", "Restart");
    restart.addEventListener("click", () => app.restart(id));
    const remove = el("button", "btn is-danger", "Remove");
    remove.addEventListener("click", () => app.removeDevice(id));
    actions.append(power, restart, remove);
    body.append(actions);

    this.body.replaceChildren(body);

    this.refresh = (a) => {
      const snap = bridgeSnap(a, id);
      const off = a.frame().poweredOff.includes(id);
      power.textContent = off ? "Power on" : "Power off";
      bigId.innerHTML = snap?.isRoot ? `<span class="crown">♛</span> ${sw.label}` : sw.label;
      rootRef.textContent = snap ? (snap.isRoot ? "yes — this is the root" : "no") : "powered off";
      rootRef.classList.toggle("root-gold", !!snap?.isRoot);
      costRef.textContent = snap ? String(snap.rootPathCost) : "—";
      rpRef.textContent = snap?.rootPortId ? portLabelOf(snap.rootPortId) : "—";
      prio.set(sw.priority);
      this.renderPortRows(a, tbody, snap);
    };
  }

  private renderPortRows(app: App, tbody: HTMLElement, snap: BridgeSnapshot | undefined): void {
    const selectedPort = app.selection?.kind === "port" ? app.selection.id : null;
    tbody.replaceChildren();
    if (!snap || snap.ports.length === 0) {
      const tr = el("tr");
      const td = el("td", "", "no ports — draw a link");
      td.colSpan = 6;
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const p of snap.ports) {
      const tr = el("tr");
      tr.classList.toggle("is-selected", p.id === selectedPort);
      const portCell = el("td", "", `P${p.num}`);
      const roleCell = el("td");
      roleCell.append(roleTag(p.role));
      const stateCell = el("td");
      const dot = el("span", "state-dot");
      dot.style.background = STATE_CSS[p.state];
      stateCell.append(dot, document.createTextNode(p.state));
      const costCell = el("td", "", String(p.cost));
      const priCell = el("td", "", String(p.priority));
      const edgeCell = el("td");
      if (p.edge) edgeCell.append(el("span", "edge-pip", "edge"));
      tr.append(portCell, roleCell, stateCell, costCell, priCell, edgeCell);
      tr.addEventListener("click", () => app.selectPort(p.id));
      tbody.append(tr);
    }
  }

  // ---- host ----

  private buildHost(app: App, id: string): void {
    const host = app.sim.topology.hosts.get(id);
    if (!host) {
      this.showEmpty();
      return;
    }
    const body = el("div", "inspector-body");
    const head = el("div", "inspector-head");
    head.append(el("span", "big-id", host.label), el("span", "kind-badge", "host"));
    body.append(head);

    const grid = el("div", "inspector-grid");
    gridRow(grid, "mac").textContent = host.mac;
    const attachRef = gridRow(grid, "attached to");
    body.append(grid);

    const actions = el("div", "inspector-actions");
    const remove = el("button", "btn is-danger", "Remove");
    remove.addEventListener("click", () => app.removeDevice(id));
    actions.append(remove);
    body.append(actions);
    this.body.replaceChildren(body);

    this.refresh = (a) => {
      let attached = "—";
      for (const link of a.sim.topology.links.values()) {
        if (link.a.device === id) attached = `${link.b.device.toUpperCase()} · P${link.b.portNum}`;
        else if (link.b.device === id)
          attached = `${link.a.device.toUpperCase()} · P${link.a.portNum}`;
      }
      attachRef.textContent = attached;
    };
  }

  // ---- link ----

  private buildLink(app: App, id: string): void {
    const link = app.sim.topology.links.get(id);
    if (!link) {
      this.showEmpty();
      return;
    }
    const body = el("div", "inspector-body");
    const head = el("div", "inspector-head");
    head.append(
      el("span", "big-id", `${link.a.device.toUpperCase()} ↔ ${link.b.device.toUpperCase()}`),
      el("span", "kind-badge", "link"),
    );
    body.append(head);

    const grid = el("div", "inspector-grid");
    const aRef = gridRow(grid, `${link.a.device.toUpperCase()} · P${link.a.portNum}`);
    const bRef = gridRow(grid, `${link.b.device.toUpperCase()} · P${link.b.portNum}`);
    body.append(grid);

    body.append(el("div", "sub-label", "speed"));
    const select = el("select", "inspector-select") as HTMLSelectElement;
    for (const s of SPEEDS) {
      const opt = el("option", "", `${SPEED_LABEL[s]}  ·  cost ${defaultCost(s)}`);
      opt.value = String(s);
      select.append(opt);
    }
    select.value = String(link.speed);
    select.addEventListener("change", () =>
      app.setLinkSpeed(id, Number(select.value) as LinkSpeed),
    );
    body.append(select);

    const actions = el("div", "inspector-actions");
    const cut = el("button", "btn is-danger", "Cut");
    cut.addEventListener("click", () => {
      const isCut = app.frame().cutLinks.includes(id);
      if (isCut) app.restoreLink(id);
      else app.cutLink(id);
    });
    const del = el("button", "btn is-danger", "Delete");
    del.addEventListener("click", () => app.removeLink(id));
    actions.append(cut, del);
    body.append(actions);
    this.body.replaceChildren(body);

    this.refresh = (a) => {
      cut.textContent = a.frame().cutLinks.includes(id) ? "Restore" : "Cut";
      aRef.replaceChildren(endSummary(a, link, "a"));
      bRef.replaceChildren(endSummary(a, link, "b"));
    };
  }

  // ---- port ----

  private buildPort(app: App, portId: string): void {
    const { device } = parsePortId(portId);
    const sw = app.sim.topology.switches.get(device);
    if (!sw) {
      this.showEmpty();
      return;
    }
    const body = el("div", "inspector-body");
    const head = el("div", "inspector-head");
    head.append(
      el("span", "big-id", `${device.toUpperCase()} · ${portLabelOf(portId)}`),
      el("span", "kind-badge", "port"),
    );
    body.append(head);

    const grid = el("div", "inspector-grid");
    const roleRef = gridRow(grid, "role");
    const stateRef = gridRow(grid, "state");
    const costRef = gridRow(grid, "cost");
    const edgeRef = gridRow(grid, "edge");
    const timerRef = gridRow(grid, "timer");
    body.append(grid);

    body.append(el("div", "sub-label", "port priority"));
    const port0 = portSnapOf(app, portId);
    const prio = stepper(port0?.priority ?? 128, PORT_PRIORITY_STEP, 0, MAX_PORT_PRIORITY, (v) =>
      app.setPortPriority(portId, v),
    );
    body.append(prio.row);

    const actions = el("div", "inspector-actions");
    const shut = el("button", "btn is-danger", "Shut");
    shut.addEventListener("click", () => {
      if (app.frame().shutPorts.includes(portId)) app.noShutPort(portId);
      else app.shutPort(portId);
    });
    const back = el("button", "btn", "◂ Switch");
    back.addEventListener("click", () => app.selectDevice(device));
    actions.append(shut, back);
    body.append(actions);
    this.body.replaceChildren(body);

    this.refresh = (a) => {
      const p = portSnapOf(a, portId);
      roleRef.replaceChildren(p ? roleTag(p.role) : document.createTextNode("—"));
      if (p) {
        stateRef.textContent = p.state;
        stateRef.style.color = STATE_CSS[p.state];
        costRef.textContent = String(p.cost);
        edgeRef.textContent = p.edge ? "yes (PortFast)" : "no";
        timerRef.textContent =
          p.forwardTimer !== null
            ? `forward-delay ${p.forwardTimer.toFixed(1)}s`
            : p.ageTimer !== null
              ? `age ${p.ageTimer.toFixed(1)}s`
              : "—";
        prio.set(p.priority);
      } else {
        stateRef.textContent = "—";
      }
      shut.textContent = a.frame().shutPorts.includes(portId) ? "No-shut" : "Shut";
    };
  }
}

// ---------------------------------------------------------------------------

function titleBar(name: string): HTMLElement {
  const title = el("div", "panel-title");
  title.append(el("span", "", name));
  return title;
}

function gridRow(grid: HTMLElement, label: string): HTMLElement {
  const value = el("span", "v");
  grid.append(el("span", "k", label), value);
  return value;
}

function roleTag(role: PortSnapshot["role"]): HTMLElement {
  return el("span", `role-tag ${role}`, ROLE_LABEL[role]);
}

function endSummary(app: App, link: LinkConfig, which: "a" | "b"): HTMLElement {
  const end = which === "a" ? link.a : link.b;
  const p = portSnapOf(app, portIdOf(end));
  const span = el("span");
  if (p) {
    const dot = el("span", "state-dot");
    dot.style.background = STATE_CSS[p.state];
    span.append(
      roleTag(p.role),
      document.createTextNode(" "),
      dot,
      document.createTextNode(p.state),
    );
  } else {
    span.textContent = "host / down";
  }
  return span;
}

function bridgeSnap(app: App, switchId: string): BridgeSnapshot | undefined {
  return app.frame().bridges.find((b) => b.switchId === switchId)?.snapshot;
}

function portSnapOf(app: App, portId: string): PortSnapshot | undefined {
  const { device } = parsePortId(portId);
  return bridgeSnap(app, device)?.ports.find((p) => p.id === portId);
}

function portLabelOf(portId: string): string {
  return `P${parsePortId(portId).portNum}`;
}

function defaultCost(speed: LinkSpeed): number {
  return { 10: 100, 100: 19, 1000: 4, 10000: 2 }[speed];
}

interface Stepper {
  readonly row: HTMLElement;
  set(value: number): void;
}

function stepper(
  initial: number,
  step: number,
  min: number,
  max: number,
  onChange: (value: number) => void,
): Stepper {
  const row = el("div", "stepper");
  const dec = el("button", "", "−");
  const val = el("span", "val", String(initial));
  const inc = el("button", "", "+");
  let value = initial;
  const apply = (next: number): void => {
    value = Math.min(max, Math.max(min, next));
    val.textContent = String(value);
    onChange(value);
  };
  dec.addEventListener("click", () => apply(value - step));
  inc.addEventListener("click", () => apply(value + step));
  row.append(dec, val, inc);
  return {
    row,
    set(v: number): void {
      value = v;
      val.textContent = String(v);
    },
  };
}
