/**
 * Playback controller: owns the playhead, speed, pause, and selection, and is
 * the boundary between *replaying recorded history* and *simulating live*.
 *
 * Per ADR-0002 there is no past-time fork: scrubbing back is pure replay, and
 * any action taken while scrubbed-back first snaps the playhead to the live
 * edge, then applies to "now".
 */

import {
  cycleLinks,
  isSwitch,
  parsePortId,
  portIdOf,
  shortMac,
  type DeviceId,
  type IsoPos,
  type LinkId,
  type PortId,
} from "./model/index.ts";
import { Chaos, SpanningTreeSimulation } from "./sim/index.ts";
import type { BpduFlight, Frame } from "./sim/index.ts";
import type {
  Bpdu,
  BridgeSnapshot,
  PortSnapshot,
  ProtocolMode,
  Timing,
} from "./spanning-tree/index.ts";
import type { BpduKind } from "./theme.ts";
import type {
  BpduFlightView,
  FxSpawn,
  HostView,
  LinkEndView,
  LinkView,
  RenderView,
  SwitchView,
} from "./viz/index.ts";

export const MIN_SPEED = 0.02;
export const MAX_SPEED = 8;
export const DEFAULT_SPEED = 0.2;
const LIVE_EPSILON = 0.0005;

export type Selection =
  | { readonly kind: "device"; readonly id: DeviceId }
  | { readonly kind: "link"; readonly id: LinkId }
  | { readonly kind: "port"; readonly id: PortId }
  | null;

export class App {
  readonly sim: SpanningTreeSimulation;
  readonly chaos: Chaos;

  playhead = 0;
  speed = DEFAULT_SPEED;
  paused = false;
  selection: Selection = null;
  selectedFlight: number | null = null;
  linkDrawMode = false;
  hoveredLink: LinkId | null = null;

  onToast: (message: string) => void = () => {};

  private pausedByInspect = false;
  private lastFxTime = 0;
  private pendingFx: FxSpawn[] = [];
  private fxEpoch = 0;
  private addCounter = 0;
  /** Resolves a device id to its world spawn position for topbar "add". */
  spawnPos: (index: number) => IsoPos = (i) => ({
    x: (i % 4) * 3 - 4,
    y: Math.floor(i / 4) * 3 - 2,
  });

  constructor(seed: number, mode: ProtocolMode = "rstp") {
    this.sim = new SpanningTreeSimulation({ seed, mode });
    this.chaos = new Chaos(this.sim, { seed: seed ^ 0x5f5f });
  }

  get live(): boolean {
    return this.playhead >= this.sim.duration - LIVE_EPSILON;
  }

  get mode(): ProtocolMode {
    return this.sim.mode;
  }

  /** Advance wall time by `dt` seconds. */
  tick(dt: number): void {
    if (this.paused) return;
    this.playhead += dt * this.speed;
    if (this.playhead > this.sim.duration) {
      this.sim.advanceTo(this.playhead);
      this.chaos.step(this.sim.duration);
    }
    this.collectFx();
  }

  frame(): Frame {
    return this.sim.frameAt(this.playhead);
  }

  // --------------------------------------------------------------- playback

  togglePause(): void {
    this.paused = !this.paused;
  }

  setSpeed(speed: number): void {
    this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  }

  scrub(t: number): void {
    const clamped = Math.min(Math.max(t, this.sim.horizon), this.sim.duration);
    if (clamped < this.playhead) {
      this.lastFxTime = clamped;
      this.pendingFx = [];
      this.fxEpoch += 1;
    }
    this.playhead = clamped;
  }

  goLive(): void {
    this.playhead = this.sim.duration;
    this.lastFxTime = this.playhead;
  }

  // -------------------------------------------------------------- selection

  selectDevice(id: DeviceId | null): void {
    this.selection = id ? { kind: "device", id } : null;
  }

  selectLink(id: LinkId | null): void {
    this.selection = id ? { kind: "link", id } : null;
  }

  selectPort(id: PortId): void {
    this.selection = { kind: "port", id };
  }

  clearSelection(): void {
    this.selection = null;
  }

  inspectFlight(id: number): void {
    this.selectedFlight = id;
    if (!this.paused) {
      this.pausedByInspect = true;
      this.paused = true;
    }
  }

  closeFlight(): void {
    this.selectedFlight = null;
    if (this.pausedByInspect) {
      this.paused = false;
      this.pausedByInspect = false;
    }
  }

  findFlight(id: number): BpduFlight | undefined {
    return this.frame().inFlight.find((f) => f.id === id);
  }

  setLinkDrawMode(on: boolean): void {
    this.linkDrawMode = on;
  }

  // ----------------------------------------------------------- interventions

  powerOff(id: DeviceId): void {
    this.ensureLive();
    if (this.sim.powerOff(id)) this.onToast(`${id.toUpperCase()} powered off`);
  }

  powerOn(id: DeviceId): void {
    this.ensureLive();
    if (this.sim.powerOn(id)) this.onToast(`${id.toUpperCase()} powered on`);
  }

  restart(id: DeviceId): void {
    this.ensureLive();
    if (this.sim.restart(id)) this.onToast(`${id.toUpperCase()} restarted — cold`);
  }

  cutLink(id: LinkId): void {
    this.ensureLive();
    if (this.sim.cutLink(id)) this.onToast(`link ${id} cut`);
  }

  restoreLink(id: LinkId): void {
    this.ensureLive();
    if (this.sim.restoreLink(id)) this.onToast(`link ${id} restored`);
  }

  shutPort(id: PortId): void {
    this.ensureLive();
    if (this.sim.shutPort(id)) this.onToast(`${id} shut`);
  }

  noShutPort(id: PortId): void {
    this.ensureLive();
    if (this.sim.noShutPort(id)) this.onToast(`${id} no-shut`);
  }

  removeDevice(id: DeviceId): void {
    this.ensureLive();
    if (this.sim.removeDevice(id)) {
      if (this.selection && this.selection.id.startsWith(id)) this.clearSelection();
      this.onToast(`${id.toUpperCase()} removed`);
    }
  }

  removeLink(id: LinkId): void {
    this.ensureLive();
    if (this.sim.removeLink(id)) {
      if (this.selection?.kind === "link" && this.selection.id === id) this.clearSelection();
      this.onToast(`link ${id} removed`);
    }
  }

  addSwitch(): DeviceId {
    this.ensureLive();
    const id = this.sim.addSwitch(this.spawnPos(this.addCounter++));
    this.selectDevice(id);
    this.onToast(`${id.toUpperCase()} added — drag to place, draw links`);
    return id;
  }

  addHost(): DeviceId {
    this.ensureLive();
    const id = this.sim.addHost(this.spawnPos(this.addCounter++));
    this.selectDevice(id);
    this.onToast(`${id.toUpperCase()} added`);
    return id;
  }

  drawLink(a: DeviceId, b: DeviceId): void {
    this.ensureLive();
    const id = this.sim.addLink(a, b);
    if (id) this.onToast(`linked ${a.toUpperCase()} ↔ ${b.toUpperCase()}`);
    else this.onToast("can't link those");
  }

  moveDevice(id: DeviceId, pos: IsoPos): void {
    this.sim.moveDevice(id, pos);
  }

  setBridgePriority(id: DeviceId, priority: number): void {
    this.ensureLive();
    this.sim.setBridgePriority(id, priority);
  }

  setPortPriority(portId: PortId, priority: number): void {
    this.ensureLive();
    this.sim.setPortPriority(portId, priority);
  }

  setLinkSpeed(linkId: LinkId, speed: 10 | 100 | 1000 | 10000): void {
    this.ensureLive();
    this.sim.setLinkSpeed(linkId, speed);
  }

  setMode(mode: ProtocolMode): void {
    this.ensureLive();
    this.sim.setMode(mode);
    this.onToast(mode === "rstp" ? "RSTP — sub-second via handshake" : "STP — ~30–50 s via timers");
  }

  setTiming(timing: Partial<Timing>): void {
    this.ensureLive();
    this.sim.setTiming(timing);
  }

  split(): void {
    this.ensureLive();
    if (this.sim.splitNetwork()) this.onToast("network split — two islands, two roots");
    else this.onToast("nothing to split");
  }

  heal(): void {
    this.ensureLive();
    if (this.sim.healNetwork()) this.onToast("partition healed — merging to one root");
  }

  reset(): void {
    this.sim.reset();
    this.sim.resetNetwork();
    this.afterReset();
    this.onToast("re-converged — cold start");
  }

  resetToDefault(): void {
    this.sim.resetToDefault();
    this.afterReset();
    this.onToast("reset to the default network");
  }

  clearCanvas(): void {
    this.sim.clearCanvas();
    this.afterReset();
    this.onToast("canvas cleared — build from scratch");
  }

  // -------------------------------------------------------------- internals

  private afterReset(): void {
    this.chaos.disarmRestores();
    this.playhead = 0;
    this.lastFxTime = 0;
    this.pendingFx = [];
    this.fxEpoch += 1;
    this.selection = null;
  }

  /** Interventions act on the present. Acting while scrubbed-back snaps to live. */
  private ensureLive(): void {
    if (this.live) return;
    this.playhead = this.sim.duration;
    this.lastFxTime = this.playhead;
    this.pendingFx = [];
    this.fxEpoch += 1;
  }

  // ----------------------------------------------------------- render view

  renderView(): RenderView {
    const frame = this.frame();
    const t = this.playhead;
    const topo = this.sim.topology;

    const snapById = new Map<string, BridgeSnapshot>();
    for (const b of frame.bridges) snapById.set(b.switchId, b.snapshot);
    const poweredOff = new Set(frame.poweredOff);
    const cut = new Set(frame.cutLinks);
    const shut = new Set(frame.shutPorts);
    const cycles = cycleLinks(topo);

    const switches: SwitchView[] = [];
    for (const sw of topo.switches.values()) {
      const snap = snapById.get(sw.id);
      switches.push({
        id: sw.id,
        pos: sw.pos,
        powered: !poweredOff.has(sw.id),
        isRoot: snap?.isRoot ?? false,
        label: sw.label,
        sub: `${sw.priority} · ${shortMac(sw.mac)}`,
        selected: this.isSelected(sw.id),
      });
    }

    const hosts: HostView[] = [];
    for (const host of topo.hosts.values()) {
      hosts.push({
        id: host.id,
        pos: host.pos,
        label: host.label,
        selected: this.isSelected(host.id),
      });
    }

    const portOf = (deviceId: string, portId: PortId): PortSnapshot | undefined =>
      snapById.get(deviceId)?.ports.find((p) => p.id === portId);

    const links: LinkView[] = [];
    for (const link of topo.links.values()) {
      const portA = portOf(link.a.device, portIdOf(link.a));
      const portB = portOf(link.b.device, portIdOf(link.b));
      const down =
        cut.has(link.id) ||
        poweredOff.has(link.a.device) ||
        poweredOff.has(link.b.device) ||
        shut.has(portIdOf(link.a)) ||
        shut.has(portIdOf(link.b));
      links.push({
        id: link.id,
        a: this.endView(link.a.device, portIdOf(link.a), link.a.portNum, portA, portB),
        b: this.endView(link.b.device, portIdOf(link.b), link.b.portNum, portB, portA),
        cut: down,
        onCycle: cycles.has(link.id),
        selected: this.selection?.kind === "link" && this.selection.id === link.id,
      });
    }

    const flights: BpduFlightView[] = [];
    for (const f of frame.inFlight) {
      if (!(f.sentAt <= t && t < f.deliverAt)) continue;
      const raw = (t - f.sentAt) / (f.deliverAt - f.sentAt);
      flights.push({
        id: f.id,
        kind: bpduKind(f.bpdu),
        fromDevice: f.fromSwitch,
        toDevice: f.toDevice,
        linkId: f.linkId,
        progress: raw * (f.lost ? 0.5 : 1),
        dying: f.lost === true,
        bpdu: f.bpdu,
      });
    }

    const fx = this.pendingFx;
    this.pendingFx = [];
    return {
      switches,
      hosts,
      links,
      flights,
      fx,
      fxEpoch: this.fxEpoch,
      islandCount: frame.islands.length,
      selectedFlight: this.selectedFlight,
    };
  }

  private isSelected(deviceId: string): boolean {
    if (!this.selection) return false;
    if (this.selection.kind === "device") return this.selection.id === deviceId;
    if (this.selection.kind === "port") return parsePortId(this.selection.id).device === deviceId;
    return false;
  }

  private endView(
    deviceId: string,
    portId: PortId,
    num: number,
    port: PortSnapshot | undefined,
    other: PortSnapshot | undefined,
  ): LinkEndView {
    if (port) {
      return {
        portId,
        deviceId,
        num,
        role: port.role,
        state: port.state,
        edge: port.edge,
        ...this.timerOf(port),
      };
    }
    // A host end mirrors the switch end's state so the cable colours match;
    // it carries no role badge and never blocks.
    return {
      portId,
      deviceId,
      num,
      role: "disabled",
      state: other?.state ?? "forwarding",
      edge: true,
      timerFraction: null,
      timerKind: null,
    };
  }

  private timerOf(port: PortSnapshot): {
    timerFraction: number | null;
    timerKind: "fd" | "age" | null;
  } {
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    if (port.forwardTimer !== null) {
      const total = this.mode === "stp" ? this.sim.forwardDelay : 2 * this.sim.forwardDelay;
      return { timerFraction: clamp(port.forwardTimer / total), timerKind: "fd" };
    }
    if (port.ageTimer !== null) {
      const total = this.mode === "rstp" ? 3 * this.sim.helloTime : this.sim.maxAge;
      const frac = port.ageTimer / total;
      // Only show the aging ring once it's running low — i.e. the info is
      // *not* being refreshed (a neighbour died), which is the moment that matters.
      if (frac < 0.6) return { timerFraction: clamp(frac), timerKind: "age" };
    }
    return { timerFraction: null, timerKind: null };
  }

  /** Turn frames crossed since the last call into one-shot effects. */
  private collectFx(): void {
    if (this.playhead <= this.lastFxTime) return;
    const frames = this.sim.frames;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (!frame || frame.time <= this.lastFxTime) break;
      if (frame.time > this.playhead) continue;

      if (frame.cause.kind === "drop" && frame.cause.reason === "loss") {
        const f = frame.cause.flight;
        this.pendingFx.push({
          kind: "burst",
          fromDevice: f.fromSwitch,
          toDevice: f.toDevice,
          progress: 0.5,
        });
      }
      for (const { switchId, event } of frame.events) {
        switch (event.type) {
          case "becameRoot":
            this.pendingFx.push({ kind: "rootElected", deviceId: switchId });
            break;
          case "topologyChange":
            this.pendingFx.push({ kind: "tcWave", deviceId: switchId });
            break;
          case "roleChanged":
            if (event.to === "alternate") {
              this.pendingFx.push({ kind: "block", deviceId: switchId, portId: event.portId });
            }
            break;
          case "stateChanged":
            if (event.to === "forwarding") {
              const linkId = this.sim.linkOfPort(event.portId);
              if (linkId) this.pendingFx.push({ kind: "forwarding", linkId });
            }
            break;
          default:
            break;
        }
      }
    }
    this.lastFxTime = this.playhead;
  }
}

function bpduKind(bpdu: Bpdu): BpduKind {
  if (bpdu.flags.proposal) return "proposal";
  if (bpdu.flags.agreement) return "agreement";
  if (bpdu.flags.topologyChange) return "tc";
  return "hello";
}

/** Whether a port id belongs to a switch (helps callers avoid host ports). */
export function portIsOnSwitch(sim: SpanningTreeSimulation, portId: PortId): boolean {
  return isSwitch(sim.topology, parsePortId(portId).device);
}
