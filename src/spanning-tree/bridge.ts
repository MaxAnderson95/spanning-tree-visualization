/**
 * A single bridge, dual-mode (STP/RSTP), implemented as a deterministic,
 * port-local state machine. It knows only its own ports and the last BPDU heard
 * on each; the global topology lives in the simulator. The host drives it:
 *
 *   - `tick(now)`         advance time: fire Hellos, expire timers, transition.
 *   - `receive(bpdu, p)`  a BPDU arrived on a port.
 *   - `setPortEnabled`    a link came up / went down.
 *   - `nextWakeAt()`      the earliest time the host must call `tick`.
 *
 * A shared priority-vector substrate (vector.ts) drives root election, path
 * costing, and role selection identically in both modes; only the transition
 * mechanism, BPDU origination, and topology-change handling differ.
 *
 * Deliberate simplifications (faithful to the PRD, §14): point-to-point links
 * only (no shared media, hence no Backup role); a single spanning-tree instance;
 * topology-change notifications are modelled as a propagating flood triggered by
 * structural events (link up/down) rather than the full 802.1D TCN-toward-root
 * machine.
 */

import {
  DEFAULT_TIMING,
  EMPTY_STEP,
  type AddPortOptions,
  type Bpdu,
  type BridgeId,
  type BridgeOptions,
  type BridgeSnapshot,
  type PortId,
  type PortRole,
  type PortSnapshot,
  type PortState,
  type PriorityVector,
  type ProtocolMode,
  type StepResult,
  type StpEvent,
  type Timing,
} from "./types.ts";
import { bridgeIdEquals, compareVector } from "./vector.ts";

interface PortInfo {
  readonly id: PortId;
  num: number;
  cost: number;
  priority: number;
  /** Configured edge flag (host attached). */
  edge: boolean;
  /** Operational edge: starts at `edge`, lost forever if a BPDU is heard. */
  operEdge: boolean;
  enabled: boolean;
  role: PortRole;
  state: PortState;
  // --- stored received info (the "last BPDU heard on this port") ---
  msg: PriorityVector | null;
  lastBpdu: Bpdu | null;
  rcvdMessageAge: number;
  rcvdAt: number;
  /** Absolute time the stored info expires; Infinity when none. */
  ageWhen: number;
  // --- transition timer (absolute expiry; Infinity when idle) ---
  fdWhen: number;
  // --- RSTP proposal/agreement handshake ---
  proposing: boolean;
  agreed: boolean;
}

const INF = Number.POSITIVE_INFINITY;

/** Mutable accumulator for one step's outputs. */
class Step {
  readonly bpdus: { portId: PortId; bpdu: Bpdu }[] = [];
  readonly events: StpEvent[] = [];
  result(): StepResult {
    return { bpdus: this.bpdus, events: this.events };
  }
}

export class Bridge {
  private priority: number;
  private readonly mac: string;
  private modeValue: ProtocolMode;
  private timing: Timing;

  private readonly ports = new Map<PortId, PortInfo>();

  private rootId: BridgeId;
  private rootPathCost = 0;
  private rootPortId: PortId | null = null;
  private isRootValue = true;

  private now: number;
  private helloWhen: number;
  /** BPDUs carry the TC flag while now < tcWhen (the topology-change flood). */
  private tcWhen = 0;

  /** portId → send an agreement on this transmission. */
  private readonly pendingTx = new Map<PortId, boolean>();

  /** A port was just added; the bridge needs one tick to initialize its states. */
  private needsInitialTick = false;

  constructor(options: BridgeOptions) {
    this.priority = options.id.priority;
    this.mac = options.id.mac;
    this.modeValue = options.mode;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.now = options.now;
    this.helloWhen = options.now;
    this.rootId = this.myId();
  }

  // -------------------------------------------------------------------------
  // Identity & introspection
  // -------------------------------------------------------------------------

  get id(): BridgeId {
    return { priority: this.priority, mac: this.mac };
  }

  get mode(): ProtocolMode {
    return this.modeValue;
  }

  private myId(): BridgeId {
    return { priority: this.priority, mac: this.mac };
  }

  // -------------------------------------------------------------------------
  // Port management (the editor wired / removed a link)
  // -------------------------------------------------------------------------

  addPort(portId: PortId, options: AddPortOptions): void {
    const enabled = options.enabled ?? true;
    this.ports.set(portId, {
      id: portId,
      num: options.num,
      cost: options.cost,
      priority: options.priority,
      edge: options.edge,
      operEdge: options.edge,
      enabled,
      role: "designated",
      state: this.modeValue === "rstp" ? "discarding" : "blocking",
      msg: null,
      lastBpdu: null,
      rcvdMessageAge: 0,
      rcvdAt: this.now,
      ageWhen: INF,
      fdWhen: INF,
      proposing: false,
      agreed: false,
    });
    this.needsInitialTick = true;
  }

  removePort(portId: PortId): void {
    this.ports.delete(portId);
  }

  hasPort(portId: PortId): boolean {
    return this.ports.has(portId);
  }

  // -------------------------------------------------------------------------
  // Driving the machine
  // -------------------------------------------------------------------------

  nextWakeAt(): number | null {
    if (this.needsInitialTick) return this.now;
    let next = INF;
    if (this.willTransmitHello()) next = Math.min(next, this.helloWhen);
    for (const p of this.ports.values()) {
      if (p.fdWhen !== INF) next = Math.min(next, p.fdWhen);
      if (p.enabled && p.msg && p.ageWhen !== INF) next = Math.min(next, p.ageWhen);
    }
    return next === INF ? null : next;
  }

  tick(now: number): StepResult {
    this.now = now;
    this.needsInitialTick = false;
    const step = new Step();

    if (this.willTransmitHello()) {
      while (now >= this.helloWhen) {
        this.helloWhen += this.timing.helloTime;
        this.queueHello();
      }
    } else if (now >= this.helloWhen) {
      this.helloWhen = now + this.timing.helloTime;
    }

    this.expireAged(step, now);
    this.recomputeRoles(step);
    this.advanceStates(step, now);
    this.flushTx(step);
    return step.result();
  }

  receive(bpdu: Bpdu, portId: PortId, now: number): StepResult {
    this.now = now;
    const p = this.ports.get(portId);
    if (!p || !p.enabled) return EMPTY_STEP;
    const step = new Step();

    // A BPDU on an edge port proves there's a bridge out there — drop edge status.
    if (p.operEdge) {
      p.operEdge = false;
      step.events.push({ type: "edgeLost", portId });
    }

    // Info that aged past Max Age in transit is rejected — it expires this
    // port's stored info instead of refreshing it. This is what bounds
    // count-to-infinity when the root vanishes: a stale "root is X" belief that
    // loops between peers has its Message Age bumped each hop until it exceeds
    // Max Age, at which point everyone discards it and re-elects.
    if (bpdu.messageAge >= bpdu.maxAge) {
      const had = p.msg !== null;
      p.msg = null;
      p.lastBpdu = bpdu;
      p.ageWhen = INF;
      p.proposing = false;
      p.agreed = false;
      if (had) step.events.push({ type: "infoExpired", portId });
      this.recomputeRoles(step);
      this.advanceStates(step, now);
      this.flushTx(step);
      return step.result();
    }

    p.msg = {
      rootId: bpdu.rootId,
      rootPathCost: bpdu.rootPathCost,
      designatedBridgeId: bpdu.senderBridgeId,
      designatedPortId: bpdu.senderPortId,
    };
    p.lastBpdu = bpdu;
    p.rcvdMessageAge = bpdu.messageAge;
    p.rcvdAt = now;
    p.ageWhen =
      this.modeValue === "rstp"
        ? now + 3 * bpdu.helloTime
        : now + Math.max(0.001, bpdu.maxAge - bpdu.messageAge);

    if (bpdu.flags.topologyChange) this.propagateTC(portId, step);

    this.recomputeRoles(step);

    if (this.modeValue === "rstp") {
      if (bpdu.flags.agreement && p.role === "designated" && p.proposing) {
        p.proposing = false;
        p.agreed = true;
        step.events.push({ type: "agreed", portId });
      }
      if (bpdu.flags.proposal && p.role === "root") {
        this.syncAndAgree(p, step);
      }
      // A designated port whose partner reports it is Alternate (discarding)
      // can go forwarding at once: the partner is blocking, so no loop can
      // form. This is what keeps the blocked link's *designated* end rapid too.
      if (p.role === "designated" && bpdu.flags.portRole === "alternate") {
        p.agreed = true;
      }
    }

    this.advanceStates(step, now);

    // STP relay: a non-root bridge forwards the root's config outward when its
    // root port refreshes — this is how "only the root originates" propagates.
    if (this.modeValue === "stp" && !this.isRootValue && portId === this.rootPortId) {
      for (const q of this.ports.values()) {
        if (q.enabled && !q.operEdge && q.role === "designated") this.pendingTx.set(q.id, false);
      }
    }

    this.flushTx(step);
    return step.result();
  }

  setPortEnabled(portId: PortId, up: boolean, now: number): StepResult {
    this.now = now;
    const p = this.ports.get(portId);
    if (!p || p.enabled === up) return EMPTY_STEP;
    const step = new Step();
    p.enabled = up;

    if (!up) {
      p.msg = null;
      p.lastBpdu = null;
      p.ageWhen = INF;
      p.proposing = false;
      p.agreed = false;
      p.fdWhen = INF;
      this.setRole(p, "disabled", step);
      this.setState(p, this.modeValue === "rstp" ? "discarding" : "disabled", step);
    } else {
      this.setState(p, this.modeValue === "rstp" ? "discarding" : "blocking", step);
    }
    if (!p.operEdge) this.triggerTC(portId, step);

    this.recomputeRoles(step);
    this.advanceStates(step, now);
    this.flushTx(step);
    return step.result();
  }

  // -------------------------------------------------------------------------
  // Live retuning (§4.6)
  // -------------------------------------------------------------------------

  setBridgePriority(priority: number, now: number): StepResult {
    this.priority = priority;
    return this.reconverge(now);
  }

  setPortCost(portId: PortId, cost: number, now: number): StepResult {
    const p = this.ports.get(portId);
    if (p) p.cost = cost;
    return this.reconverge(now);
  }

  setPortPriority(portId: PortId, priority: number, now: number): StepResult {
    const p = this.ports.get(portId);
    if (p) p.priority = priority;
    return this.reconverge(now);
  }

  setPortEdge(portId: PortId, edge: boolean, now: number): StepResult {
    const p = this.ports.get(portId);
    if (p) {
      p.edge = edge;
      p.operEdge = edge;
    }
    return this.reconverge(now);
  }

  setTiming(timing: Partial<Timing>, now: number): StepResult {
    this.now = now;
    this.timing = { ...this.timing, ...timing };
    return EMPTY_STEP;
  }

  setMode(mode: ProtocolMode, now: number): StepResult {
    this.now = now;
    if (mode === this.modeValue) return EMPTY_STEP;
    this.modeValue = mode;
    const step = new Step();

    // Re-run the relevant state machines from cold on the current topology.
    for (const p of this.ports.values()) {
      p.msg = null;
      p.lastBpdu = null;
      p.ageWhen = INF;
      p.fdWhen = INF;
      p.proposing = false;
      p.agreed = false;
      p.operEdge = p.edge;
      p.state = p.enabled
        ? mode === "rstp"
          ? "discarding"
          : "blocking"
        : mode === "rstp"
          ? "discarding"
          : "disabled";
      p.role = p.enabled ? "designated" : "disabled";
    }
    this.rootId = this.myId();
    this.rootPathCost = 0;
    this.rootPortId = null;
    this.isRootValue = true;
    this.tcWhen = 0;
    this.helloWhen = now;

    this.recomputeRoles(step);
    this.advanceStates(step, now);
    this.flushTx(step);
    return step.result();
  }

  private reconverge(now: number): StepResult {
    this.now = now;
    const step = new Step();
    this.recomputeRoles(step);
    this.advanceStates(step, now);
    this.flushTx(step);
    return step.result();
  }

  // -------------------------------------------------------------------------
  // Role selection — the shared substrate
  // -------------------------------------------------------------------------

  private recomputeRoles(step: Step): void {
    const prevRootId = this.rootId;
    const prevIsRoot = this.isRootValue;
    const prevCost = this.rootPathCost;

    const bridgeVector: PriorityVector = {
      rootId: this.myId(),
      rootPathCost: 0,
      designatedBridgeId: this.myId(),
      designatedPortId: { priority: 0, num: 0 },
    };

    let best = bridgeVector;
    let bestPort: PortInfo | null = null;
    for (const p of this.ports.values()) {
      if (!p.enabled || !p.msg) continue;
      const rootPath: PriorityVector = {
        rootId: p.msg.rootId,
        rootPathCost: p.msg.rootPathCost + p.cost,
        designatedBridgeId: p.msg.designatedBridgeId,
        designatedPortId: p.msg.designatedPortId,
      };
      if (compareVector(rootPath, best) < 0) {
        best = rootPath;
        bestPort = p;
      }
    }

    this.rootId = best.rootId;
    this.isRootValue = bestPort === null;
    this.rootPathCost = bestPort ? best.rootPathCost : 0;
    this.rootPortId = bestPort?.id ?? null;

    if (!bridgeIdEquals(prevRootId, this.rootId)) {
      step.events.push({ type: "rootChanged", rootId: this.rootId, wasRoot: prevIsRoot });
    }
    if (this.isRootValue && !prevIsRoot) step.events.push({ type: "becameRoot" });

    for (const p of this.ports.values()) {
      let role: PortRole;
      if (!p.enabled) {
        role = "disabled";
      } else if (p === bestPort) {
        role = "root";
      } else {
        const designated = this.designatedVector(p);
        role = !p.msg || compareVector(designated, p.msg) <= 0 ? "designated" : "alternate";
      }
      this.setRole(p, role, step);
    }

    // Re-advertise at once when our view of the root or its distance changed,
    // not just on the next Hello. Besides keeping RSTP rapid, this drives the
    // Message-Age counter upward fast during a root loss, so stale "the root is
    // X" beliefs looping between peers hit Max Age and die quickly (§4.4).
    if (!bridgeIdEquals(prevRootId, this.rootId) || prevCost !== this.rootPathCost) {
      for (const p of this.ports.values()) {
        if (!p.enabled || p.operEdge) continue;
        if (this.modeValue === "rstp" || p.role === "designated") this.pendingTx.set(p.id, false);
      }
    }
  }

  private designatedVector(p: PortInfo): PriorityVector {
    return {
      rootId: this.rootId,
      rootPathCost: this.rootPathCost,
      designatedBridgeId: this.myId(),
      designatedPortId: { priority: p.priority, num: p.num },
    };
  }

  private setRole(p: PortInfo, role: PortRole, step: Step): void {
    if (p.role === role) return;
    step.events.push({ type: "roleChanged", portId: p.id, from: p.role, to: role });
    p.role = role;
    // A fresh role forgets the old handshake (but keeps any running gate timer,
    // so an STP port mid-transition isn't stranded). The transition logic in
    // advanceStates re-arms timers as needed.
    p.proposing = false;
    p.agreed = false;
    // RSTP is event-driven: announce the new role at once so the neighbour can
    // react now instead of waiting for the next Hello. STP only originates from
    // designated ports.
    if (p.enabled && !p.operEdge && (this.modeValue === "rstp" || role === "designated")) {
      this.pendingTx.set(p.id, false);
    }
  }

  // -------------------------------------------------------------------------
  // State transitions — the mode-specific machinery
  // -------------------------------------------------------------------------

  private advanceStates(step: Step, now: number): void {
    if (this.modeValue === "rstp") {
      for (const p of this.ports.values()) this.advanceRstpPort(p, step, now);
    } else {
      for (const p of this.ports.values()) this.advanceStpPort(p, step, now);
    }
  }

  private advanceRstpPort(p: PortInfo, step: Step, now: number): void {
    if (!p.enabled || p.role === "disabled") {
      this.setState(p, "discarding", step);
      p.proposing = false;
      p.agreed = false;
      p.fdWhen = INF;
      return;
    }
    if (p.role === "alternate") {
      this.setState(p, "discarding", step);
      p.proposing = false;
      p.agreed = false;
      p.fdWhen = INF;
      return;
    }
    // Root and Designated ports both want to forward.
    if (p.operEdge) {
      this.setState(p, "forwarding", step);
      return;
    }
    if (p.agreed || p.state === "forwarding") {
      this.setState(p, "forwarding", step);
      p.fdWhen = INF;
      p.proposing = false;
      return;
    }
    // A designated port that wants to forward proposes; the handshake (or the
    // fallback timer) is what flips it.
    if (p.role === "designated" && !p.proposing) {
      p.proposing = true;
      step.events.push({ type: "proposing", portId: p.id });
      this.pendingTx.set(p.id, false);
    }
    if (p.fdWhen === INF) p.fdWhen = now + 2 * this.timing.forwardDelay;
    if (now >= p.fdWhen) {
      this.setState(p, "forwarding", step);
      p.fdWhen = INF;
      p.proposing = false;
    } else {
      this.setState(p, "discarding", step);
    }
  }

  private advanceStpPort(p: PortInfo, step: Step, now: number): void {
    if (!p.enabled) {
      this.setState(p, "disabled", step);
      p.fdWhen = INF;
      return;
    }
    if (p.role === "alternate" || p.role === "disabled") {
      this.setState(p, "blocking", step);
      p.fdWhen = INF;
      return;
    }
    // Root / Designated gate Blocking → Listening → Learning → Forwarding.
    switch (p.state) {
      case "disabled":
      case "discarding":
      case "blocking":
        this.setState(p, "listening", step);
        p.fdWhen = now + this.timing.forwardDelay;
        break;
      case "listening":
        if (p.fdWhen === INF) p.fdWhen = now + this.timing.forwardDelay;
        else if (now >= p.fdWhen) {
          this.setState(p, "learning", step);
          p.fdWhen = now + this.timing.forwardDelay;
        }
        break;
      case "learning":
        if (p.fdWhen === INF) p.fdWhen = now + this.timing.forwardDelay;
        else if (now >= p.fdWhen) {
          this.setState(p, "forwarding", step);
          p.fdWhen = INF;
        }
        break;
      case "forwarding":
        break;
    }
  }

  private setState(p: PortInfo, state: PortState, step: Step): void {
    if (p.state === state) return;
    step.events.push({ type: "stateChanged", portId: p.id, from: p.state, to: state });
    p.state = state;
  }

  /**
   * RSTP sync: a proposal arrived on our root port. Block every other non-edge
   * designated port (so no loop can form), agree upstream, and let the root
   * port forward at once — the blocked ports re-propose downstream next pass,
   * rippling the handshake outward. This is "the rapid."
   */
  private syncAndAgree(rootPort: PortInfo, step: Step): void {
    for (const q of this.ports.values()) {
      if (q === rootPort || !q.enabled || q.operEdge) continue;
      if (q.role === "designated") {
        this.setState(q, "discarding", step);
        q.agreed = false;
        q.proposing = false;
        q.fdWhen = INF;
      }
    }
    rootPort.agreed = true;
    this.setState(rootPort, "forwarding", step);
    rootPort.fdWhen = INF;
    step.events.push({ type: "agreed", portId: rootPort.id });
    this.pendingTx.set(rootPort.id, true);
  }

  // -------------------------------------------------------------------------
  // Topology change (modelled as a propagating flood, §4.3/§14)
  // -------------------------------------------------------------------------

  private triggerTC(portId: PortId | null, step: Step): void {
    this.tcWhen = this.now + 2 * this.timing.forwardDelay;
    step.events.push({ type: "topologyChange", portId });
  }

  private propagateTC(portId: PortId, step: Step): void {
    // Only re-arm if not already flooding, so the wave is finite.
    if (this.now < this.tcWhen) return;
    this.triggerTC(portId, step);
  }

  // -------------------------------------------------------------------------
  // Aging & transmission
  // -------------------------------------------------------------------------

  private expireAged(step: Step, now: number): void {
    for (const p of this.ports.values()) {
      if (p.enabled && p.msg && p.ageWhen !== INF && now >= p.ageWhen) {
        p.msg = null;
        p.lastBpdu = null;
        p.ageWhen = INF;
        p.proposing = false;
        p.agreed = false;
        step.events.push({ type: "infoExpired", portId: p.id });
      }
    }
  }

  private willTransmitHello(): boolean {
    if (this.modeValue === "rstp") {
      for (const p of this.ports.values()) if (p.enabled && !p.operEdge) return true;
      return false;
    }
    if (!this.isRootValue) return false;
    for (const p of this.ports.values()) if (p.enabled && !p.operEdge) return true;
    return false;
  }

  private queueHello(): void {
    if (this.modeValue === "rstp") {
      for (const p of this.ports.values()) {
        if (p.enabled && !p.operEdge && p.role !== "disabled") {
          if (!this.pendingTx.has(p.id)) this.pendingTx.set(p.id, false);
        }
      }
    } else if (this.isRootValue) {
      for (const p of this.ports.values()) {
        if (p.enabled && !p.operEdge && p.role === "designated") {
          if (!this.pendingTx.has(p.id)) this.pendingTx.set(p.id, false);
        }
      }
    }
  }

  private flushTx(step: Step): void {
    for (const [portId, agreement] of this.pendingTx) {
      const p = this.ports.get(portId);
      if (!p || !p.enabled) continue;
      step.bpdus.push({ portId, bpdu: this.buildBpdu(p, agreement) });
    }
    this.pendingTx.clear();
  }

  private buildBpdu(p: PortInfo, agreement: boolean): Bpdu {
    const rootPort = this.rootPortId ? this.ports.get(this.rootPortId) : null;
    const messageAge = this.isRootValue ? 0 : (rootPort?.rcvdMessageAge ?? 0) + 1;
    return {
      version: this.modeValue,
      type: this.modeValue === "rstp" ? "rst" : "config",
      rootId: this.rootId,
      rootPathCost: this.rootPathCost,
      senderBridgeId: this.myId(),
      senderPortId: { priority: p.priority, num: p.num },
      flags: {
        topologyChange: this.now < this.tcWhen,
        topologyChangeAck: false,
        proposal:
          this.modeValue === "rstp" && p.role === "designated" && p.proposing && !p.operEdge,
        agreement,
        learning: p.state === "learning",
        forwarding: p.state === "forwarding",
        portRole: p.role,
      },
      messageAge,
      maxAge: this.timing.maxAge,
      helloTime: this.timing.helloTime,
      forwardDelay: this.timing.forwardDelay,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  snapshot(): BridgeSnapshot {
    const ports: PortSnapshot[] = [];
    for (const p of this.ports.values()) {
      ports.push({
        id: p.id,
        num: p.num,
        role: p.role,
        state: p.state,
        cost: p.cost,
        priority: p.priority,
        edge: p.operEdge,
        enabled: p.enabled,
        forwardTimer: p.fdWhen === INF ? null : Math.max(0, p.fdWhen - this.now),
        ageTimer:
          p.enabled && p.msg && p.ageWhen !== INF ? Math.max(0, p.ageWhen - this.now) : null,
        proposing: p.proposing,
        agreed: p.agreed,
        lastBpdu: p.lastBpdu,
      });
    }
    ports.sort((a, b) => a.num - b.num);
    return {
      id: this.myId(),
      mode: this.modeValue,
      rootId: this.rootId,
      rootPathCost: this.rootPathCost,
      isRoot: this.isRootValue,
      rootPortId: this.rootPortId,
      timing: this.timing,
      ports,
    };
  }
}
