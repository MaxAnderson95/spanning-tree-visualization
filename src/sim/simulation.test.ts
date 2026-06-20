import { describe, expect, it } from "vite-plus/test";
import type { PortRole, PortState } from "../spanning-tree/index.ts";
import { Chaos } from "./chaos.ts";
import type { Frame } from "./simulation.ts";
import { SpanningTreeSimulation } from "./simulation.ts";

function lastFrame(sim: SpanningTreeSimulation): Frame {
  const frame = sim.frames[sim.frames.length - 1];
  if (!frame) throw new Error("no frames");
  return frame;
}

/** Count ports across every bridge in a frame holding a given role. */
function countRole(frame: Frame, role: PortRole): number {
  let n = 0;
  for (const b of frame.bridges) for (const p of b.snapshot.ports) if (p.role === role) n += 1;
  return n;
}

/** Count ports across every bridge in a frame holding a given state. */
function countState(frame: Frame, state: PortState): number {
  let n = 0;
  for (const b of frame.bridges) for (const p of b.snapshot.ports) if (p.state === state) n += 1;
  return n;
}

function rootMacOf(frame: Frame, switchId: string): string {
  return frame.bridges.find((b) => b.switchId === switchId)?.snapshot.rootId.mac ?? "";
}

const S1_MAC = "00:00:00:00:00:01";
const S2_MAC = "00:00:00:00:00:02";

describe("default topology convergence (RSTP)", () => {
  it("elects S1 as root and blocks exactly one port to break the loop", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);
    const f = lastFrame(sim);

    // Every switch agrees S1 (lowest Bridge ID) is the root.
    for (const id of sim.switchIds()) expect(rootMacOf(f, id)).toBe(S1_MAC);
    // 4-switch loop ⇒ 3 tree links + 1 redundant ⇒ exactly one Alternate end.
    expect(countRole(f, "alternate")).toBe(1);
    // The island reports converged with a single root.
    expect(f.islands).toHaveLength(1);
    expect(f.islands[0]?.converged).toBe(true);
    expect(f.islands[0]?.rootMac).toBe(S1_MAC);
  });

  it("records a non-trivial timeline, time-ordered", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);
    expect(sim.frames.length).toBeGreaterThan(10);
    for (let i = 1; i < sim.frames.length; i += 1) {
      expect(sim.frames[i]!.time).toBeGreaterThanOrEqual(sim.frames[i - 1]!.time);
    }
  });

  it("brings host edge ports to forwarding (PortFast)", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);
    const f = lastFrame(sim);
    let edgePorts = 0;
    for (const b of f.bridges) {
      for (const p of b.snapshot.ports) {
        if (p.edge) {
          edgePorts += 1;
          expect(p.state).toBe("forwarding");
        }
      }
    }
    expect(edgePorts).toBe(2); // two hosts in the default network
  });

  it("the forwarding graph is acyclic — never a loop", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);
    const f = lastFrame(sim);
    // A loop would need every end of some cycle forwarding; the single
    // alternate guarantees at least one rung is discarding.
    expect(countRole(f, "alternate")).toBeGreaterThanOrEqual(1);
    for (const b of f.bridges) {
      for (const p of b.snapshot.ports) {
        if (p.role === "alternate") expect(p.state).toBe("discarding");
      }
    }
  });
});

describe("determinism", () => {
  it("identical seed ⇒ identical converged state", () => {
    const run = (): string => {
      const sim = new SpanningTreeSimulation({ seed: 7 });
      sim.advanceTo(5);
      const f = lastFrame(sim);
      return f.bridges
        .map(
          (b) =>
            `${b.switchId}:${b.snapshot.isRoot}:${b.snapshot.rootPathCost}:` +
            b.snapshot.ports.map((p) => `${p.num}${p.role[0]}${p.state[0]}`).join(","),
        )
        .join("|");
    };
    expect(run()).toEqual(run());
  });
});

describe("frameAt", () => {
  it("finds the latest frame at or before a time", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);
    const mid = sim.frames[Math.floor(sim.frames.length / 2)]!;
    expect(sim.frameAt(mid.time).time).toBe(mid.time);
    expect(sim.frameAt(0).time).toBe(0);
    expect(sim.frameAt(99).time).toBe(lastFrame(sim).time);
  });
});

describe("failure & reconvergence", () => {
  it("cutting a loop link heals into a pure tree (no alternates)", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);
    expect(countRole(lastFrame(sim), "alternate")).toBe(1);

    const loopLink = [...sim.topology.links.values()].find(
      (l) => sim.topology.switches.has(l.a.device) && sim.topology.switches.has(l.b.device),
    );
    expect(loopLink).toBeDefined();
    sim.cutLink(loopLink!.id);
    sim.advanceTo(sim.duration + 5);

    const f = lastFrame(sim);
    expect(rootMacOf(f, "s1")).toBe(S1_MAC);
    expect(countRole(f, "alternate")).toBe(0); // 3 links over 4 switches = a tree
  });

  it("powering off the root makes the survivors elect a new one", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);
    expect(sim.powerOff("s1")).toBe(true);
    sim.advanceTo(sim.duration + 8);

    const f = lastFrame(sim);
    expect(f.poweredOff).toContain("s1");
    // s2,s3,s4 remain (a line) → new root S2; one island, no loop.
    expect(f.islands).toHaveLength(1);
    expect(rootMacOf(f, "s2")).toBe(S2_MAC);
  });
});

describe("partitions & islands (§5.8)", () => {
  it("a split gives each island its own root; healing reunites on one", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);

    expect(sim.splitNetwork()).toBe(true);
    sim.advanceTo(sim.duration + 6);
    const split = lastFrame(sim);
    expect(split.islands).toHaveLength(2);
    // The two islands elect different roots.
    const roots = new Set(split.islands.map((i) => i.rootMac));
    expect(roots.size).toBe(2);

    expect(sim.healNetwork()).toBe(true);
    sim.advanceTo(sim.duration + 6);
    const healed = lastFrame(sim);
    expect(healed.islands).toHaveLength(1);
    expect(healed.islands[0]?.rootMac).toBe(S1_MAC);
    expect(countRole(healed, "alternate")).toBe(1);
  });
});

describe("STP vs RSTP", () => {
  it("STP converges to the same root and loop-break, just slower", () => {
    const sim = new SpanningTreeSimulation({ seed: 1, mode: "stp" });
    // Too early in STP (Forward-Delay gating) — nothing forwards yet.
    sim.advanceTo(2);
    expect(countState(lastFrame(sim), "forwarding")).toBe(0);

    sim.advanceTo(80); // well past 2 × Forward-Delay
    const f = lastFrame(sim);
    for (const id of sim.switchIds()) expect(rootMacOf(f, id)).toBe(S1_MAC);
    expect(countRole(f, "alternate")).toBe(1);
    expect(countState(f, "forwarding")).toBeGreaterThan(0);
  });

  it("RSTP reaches forwarding sub-second; the toggle re-runs the tree", () => {
    const sim = new SpanningTreeSimulation({ seed: 1, mode: "rstp" });
    sim.advanceTo(1);
    expect(countState(lastFrame(sim), "forwarding")).toBeGreaterThan(0);

    sim.setMode("stp");
    sim.advanceTo(sim.duration + 80);
    const f = lastFrame(sim);
    expect(f.mode).toBe("stp");
    expect(countRole(f, "alternate")).toBe(1);
  });
});

describe("editor", () => {
  it("clears the canvas and builds a fresh two-switch link", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    sim.advanceTo(5);
    sim.clearCanvas();
    expect(sim.switchIds()).toHaveLength(0);

    const a = sim.addSwitch({ x: -2, y: 0 });
    const b = sim.addSwitch({ x: 2, y: 0 });
    sim.addLink(a, b);
    sim.advanceTo(sim.duration + 5);

    const f = lastFrame(sim);
    expect(f.bridges).toHaveLength(2);
    expect(countRole(f, "root")).toBe(1); // b's port toward the root a
    expect(countRole(f, "designated")).toBe(1);
  });
});

describe("chaos", () => {
  it("flaps a link and restores it when armed", () => {
    const sim = new SpanningTreeSimulation({ seed: 1 });
    const chaos = new Chaos(sim, { seed: 4 });
    chaos.linkFlap = true;
    chaos.intensity = 1;
    chaos.arm(0);

    let cut = false;
    let restored = false;
    for (let t = 0.5; t <= 60; t += 0.5) {
      sim.advanceTo(t);
      chaos.step(sim.duration);
      for (const frame of sim.frames) {
        if (frame.cause.kind === "linkCut") cut = true;
        if (frame.cause.kind === "linkRestore") restored = true;
      }
      if (cut && restored) break;
    }
    expect(cut).toBe(true);
    expect(restored).toBe(true);
  });
});

describe("history bounds", () => {
  it("trims beyond maxFrames but keeps the live edge consistent", () => {
    const sim = new SpanningTreeSimulation({ seed: 1, maxFrames: 150 });
    sim.advanceTo(60);
    expect(sim.frames.length).toBeLessThanOrEqual(150);
    expect(sim.horizon).toBeGreaterThan(0);
    expect(lastFrame(sim).bridges.length).toBeGreaterThan(0);
  });
});
