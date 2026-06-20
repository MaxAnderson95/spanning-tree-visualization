import { describe, expect, it } from "vite-plus/test";
import { Bridge } from "./bridge.ts";
import type { Bpdu, PortId, PortRole, PortState, ProtocolMode, StpEvent } from "./types.ts";

/**
 * A tiny synchronous network that drives bridges exactly as the real simulator
 * does — earliest event first, BPDUs delivered across links after a fixed
 * latency — but with no recording or rendering. Enough to converge a topology
 * and assert on the resulting roles, states, root, and events.
 */

const mac = (n: number): string => `00:00:00:00:00:${n.toString(16).padStart(2, "0")}`;

interface Flight {
  at: number;
  toBridge: string;
  toPort: PortId;
  bpdu: Bpdu;
}

interface CollectedEvent {
  at: number;
  bridge: string;
  event: StpEvent;
}

class Net {
  readonly bridges = new Map<string, Bridge>();
  /** portId → the port it is wired to (switch-switch links only). */
  private readonly adjacency = new Map<PortId, PortId>();
  private readonly nextNum = new Map<string, number>();
  private flights: Flight[] = [];
  private now = 0;
  readonly latency = 0.01;
  readonly events: CollectedEvent[] = [];
  private readonly mode: ProtocolMode;

  constructor(mode: ProtocolMode) {
    this.mode = mode;
  }

  bridge(name: string, macNum: number, priority = 32768): void {
    this.bridges.set(
      name,
      new Bridge({ id: { priority, mac: mac(macNum) }, mode: this.mode, now: 0 }),
    );
    this.nextNum.set(name, 1);
  }

  private alloc(name: string): number {
    const n = this.nextNum.get(name) ?? 1;
    this.nextNum.set(name, n + 1);
    return n;
  }

  /** Wire two bridges with a point-to-point switch link; returns [portA, portB]. */
  wire(
    a: string,
    b: string,
    opts: { cost?: number; priorityA?: number; priorityB?: number } = {},
  ): [PortId, PortId] {
    const numA = this.alloc(a);
    const numB = this.alloc(b);
    const portA: PortId = `${a}#${numA}`;
    const portB: PortId = `${b}#${numB}`;
    const cost = opts.cost ?? 4;
    this.bridges
      .get(a)
      ?.addPort(portA, { num: numA, cost, priority: opts.priorityA ?? 128, edge: false });
    this.bridges
      .get(b)
      ?.addPort(portB, { num: numB, cost, priority: opts.priorityB ?? 128, edge: false });
    this.adjacency.set(portA, portB);
    this.adjacency.set(portB, portA);
    return [portA, portB];
  }

  /** Attach a host (edge port) to a bridge; returns the edge portId. */
  edge(name: string): PortId {
    const num = this.alloc(name);
    const portId: PortId = `${name}#${num}`;
    this.bridges.get(name)?.addPort(portId, { num, cost: 4, priority: 128, edge: true });
    return portId;
  }

  setEnabled(portId: PortId, up: boolean): void {
    const owner = portId.slice(0, portId.indexOf("#"));
    this.dispatch(owner, this.bridges.get(owner)?.setPortEnabled(portId, up, this.now));
    const far = this.adjacency.get(portId);
    if (far) {
      const farOwner = far.slice(0, far.indexOf("#"));
      this.dispatch(farOwner, this.bridges.get(farOwner)?.setPortEnabled(far, up, this.now));
    }
  }

  private dispatch(
    name: string,
    step:
      | { bpdus: readonly { portId: PortId; bpdu: Bpdu }[]; events: readonly StpEvent[] }
      | undefined,
  ): void {
    if (!step) return;
    for (const event of step.events) this.events.push({ at: this.now, bridge: name, event });
    for (const { portId, bpdu } of step.bpdus) {
      const far = this.adjacency.get(portId);
      if (!far) continue; // edge port → nobody listening
      const toBridge = far.slice(0, far.indexOf("#"));
      this.flights.push({ at: this.now + this.latency, toBridge, toPort: far, bpdu });
    }
  }

  run(until: number): void {
    let guard = 0;
    for (;;) {
      if (guard++ > 200_000) throw new Error("event loop did not settle");
      let next: Flight | null = null;
      for (const f of this.flights) if (!next || f.at < next.at) next = f;
      let wakeAt = Number.POSITIVE_INFINITY;
      let wakeName: string | null = null;
      for (const [name, br] of this.bridges) {
        const w = br.nextWakeAt();
        if (w !== null && Number.isFinite(w) && w < wakeAt) {
          wakeAt = w;
          wakeName = name;
        }
      }
      const flightAt = next?.at ?? Number.POSITIVE_INFINITY;
      const eventAt = Math.min(flightAt, wakeAt);
      if (eventAt > until || !Number.isFinite(eventAt)) break;
      this.now = eventAt;
      if (flightAt <= wakeAt && next) {
        this.flights = this.flights.filter((f) => f !== next);
        const br = this.bridges.get(next.toBridge);
        this.dispatch(next.toBridge, br?.receive(next.bpdu, next.toPort, this.now));
      } else if (wakeName) {
        const br = this.bridges.get(wakeName);
        this.dispatch(wakeName, br?.tick(this.now));
      }
    }
    this.now = until;
  }

  role(portId: PortId): PortRole {
    const owner = portId.slice(0, portId.indexOf("#"));
    const snap = this.bridges.get(owner)?.snapshot();
    return snap?.ports.find((p) => p.id === portId)?.role ?? "disabled";
  }

  state(portId: PortId): PortState {
    const owner = portId.slice(0, portId.indexOf("#"));
    const snap = this.bridges.get(owner)?.snapshot();
    return snap?.ports.find((p) => p.id === portId)?.state ?? "disabled";
  }

  isRoot(name: string): boolean {
    return this.bridges.get(name)?.snapshot().isRoot ?? false;
  }

  rootMac(name: string): string {
    return this.bridges.get(name)?.snapshot().rootId.mac ?? "";
  }

  cost(name: string): number {
    return this.bridges.get(name)?.snapshot().rootPathCost ?? -1;
  }

  /** Count ports across all bridges with a given role. */
  countRole(role: PortRole): number {
    let n = 0;
    for (const br of this.bridges.values()) {
      for (const p of br.snapshot().ports) if (p.role === role) n += 1;
    }
    return n;
  }
}

describe("root election", () => {
  it("elects the lowest Bridge ID (priority first, then MAC)", () => {
    const net = new Net("rstp");
    net.bridge("A", 3);
    net.bridge("B", 1); // lowest MAC
    net.bridge("C", 2);
    net.wire("A", "B");
    net.wire("B", "C");
    net.wire("C", "A");
    net.run(5);

    expect(net.isRoot("B")).toBe(true);
    expect(net.isRoot("A")).toBe(false);
    expect(net.isRoot("C")).toBe(false);
    for (const name of ["A", "B", "C"]) expect(net.rootMac(name)).toBe(mac(1));
  });

  it("priority beats a lower MAC", () => {
    const net = new Net("rstp");
    net.bridge("A", 1, 4096); // lowest MAC but worse priority
    net.bridge("B", 9, 0); // best priority
    net.wire("A", "B");
    net.run(5);
    expect(net.isRoot("B")).toBe(true);
    expect(net.rootMac("A")).toBe(mac(9));
  });
});

describe("path cost & root port", () => {
  it("accumulates ingress cost along the best path", () => {
    const net = new Net("rstp");
    net.bridge("A", 1); // root
    net.bridge("B", 2);
    net.bridge("C", 3);
    net.wire("A", "B", { cost: 4 });
    net.wire("B", "C", { cost: 4 });
    net.run(5);

    expect(net.cost("A")).toBe(0);
    expect(net.cost("B")).toBe(4);
    expect(net.cost("C")).toBe(8); // A→B→C
  });

  it("prefers the cheaper path when two exist", () => {
    const net = new Net("rstp");
    net.bridge("A", 1); // root
    net.bridge("B", 2);
    const [, bDirect] = net.wire("A", "B", { cost: 4 }); // cost 4 direct
    net.bridge("M", 3);
    net.wire("A", "M", { cost: 4 });
    const [mToB] = net.wire("M", "B", { cost: 4 }); // redundant rung
    net.run(5);

    // B reaches the root the cheap way (cost 4 direct), not the cost-8 way via M.
    expect(net.cost("B")).toBe(4);
    expect(net.role(bDirect)).toBe("root");
    // On the redundant M↔B rung both ends are equal cost (4) to root, so the
    // lower Bridge ID (B) is designated and M's end blocks.
    expect(net.role(mToB)).toBe("alternate");
  });
});

describe("loop safety", () => {
  it("blocks exactly one port to break a single cycle", () => {
    const net = new Net("rstp");
    net.bridge("A", 1);
    net.bridge("B", 2);
    net.bridge("C", 3);
    net.wire("A", "B");
    net.wire("B", "C");
    net.wire("C", "A");
    net.run(5);

    // A triangle has one independent cycle → exactly one Alternate port.
    expect(net.countRole("alternate")).toBe(1);
    // The active (forwarding) graph is the tree: 2 edges = 4 port-ends, all
    // root/designated forwarding; the blocked rung is the one alternate.
    expect(net.countRole("root")).toBe(2);
  });

  it("port priority decides which parallel link blocks", () => {
    const net = new Net("rstp");
    net.bridge("A", 1); // root
    net.bridge("B", 2);
    // Two equal-cost links A↔B. A's port priorities decide B's choice:
    // give the first link a worse (higher) priority on A's side so B blocks it.
    const [, b1] = net.wire("A", "B", { cost: 4, priorityA: 144 });
    const [, b2] = net.wire("A", "B", { cost: 4, priorityA: 128 });
    net.run(5);

    expect(net.role(b2)).toBe("root"); // lower port priority on A wins
    expect(net.role(b1)).toBe("alternate");
  });
});

describe("RSTP rapid transition", () => {
  it("reaches forwarding sub-second via the handshake", () => {
    const net = new Net("rstp");
    net.bridge("A", 1);
    net.bridge("B", 2);
    net.bridge("C", 3);
    net.wire("A", "B");
    net.wire("B", "C");
    net.wire("C", "A");
    net.run(1); // well under a single Forward-Delay (15 s)

    // Every non-alternate port is already forwarding.
    for (const br of net.bridges.values()) {
      for (const p of br.snapshot().ports) {
        if (p.role === "root" || p.role === "designated") {
          expect(p.state).toBe("forwarding");
        } else {
          expect(p.state).toBe("discarding");
        }
      }
    }
  });
});

describe("STP timer-gated transition", () => {
  it("crawls through listening/learning and only forwards after 2× Forward-Delay", () => {
    const net = new Net("stp");
    net.bridge("A", 1);
    net.bridge("B", 2);
    net.wire("A", "B");

    net.run(1);
    // Far too early to forward in STP.
    for (const br of net.bridges.values()) {
      for (const p of br.snapshot().ports) {
        if (p.role === "root" || p.role === "designated") {
          expect(p.state === "listening" || p.state === "learning").toBe(true);
        }
      }
    }

    net.run(40); // > 2 × 15 s
    expect(net.state("A#1")).toBe("forwarding");
    expect(net.state("B#1")).toBe("forwarding");
  });
});

describe("edge ports (PortFast)", () => {
  it("forward immediately in RSTP and skip the handshake", () => {
    const net = new Net("rstp");
    net.bridge("A", 1);
    const host = net.edge("A");
    net.run(0.5);
    expect(net.role(host)).toBe("designated");
    expect(net.state(host)).toBe("forwarding");
  });
});

describe("failure & reconvergence", () => {
  it("promotes an Alternate when the root path is cut", () => {
    const net = new Net("rstp");
    net.bridge("A", 1); // root
    net.bridge("B", 2);
    net.bridge("C", 3);
    const [ab] = net.wire("A", "B");
    net.wire("B", "C");
    const [, ca] = net.wire("C", "A");
    net.run(3);

    // C reaches root via its direct A link; the B↔C side has one alternate.
    expect(net.isRoot("A")).toBe(true);
    const alternatesBefore = net.countRole("alternate");
    expect(alternatesBefore).toBe(1);

    // Cut A↔B. B must now reach the root the long way (through C).
    net.setEnabled(ab, false);
    net.run(10);

    expect(net.isRoot("A")).toBe(true);
    expect(net.rootMac("B")).toBe(mac(1)); // B still sees A as root, via C
    expect(net.role(ca)).toBe("designated"); // C→A still forwards toward root
    // No port is alternate anymore: the remaining graph is a tree (a line).
    expect(net.countRole("alternate")).toBe(0);
  });

  it("a partition makes each island elect its own root", () => {
    const net = new Net("rstp");
    net.bridge("A", 1); // would-be global root
    net.bridge("B", 2);
    const [ab] = net.wire("A", "B");
    net.run(3);
    expect(net.rootMac("B")).toBe(mac(1));

    net.setEnabled(ab, false); // sever the only link
    net.run(10);
    // B is now alone → it elects itself.
    expect(net.isRoot("B")).toBe(true);
    expect(net.rootMac("B")).toBe(mac(2));
  });
});

describe("topology change", () => {
  it("emits a topology-change event when a link is cut", () => {
    const net = new Net("rstp");
    net.bridge("A", 1);
    net.bridge("B", 2);
    const [ab] = net.wire("A", "B");
    net.run(3);
    const before = net.events.length;
    net.setEnabled(ab, false);
    net.run(5);
    const tc = net.events.slice(before).some((e) => e.event.type === "topologyChange");
    expect(tc).toBe(true);
  });
});

describe("determinism", () => {
  it("identical inputs produce identical state", () => {
    const build = (): string => {
      const net = new Net("rstp");
      net.bridge("A", 3);
      net.bridge("B", 1);
      net.bridge("C", 2);
      net.bridge("D", 4);
      net.wire("A", "B");
      net.wire("B", "C");
      net.wire("C", "D");
      net.wire("D", "A");
      net.run(5);
      return [...net.bridges.values()]
        .map((br) => {
          const s = br.snapshot();
          return `${s.id.mac}:${s.isRoot}:${s.rootPathCost}:${s.ports.map((p) => `${p.num}${p.role[0]}${p.state[0]}`).join(",")}`;
        })
        .join("|");
    };
    expect(build()).toEqual(build());
  });
});
