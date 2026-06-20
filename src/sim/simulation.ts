/**
 * Discrete-event simulation of a switched network running spanning tree, with a
 * fully recorded timeline. The simulator owns the topology and one {@link Bridge}
 * per powered switch, carries BPDUs across links with a small tunable delay, and
 * records a complete {@link Frame} on every event so the UI can scrub to any past
 * moment losslessly (ADR-0002 — all actions happen at the live edge; there is no
 * past-time fork).
 *
 * Unlike a Raft cluster there is no quorum: a partition is simply the graph
 * splitting into connected **islands**, each of which elects its own root and
 * converges independently (§5.8).
 */

import {
  addHost as addHostToTopo,
  addLink as addLinkToTopo,
  addSwitch as addSwitchToTopo,
  cloneTopology,
  defaultCostForSpeed,
  defaultTopology,
  devicePowered,
  emptyTopology,
  farEnd,
  linksOn,
  parsePortId,
  portIdOf,
  removeDevice as removeDeviceFromTopo,
  removeLink as removeLinkFromTopo,
  switchIslands,
  type DeviceId,
  type IsoPos,
  type LinkConfig,
  type LinkId,
  type LinkSpeed,
  type PortId,
  type SwitchId,
  type Topology,
} from "../model/index.ts";
import {
  Bridge,
  compareBridgeId,
  DEFAULT_TIMING,
  type Bpdu,
  type BridgeId,
  type BridgeSnapshot,
  type ProtocolMode,
  type StepResult,
  type StpEvent,
  type Timing,
} from "../spanning-tree/index.ts";
import { mulberry32, seedFor } from "./prng.ts";

/** Live-tunable network conditions (one-way, in sim-seconds). */
export interface NetworkConditions {
  latency: number;
  jitter: number;
  /** Fraction of BPDUs dropped in transit (0..1). */
  loss: number;
}

/** A BPDU travelling along a link from one port to the port on the far end. */
export interface BpduFlight {
  readonly id: number;
  readonly bpdu: Bpdu;
  readonly fromSwitch: SwitchId;
  readonly toDevice: DeviceId;
  readonly fromPort: PortId;
  readonly toPort: PortId;
  readonly linkId: LinkId;
  readonly sentAt: number;
  readonly deliverAt: number;
  /** Doomed by loss: it travels halfway, then bursts. */
  readonly lost?: boolean;
}

export interface NarratedStpEvent {
  readonly switchId: SwitchId;
  readonly event: StpEvent;
}

/** One independent spanning-tree domain (connected component of powered switches). */
export interface IslandInfo {
  readonly members: readonly SwitchId[];
  readonly rootMac: string;
  readonly rootSwitchId: SwitchId | null;
  readonly converged: boolean;
}

export interface BridgeFrame {
  readonly switchId: SwitchId;
  readonly snapshot: BridgeSnapshot;
}

export type SimCause =
  | { readonly kind: "init" }
  | { readonly kind: "reset" }
  | { readonly kind: "resetDefault" }
  | { readonly kind: "clearCanvas" }
  | { readonly kind: "delivery"; readonly flight: BpduFlight }
  | { readonly kind: "drop"; readonly flight: BpduFlight; readonly reason: string }
  | { readonly kind: "wake"; readonly switchId: SwitchId }
  | { readonly kind: "powerOff"; readonly switchId: SwitchId }
  | { readonly kind: "powerOn"; readonly switchId: SwitchId }
  | { readonly kind: "restart"; readonly switchId: SwitchId }
  | { readonly kind: "linkCut"; readonly linkId: LinkId }
  | { readonly kind: "linkRestore"; readonly linkId: LinkId }
  | { readonly kind: "portShut"; readonly portId: PortId }
  | { readonly kind: "portNoShut"; readonly portId: PortId }
  | { readonly kind: "addSwitch"; readonly switchId: SwitchId }
  | { readonly kind: "addHost"; readonly hostId: DeviceId }
  | { readonly kind: "addLink"; readonly linkId: LinkId }
  | { readonly kind: "removeDevice"; readonly deviceId: DeviceId }
  | { readonly kind: "removeLink"; readonly linkId: LinkId }
  | { readonly kind: "setPriority"; readonly switchId: SwitchId }
  | { readonly kind: "setCost"; readonly linkId: LinkId }
  | { readonly kind: "setPortPriority"; readonly portId: PortId }
  | { readonly kind: "setEdge"; readonly portId: PortId }
  | { readonly kind: "setTiming" }
  | { readonly kind: "setMode"; readonly mode: ProtocolMode }
  | { readonly kind: "split" }
  | { readonly kind: "heal" };

/** One recorded instant: complete world state after an event. */
export interface Frame {
  readonly time: number;
  readonly cause: SimCause;
  readonly events: readonly NarratedStpEvent[];
  readonly bridges: readonly BridgeFrame[];
  readonly poweredOff: readonly SwitchId[];
  readonly cutLinks: readonly LinkId[];
  readonly shutPorts: readonly PortId[];
  readonly inFlight: readonly BpduFlight[];
  readonly islands: readonly IslandInfo[];
  readonly mode: ProtocolMode;
}

export interface SimulationOptions {
  readonly seed?: number;
  readonly mode?: ProtocolMode;
  readonly timing?: Partial<Timing>;
  readonly topology?: Topology;
  /** Base one-way latency (sim-seconds). */
  readonly latency?: number;
  readonly jitter?: number;
  readonly maxFrames?: number;
}

// Teaching defaults: link delays are a small fraction of Hello (2 s) so comets
// are visible in flight without distorting the protocol's second-scale timers.
const DEFAULTS = {
  seed: 1,
  latency: 0.06,
  jitter: 0.04,
  maxFrames: 30_000,
} as const;

interface PortRef {
  readonly linkId: LinkId;
  readonly selfDevice: DeviceId;
  readonly selfPortNum: number;
  readonly farPort: PortId;
  readonly farDevice: DeviceId;
}

export class SpanningTreeSimulation {
  readonly seed: number;
  readonly network: NetworkConditions;
  readonly topology: Topology;

  private modeValue: ProtocolMode;
  private timing: Timing;
  private readonly maxFrames: number;

  private readonly bridges = new Map<SwitchId, Bridge>();
  private readonly shutPortsSet = new Set<PortId>();
  private portIndex = new Map<PortId, PortRef>();

  private flights: BpduFlight[] = [];
  private framesInternal: Frame[] = [];

  private nowValue = 0;
  private flightSeq = 0;
  private epoch = 0;
  private rngNet: () => number;
  private splitCutLinks: LinkId[] = [];

  constructor(options: SimulationOptions = {}) {
    this.seed = options.seed ?? DEFAULTS.seed;
    this.modeValue = options.mode ?? "rstp";
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.maxFrames = options.maxFrames ?? DEFAULTS.maxFrames;
    this.network = {
      latency: options.latency ?? DEFAULTS.latency,
      jitter: options.jitter ?? DEFAULTS.jitter,
      loss: 0,
    };
    this.rngNet = mulberry32(this.seed ^ 0x9e3779b9);
    this.topology = options.topology ? cloneTopology(options.topology) : defaultTopology();

    this.reindex();
    this.buildBridges();
    this.record({ kind: "init" }, []);
  }

  // -------------------------------------------------------------------------
  // Reading the timeline
  // -------------------------------------------------------------------------

  get frames(): readonly Frame[] {
    return this.framesInternal;
  }

  get duration(): number {
    return this.nowValue;
  }

  get horizon(): number {
    return this.framesInternal[0]?.time ?? 0;
  }

  get mode(): ProtocolMode {
    return this.modeValue;
  }

  get helloTime(): number {
    return this.timing.helloTime;
  }

  get forwardDelay(): number {
    return this.timing.forwardDelay;
  }

  get maxAge(): number {
    return this.timing.maxAge;
  }

  switchIds(): SwitchId[] {
    return [...this.topology.switches.keys()];
  }

  /** The link a port belongs to, or null. */
  linkOfPort(portId: PortId): LinkId | null {
    return this.portIndex.get(portId)?.linkId ?? null;
  }

  /** Reposition a device on the iso grid. Pure layout — records no frame. */
  moveDevice(deviceId: DeviceId, pos: IsoPos): void {
    const device = this.topology.switches.get(deviceId) ?? this.topology.hosts.get(deviceId);
    if (device) device.pos = { ...pos };
  }

  frameAt(t: number): Frame {
    const frames = this.framesInternal;
    const first = frames[0];
    if (!first) throw new Error("timeline is empty");
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const frame = frames[mid];
      if (frame && frame.time <= t) lo = mid;
      else hi = mid - 1;
    }
    return frames[lo] ?? first;
  }

  // -------------------------------------------------------------------------
  // Advancing time
  // -------------------------------------------------------------------------

  advanceTo(t: number): void {
    if (t <= this.nowValue) return;
    for (;;) {
      let nextFlight: BpduFlight | null = null;
      for (const f of this.flights) {
        if (!nextFlight || f.deliverAt < nextFlight.deliverAt) nextFlight = f;
      }
      let nextWake: { at: number; id: SwitchId } | null = null;
      for (const [id, bridge] of this.bridges) {
        const at = bridge.nextWakeAt();
        if (at !== null && Number.isFinite(at) && (!nextWake || at < nextWake.at)) {
          nextWake = { at, id };
        }
      }
      const flightAt = nextFlight?.deliverAt ?? Number.POSITIVE_INFINITY;
      const wakeAt = nextWake?.at ?? Number.POSITIVE_INFINITY;
      const eventAt = Math.min(flightAt, wakeAt);
      if (eventAt > t || !Number.isFinite(eventAt)) break;

      this.nowValue = eventAt;
      if (flightAt <= wakeAt && nextFlight) {
        this.deliver(nextFlight);
      } else if (nextWake) {
        const bridge = this.bridges.get(nextWake.id);
        if (bridge) {
          const events = this.absorb(nextWake.id, bridge.tick(this.nowValue));
          this.record({ kind: "wake", switchId: nextWake.id }, events);
        }
      }
    }
    this.nowValue = t;
  }

  // -------------------------------------------------------------------------
  // Interventions (all at the live edge)
  // -------------------------------------------------------------------------

  powerOff(switchId: SwitchId): boolean {
    const sw = this.topology.switches.get(switchId);
    if (!sw || !sw.powered) return false;
    sw.powered = false;
    this.bridges.delete(switchId);
    const events: NarratedStpEvent[] = [];
    this.refreshNeighbors(switchId, events);
    this.record({ kind: "powerOff", switchId }, events);
    return true;
  }

  powerOn(switchId: SwitchId): boolean {
    const sw = this.topology.switches.get(switchId);
    if (!sw || sw.powered) return false;
    sw.powered = true;
    this.bridges.set(switchId, this.makeBridge(switchId));
    const events: NarratedStpEvent[] = [];
    this.refreshNeighbors(switchId, events);
    this.record({ kind: "powerOn", switchId }, events);
    return true;
  }

  /** Power-cycle: rebuild the bridge cold so it briefly believes it is root. */
  restart(switchId: SwitchId): boolean {
    const sw = this.topology.switches.get(switchId);
    if (!sw) return false;
    sw.powered = true;
    this.bridges.set(switchId, this.makeBridge(switchId));
    const events: NarratedStpEvent[] = [];
    this.refreshNeighbors(switchId, events);
    this.record({ kind: "restart", switchId }, events);
    return true;
  }

  cutLink(linkId: LinkId): boolean {
    const link = this.topology.links.get(linkId);
    if (!link || link.cut) return false;
    link.cut = true;
    const events: NarratedStpEvent[] = [];
    this.refreshPort(portIdOf(link.a), events);
    this.refreshPort(portIdOf(link.b), events);
    this.record({ kind: "linkCut", linkId }, events);
    return true;
  }

  restoreLink(linkId: LinkId): boolean {
    const link = this.topology.links.get(linkId);
    if (!link || !link.cut) return false;
    link.cut = false;
    const events: NarratedStpEvent[] = [];
    this.refreshPort(portIdOf(link.a), events);
    this.refreshPort(portIdOf(link.b), events);
    this.record({ kind: "linkRestore", linkId }, events);
    return true;
  }

  shutPort(portId: PortId): boolean {
    if (this.shutPortsSet.has(portId)) return false;
    this.shutPortsSet.add(portId);
    this.recordPortToggle(portId, { kind: "portShut", portId });
    return true;
  }

  noShutPort(portId: PortId): boolean {
    if (!this.shutPortsSet.has(portId)) return false;
    this.shutPortsSet.delete(portId);
    this.recordPortToggle(portId, { kind: "portNoShut", portId });
    return true;
  }

  private recordPortToggle(portId: PortId, cause: SimCause): void {
    const events: NarratedStpEvent[] = [];
    this.refreshPort(portId, events);
    const ref = this.portIndex.get(portId);
    if (ref) this.refreshPort(ref.farPort, events);
    this.record(cause, events);
  }

  // ---- editor: permanent structural ops ----

  addSwitch(pos: IsoPos): SwitchId {
    const sw = addSwitchToTopo(this.topology, pos);
    this.bridges.set(sw.id, this.makeBridge(sw.id));
    this.reindex();
    this.record({ kind: "addSwitch", switchId: sw.id }, []);
    return sw.id;
  }

  addHost(pos: IsoPos): DeviceId {
    const host = addHostToTopo(this.topology, pos);
    this.record({ kind: "addHost", hostId: host.id }, []);
    return host.id;
  }

  addLink(a: DeviceId, b: DeviceId, speed?: LinkSpeed): LinkId | null {
    const link = addLinkToTopo(this.topology, a, b, speed ? { speed } : {});
    if (!link) return null;
    this.reindex();
    const events: NarratedStpEvent[] = [];
    this.addLinkEndToBridge(link, link.a);
    this.addLinkEndToBridge(link, link.b);
    // An edge attaching a host may flip a neighbour's port to edge; reconverge.
    this.refreshPort(portIdOf(link.a), events);
    this.refreshPort(portIdOf(link.b), events);
    this.record({ kind: "addLink", linkId: link.id }, events);
    return link.id;
  }

  removeLink(linkId: LinkId): boolean {
    const link = this.topology.links.get(linkId);
    if (!link) return false;
    const events: NarratedStpEvent[] = [];
    this.removeLinkEndFromBridge(link.a);
    this.removeLinkEndFromBridge(link.b);
    removeLinkFromTopo(this.topology, linkId);
    this.shutPortsSet.delete(portIdOf(link.a));
    this.shutPortsSet.delete(portIdOf(link.b));
    this.reindex();
    this.reconvergeAll(events);
    this.record({ kind: "removeLink", linkId }, events);
    return true;
  }

  removeDevice(deviceId: DeviceId): boolean {
    if (!this.topology.switches.has(deviceId) && !this.topology.hosts.has(deviceId)) return false;
    const events: NarratedStpEvent[] = [];
    // Detach every link first so neighbours lose their ports.
    for (const link of linksOn(this.topology, deviceId)) {
      this.removeLinkEndFromBridge(link.a);
      this.removeLinkEndFromBridge(link.b);
      this.shutPortsSet.delete(portIdOf(link.a));
      this.shutPortsSet.delete(portIdOf(link.b));
    }
    this.bridges.delete(deviceId);
    removeDeviceFromTopo(this.topology, deviceId);
    this.reindex();
    this.reconvergeAll(events);
    this.record({ kind: "removeDevice", deviceId }, events);
    return true;
  }

  // ---- editor: live retuning ----

  setBridgePriority(switchId: SwitchId, priority: number): boolean {
    const sw = this.topology.switches.get(switchId);
    if (!sw) return false;
    sw.priority = priority;
    const events: NarratedStpEvent[] = [];
    const bridge = this.bridges.get(switchId);
    if (bridge)
      events.push(...this.absorb(switchId, bridge.setBridgePriority(priority, this.nowValue)));
    this.record({ kind: "setPriority", switchId }, events);
    return true;
  }

  setLinkSpeed(linkId: LinkId, speed: LinkSpeed): boolean {
    const link = this.topology.links.get(linkId);
    if (!link) return false;
    link.speed = speed;
    return this.applyLinkCosts(linkId, { kind: "setCost", linkId });
  }

  setPortCostOverride(linkId: LinkId, end: "a" | "b", cost: number | null): boolean {
    const link = this.topology.links.get(linkId);
    if (!link) return false;
    if (end === "a") link.costA = cost;
    else link.costB = cost;
    return this.applyLinkCosts(linkId, { kind: "setCost", linkId });
  }

  private applyLinkCosts(linkId: LinkId, cause: SimCause): boolean {
    const link = this.topology.links.get(linkId);
    if (!link) return false;
    const events: NarratedStpEvent[] = [];
    this.applyEndCost(link, link.a, events);
    this.applyEndCost(link, link.b, events);
    this.record(cause, events);
    return true;
  }

  private applyEndCost(link: LinkConfig, end: LinkConfig["a"], events: NarratedStpEvent[]): void {
    const bridge = this.bridges.get(end.device);
    if (!bridge) return;
    const isA = end === link.a;
    const cost = (isA ? link.costA : link.costB) ?? defaultCostForSpeed(link.speed);
    events.push(...this.absorb(end.device, bridge.setPortCost(portIdOf(end), cost, this.nowValue)));
  }

  setPortPriority(portId: PortId, priority: number): boolean {
    const ref = this.portIndex.get(portId);
    if (!ref) return false;
    const link = this.topology.links.get(ref.linkId);
    if (!link) return false;
    if (portIdOf(link.a) === portId) link.portPriorityA = priority;
    else link.portPriorityB = priority;
    const events: NarratedStpEvent[] = [];
    const bridge = this.bridges.get(ref.selfDevice);
    if (bridge)
      events.push(
        ...this.absorb(ref.selfDevice, bridge.setPortPriority(portId, priority, this.nowValue)),
      );
    this.record({ kind: "setPortPriority", portId }, events);
    return true;
  }

  setPortEdge(portId: PortId, edge: boolean): boolean {
    const ref = this.portIndex.get(portId);
    if (!ref) return false;
    const bridge = this.bridges.get(ref.selfDevice);
    if (!bridge) return false;
    const events = this.absorb(ref.selfDevice, bridge.setPortEdge(portId, edge, this.nowValue));
    this.record({ kind: "setEdge", portId }, events);
    return true;
  }

  setTiming(timing: Partial<Timing>): void {
    this.timing = { ...this.timing, ...timing };
    const events: NarratedStpEvent[] = [];
    for (const [id, bridge] of this.bridges) {
      events.push(...this.absorb(id, bridge.setTiming(timing, this.nowValue)));
    }
    this.record({ kind: "setTiming" }, events);
  }

  setMode(mode: ProtocolMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    const events: NarratedStpEvent[] = [];
    for (const [id, bridge] of this.bridges) {
      events.push(...this.absorb(id, bridge.setMode(mode, this.nowValue)));
    }
    this.record({ kind: "setMode", mode }, events);
  }

  // ---- partitions (§5.8) ----

  get activeSplit(): readonly LinkId[] {
    return this.splitCutLinks;
  }

  /** Auto-cut a clean partition that splits the largest island into two. */
  splitNetwork(): boolean {
    const islands = switchIslands(this.topology);
    let biggest: SwitchId[] = [];
    for (const island of islands) if (island.length > biggest.length) biggest = [...island];
    if (biggest.length < 2) return false;

    const half = Math.floor(biggest.length / 2);
    const groupA = new Set(biggest.slice(0, half));
    const crossing: LinkId[] = [];
    for (const link of this.topology.links.values()) {
      if (link.cut) continue;
      const aIn = groupA.has(link.a.device);
      const bIn = groupA.has(link.b.device);
      if (aIn !== bIn && (groupA.has(link.a.device) || groupA.has(link.b.device))) {
        // Only count links wholly between the two switch groups.
        const otherIn =
          (this.topology.switches.has(link.a.device) ? biggest.includes(link.a.device) : false) &&
          (this.topology.switches.has(link.b.device) ? biggest.includes(link.b.device) : false);
        if (otherIn) crossing.push(link.id);
      }
    }
    if (crossing.length === 0) return false;

    this.splitCutLinks = crossing;
    const events: NarratedStpEvent[] = [];
    for (const linkId of crossing) {
      const link = this.topology.links.get(linkId);
      if (!link) continue;
      link.cut = true;
      this.refreshPort(portIdOf(link.a), events);
      this.refreshPort(portIdOf(link.b), events);
    }
    this.record({ kind: "split" }, events);
    return true;
  }

  healNetwork(): boolean {
    if (this.splitCutLinks.length === 0) return false;
    const events: NarratedStpEvent[] = [];
    for (const linkId of this.splitCutLinks) {
      const link = this.topology.links.get(linkId);
      if (!link || !link.cut) continue;
      link.cut = false;
      this.refreshPort(portIdOf(link.a), events);
      this.refreshPort(portIdOf(link.b), events);
    }
    this.splitCutLinks = [];
    this.record({ kind: "heal" }, events);
    return true;
  }

  // ---- resets (§5.7) ----

  /** Re-converge soft: keep topology + settings, power-cycle everyone cold. */
  reset(): void {
    this.blankTimeline();
    this.buildBridges();
    this.record({ kind: "reset" }, []);
  }

  resetToDefault(): void {
    this.replaceTopology(defaultTopology());
    this.record({ kind: "resetDefault" }, []);
  }

  clearCanvas(): void {
    this.replaceTopology(emptyTopology());
    this.record({ kind: "clearCanvas" }, []);
  }

  resetNetwork(): void {
    this.network.latency = DEFAULTS.latency;
    this.network.jitter = DEFAULTS.jitter;
    this.network.loss = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private replaceTopology(next: Topology): void {
    this.blankTimeline();
    this.topology.switches.clear();
    this.topology.hosts.clear();
    this.topology.links.clear();
    for (const [id, s] of next.switches) this.topology.switches.set(id, s);
    for (const [id, h] of next.hosts) this.topology.hosts.set(id, h);
    for (const [id, l] of next.links) this.topology.links.set(id, l);
    this.reindex();
    this.buildBridges();
  }

  private blankTimeline(): void {
    this.epoch += 1;
    this.nowValue = 0;
    this.flights = [];
    this.framesInternal = [];
    this.shutPortsSet.clear();
    this.splitCutLinks = [];
    this.rngNet = mulberry32((this.seed ^ 0x9e3779b9) + this.epoch * 0x85eb);
    this.bridges.clear();
  }

  private reindex(): void {
    this.portIndex = new Map();
    for (const link of this.topology.links.values()) {
      this.portIndex.set(portIdOf(link.a), {
        linkId: link.id,
        selfDevice: link.a.device,
        selfPortNum: link.a.portNum,
        farPort: portIdOf(link.b),
        farDevice: link.b.device,
      });
      this.portIndex.set(portIdOf(link.b), {
        linkId: link.id,
        selfDevice: link.b.device,
        selfPortNum: link.b.portNum,
        farPort: portIdOf(link.a),
        farDevice: link.a.device,
      });
    }
  }

  private buildBridges(): void {
    this.bridges.clear();
    for (const sw of this.topology.switches.values()) {
      if (sw.powered) this.bridges.set(sw.id, this.makeBridge(sw.id));
    }
  }

  private makeBridge(switchId: SwitchId): Bridge {
    const sw = this.topology.switches.get(switchId);
    const id: BridgeId = sw ? { priority: sw.priority, mac: sw.mac } : { priority: 0, mac: "" };
    const bridge = new Bridge({
      id,
      mode: this.modeValue,
      now: this.nowValue,
      timing: this.timing,
      rng: seedFor(this.seed, switchId),
    });
    for (const link of linksOn(this.topology, switchId)) {
      if (link.a.device === switchId) this.addBridgePort(bridge, link, link.a);
      if (link.b.device === switchId) this.addBridgePort(bridge, link, link.b);
    }
    return bridge;
  }

  private addBridgePort(bridge: Bridge, link: LinkConfig, end: LinkConfig["a"]): void {
    const isA = end === link.a;
    const far = isA ? link.b : link.a;
    const portId = portIdOf(end);
    const cost = (isA ? link.costA : link.costB) ?? defaultCostForSpeed(link.speed);
    bridge.addPort(portId, {
      num: end.portNum,
      cost,
      priority: isA ? link.portPriorityA : link.portPriorityB,
      edge: this.topology.hosts.has(far.device),
      enabled: this.computeEnabled(portId),
    });
  }

  private addLinkEndToBridge(link: LinkConfig, end: LinkConfig["a"]): void {
    const bridge = this.bridges.get(end.device);
    if (bridge) this.addBridgePort(bridge, link, end);
  }

  private removeLinkEndFromBridge(end: LinkConfig["a"]): void {
    this.bridges.get(end.device)?.removePort(portIdOf(end));
  }

  /** Whether a port's link can carry BPDUs right now. */
  private computeEnabled(portId: PortId): boolean {
    const ref = this.portIndex.get(portId);
    if (!ref) return false;
    const link = this.topology.links.get(ref.linkId);
    if (!link || link.cut) return false;
    if (this.shutPortsSet.has(portId) || this.shutPortsSet.has(ref.farPort)) return false;
    return (
      devicePowered(this.topology, ref.selfDevice) && devicePowered(this.topology, ref.farDevice)
    );
  }

  private refreshPort(portId: PortId, events: NarratedStpEvent[]): void {
    const { device } = parsePortId(portId);
    const bridge = this.bridges.get(device);
    if (!bridge || !bridge.hasPort(portId)) return;
    events.push(
      ...this.absorb(
        device,
        bridge.setPortEnabled(portId, this.computeEnabled(portId), this.nowValue),
      ),
    );
  }

  private refreshNeighbors(switchId: SwitchId, events: NarratedStpEvent[]): void {
    for (const link of linksOn(this.topology, switchId)) {
      const far = farEnd(link, switchId);
      if (far && this.topology.switches.has(far.device)) this.refreshPort(portIdOf(far), events);
    }
  }

  private reconvergeAll(events: NarratedStpEvent[]): void {
    for (const [id, bridge] of this.bridges) {
      events.push(...this.absorb(id, bridge.tick(this.nowValue)));
    }
  }

  private deliver(flight: BpduFlight): void {
    this.flights = this.flights.filter((f) => f.id !== flight.id);
    if (flight.lost) {
      this.record({ kind: "drop", flight, reason: "loss" }, []);
      return;
    }
    const link = this.topology.links.get(flight.linkId);
    if (!link || link.cut) {
      this.record({ kind: "drop", flight, reason: "link down" }, []);
      return;
    }
    const target = this.topology.switches.get(flight.toDevice);
    if (!target || !target.powered) {
      this.record({ kind: "drop", flight, reason: "switch off" }, []);
      return;
    }
    const bridge = this.bridges.get(flight.toDevice);
    if (!bridge || !bridge.hasPort(flight.toPort)) {
      this.record({ kind: "drop", flight, reason: "no port" }, []);
      return;
    }
    const events = this.absorb(
      flight.toDevice,
      bridge.receive(flight.bpdu, flight.toPort, this.nowValue),
    );
    this.record({ kind: "delivery", flight }, events);
  }

  /** Queue outgoing BPDUs as flights and narrate the step's events. */
  private absorb(switchId: SwitchId, step: StepResult): NarratedStpEvent[] {
    for (const { portId, bpdu } of step.bpdus) this.launch(switchId, portId, bpdu);
    return step.events.map((event) => ({ switchId, event }));
  }

  private launch(fromSwitch: SwitchId, fromPort: PortId, bpdu: Bpdu): void {
    const ref = this.portIndex.get(fromPort);
    if (!ref) return;
    const oneWay = this.sampleLatency();
    const lost = this.rngNet() < this.network.loss;
    this.flights.push({
      id: this.flightSeq++,
      bpdu,
      fromSwitch,
      toDevice: ref.farDevice,
      fromPort,
      toPort: ref.farPort,
      linkId: ref.linkId,
      sentAt: this.nowValue,
      deliverAt: this.nowValue + (lost ? oneWay * 0.5 : oneWay),
      lost,
    });
  }

  private sampleLatency(): number {
    const { latency, jitter } = this.network;
    const base = latency + this.rngNet() * Math.max(jitter, 0.0001);
    const straggle = this.rngNet();
    const factor = this.rngNet();
    return straggle < 0.08 ? base * (1.6 + factor * 0.6) : base;
  }

  private record(cause: SimCause, events: readonly NarratedStpEvent[]): void {
    const bridges: BridgeFrame[] = [];
    for (const [switchId, bridge] of this.bridges) {
      bridges.push({ switchId, snapshot: bridge.snapshot() });
    }
    const poweredOff: SwitchId[] = [];
    for (const sw of this.topology.switches.values()) if (!sw.powered) poweredOff.push(sw.id);
    const cutLinks: LinkId[] = [];
    for (const link of this.topology.links.values()) if (link.cut) cutLinks.push(link.id);

    this.framesInternal.push({
      time: this.nowValue,
      cause,
      events,
      bridges,
      poweredOff,
      cutLinks,
      shutPorts: [...this.shutPortsSet],
      inFlight: [...this.flights],
      islands: this.computeIslands(),
      mode: this.modeValue,
    });
    if (this.framesInternal.length > this.maxFrames) {
      this.framesInternal.splice(0, this.framesInternal.length - this.maxFrames);
    }
  }

  private computeIslands(): IslandInfo[] {
    const islands = switchIslands(this.topology);
    return islands.map((members) => {
      let rootSwitchId: SwitchId | null = null;
      let bestId: BridgeId | null = null;
      for (const id of members) {
        const sw = this.topology.switches.get(id);
        if (!sw) continue;
        const bid: BridgeId = { priority: sw.priority, mac: sw.mac };
        if (!bestId || compareBridgeId(bid, bestId) < 0) {
          bestId = bid;
          rootSwitchId = id;
        }
      }
      const rootMac = bestId?.mac ?? "";
      let converged = members.length > 0;
      for (const id of members) {
        const bridge = this.bridges.get(id);
        if (!bridge) {
          converged = false;
          break;
        }
        const snap = bridge.snapshot();
        if (snap.rootId.mac !== rootMac) {
          converged = false;
          break;
        }
        if (
          snap.ports.some((p) => p.state === "listening" || p.state === "learning" || p.proposing)
        ) {
          converged = false;
          break;
        }
      }
      return { members, rootMac, rootSwitchId, converged };
    });
  }
}
