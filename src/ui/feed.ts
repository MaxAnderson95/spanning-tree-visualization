import type { App } from "../app.ts";
import { parsePortId } from "../model/index.ts";
import type { Frame, NarratedStpEvent, SimCause } from "../sim/index.ts";
import type { StpEvent } from "../spanning-tree/index.ts";
import { ROLE_CSS } from "../theme.ts";
import { el, escapeHtml, formatTime } from "./format.ts";

const MAX_LINES = 70;

interface Line {
  readonly time: number;
  readonly color: string;
  readonly html: string;
}

export class Feed {
  private readonly body: HTMLElement;
  private lastTime = -1;

  constructor(container: HTMLElement) {
    const panel = el("div", "panel feed");
    const title = el("div", "panel-title");
    title.append(el("span", "", "event feed"));
    this.body = el("div", "feed-body");
    this.body.append(el("div", "feed-empty", "Watching the tree converge…"));
    panel.append(title, this.body);
    container.appendChild(panel);
  }

  update(app: App): void {
    const t = app.playhead;
    if (t < this.lastTime) {
      this.body.replaceChildren();
      this.lastTime = -1;
    }
    const fresh: Line[] = [];
    const frames = app.sim.frames;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (!frame || frame.time <= this.lastTime) break;
      if (frame.time > t) continue;
      fresh.push(...narrate(frame));
    }
    this.lastTime = t;
    if (fresh.length === 0) return;

    this.body.querySelector(".feed-empty")?.remove();
    for (const line of fresh.reverse()) {
      const newest = this.body.firstElementChild?.querySelector("span:last-child");
      if (newest && newest.innerHTML === line.html) continue;
      const div = el("div", "feed-line");
      const dot = el("span", "dot");
      dot.style.background = line.color;
      const time = el("span", "t", formatTime(line.time));
      const text = el("span");
      text.innerHTML = line.html;
      div.append(time, dot, text);
      this.body.prepend(div);
    }
    while (this.body.children.length > MAX_LINES) this.body.lastChild?.remove();
  }
}

function narrate(frame: Frame): Line[] {
  const lines: Line[] = [];
  const causeLine = narrateCause(frame.cause);
  if (causeLine) lines.push({ time: frame.time, ...causeLine });
  for (const ev of frame.events) {
    const line = narrateEvent(ev);
    if (line) lines.push({ time: frame.time, ...line });
  }
  return lines.reverse();
}

const FAINT = "#515f7e";

function narrateCause(cause: SimCause): { color: string; html: string } | null {
  switch (cause.kind) {
    case "init":
      return { color: FAINT, html: "network powered on — cold start" };
    case "reset":
      return { color: FAINT, html: "re-converge — cold restart" };
    case "resetDefault":
      return { color: FAINT, html: "reset to the default network" };
    case "clearCanvas":
      return { color: FAINT, html: "canvas cleared" };
    case "powerOff":
      return {
        color: ROLE_CSS.alternate,
        html: `<strong>${up(cause.switchId)}</strong> powered off`,
      };
    case "powerOn":
      return {
        color: ROLE_CSS.designated,
        html: `<strong>${up(cause.switchId)}</strong> powered on`,
      };
    case "restart":
      return {
        color: ROLE_CSS.designated,
        html: `<strong>${up(cause.switchId)}</strong> restarted (cold)`,
      };
    case "linkCut":
      return { color: ROLE_CSS.alternate, html: `link <strong>${cause.linkId}</strong> cut` };
    case "linkRestore":
      return { color: ROLE_CSS.designated, html: `link <strong>${cause.linkId}</strong> restored` };
    case "portShut":
      return { color: ROLE_CSS.alternate, html: `<strong>${portText(cause.portId)}</strong> shut` };
    case "portNoShut":
      return {
        color: ROLE_CSS.designated,
        html: `<strong>${portText(cause.portId)}</strong> no-shut`,
      };
    case "addLink":
      return { color: ROLE_CSS.root, html: `link <strong>${cause.linkId}</strong> drawn` };
    case "addSwitch":
      return { color: ROLE_CSS.root, html: `<strong>${up(cause.switchId)}</strong> added` };
    case "addHost":
      return { color: ROLE_CSS.root, html: `<strong>${up(cause.hostId)}</strong> added` };
    case "removeDevice":
      return { color: FAINT, html: `<strong>${up(cause.deviceId)}</strong> removed` };
    case "removeLink":
      return { color: FAINT, html: `link <strong>${cause.linkId}</strong> removed` };
    case "split":
      return { color: ROLE_CSS.alternate, html: "network split into islands" };
    case "heal":
      return { color: ROLE_CSS.designated, html: "partition healed — merging" };
    case "setMode":
      return { color: ROLE_CSS.root, html: `mode → <strong>${cause.mode.toUpperCase()}</strong>` };
    case "drop":
      return cause.reason === "loss"
        ? { color: ROLE_CSS.alternate, html: "a BPDU was lost in flight" }
        : null;
    default:
      return null;
  }
}

function narrateEvent({
  switchId,
  event,
}: NarratedStpEvent): { color: string; html: string } | null {
  const e: StpEvent = event;
  switch (e.type) {
    case "roleChanged":
      if (e.to === "root")
        return { color: ROLE_CSS.root, html: `<strong>${portText(e.portId)}</strong> → Root Port` };
      if (e.to === "alternate")
        return {
          color: ROLE_CSS.alternate,
          html: `<strong>${portText(e.portId)}</strong> blocked — Alternate (loop broken)`,
        };
      return null;
    case "agreed":
      return {
        color: ROLE_CSS.designated,
        html: `<strong>${portText(e.portId)}</strong> agreed — forwarding (rapid)`,
      };
    case "topologyChange":
      return {
        color: "#f4b73d",
        html: `<strong>${up(switchId)}</strong> topology change — flooding TC`,
      };
    case "infoExpired":
      return {
        color: ROLE_CSS.alternate,
        html: `<strong>${portText(e.portId)}</strong> info expired — reconverging`,
      };
    case "edgeLost":
      return {
        color: "#f4b73d",
        html: `<strong>${portText(e.portId)}</strong> heard a BPDU — no longer edge`,
      };
    default:
      return null;
  }
}

function up(id: string): string {
  return escapeHtml(id.toUpperCase());
}

function portText(portId: string): string {
  const { device, portNum } = parsePortId(portId);
  return `${device.toUpperCase()} P${portNum}`;
}
