/**
 * Chaos: a seeded, hands-off mischief engine (§5.9). Each disruption type is
 * independently armable and reuses an ordinary intervention, so the network's
 * resilience plays out unattended. A single intensity dial governs cadence.
 * Everything is off by default and drawn from a seeded RNG, so `?seed=N`
 * reproduces an exact chaos run.
 */

import {
  BRIDGE_PRIORITY_STEP,
  isSwitch,
  linkActive,
  MAX_BRIDGE_PRIORITY,
  type LinkId,
  type SwitchId,
} from "../model/index.ts";
import { mulberry32, pick } from "./prng.ts";
import type { SpanningTreeSimulation } from "./simulation.ts";

export interface ChaosOptions {
  readonly seed?: number;
}

type Restore = { at: number; run: () => void };

export class Chaos {
  linkFlap = false;
  powerCycle = false;
  partition = false;
  priorityChurn = false;
  /** 0 (calm) … 1 (frantic). */
  intensity = 0.45;

  private readonly sim: SpanningTreeSimulation;
  private rng: () => number;
  private nextAt = Number.POSITIVE_INFINITY;
  private restores: Restore[] = [];

  constructor(sim: SpanningTreeSimulation, options: ChaosOptions = {}) {
    this.sim = sim;
    this.rng = mulberry32((options.seed ?? sim.seed) ^ 0x5f3759df);
  }

  get armed(): boolean {
    return this.linkFlap || this.powerCycle || this.partition || this.priorityChurn;
  }

  /** Schedule the first action a short while from now. */
  arm(now: number): void {
    this.nextAt = now + this.interval() * 0.4;
  }

  disarmRestores(): void {
    this.restores = [];
    this.nextAt = Number.POSITIVE_INFINITY;
  }

  /** Drive chaos forward to the sim's live edge. Call after advancing the sim. */
  step(now: number): void {
    // Fire any due restorations first (heal flaps, power switches back up, …).
    if (this.restores.length > 0) {
      const due = this.restores.filter((r) => r.at <= now);
      this.restores = this.restores.filter((r) => r.at > now);
      for (const r of due) r.run();
    }
    if (!this.armed) {
      this.nextAt = Number.POSITIVE_INFINITY;
      return;
    }
    if (!Number.isFinite(this.nextAt)) this.arm(now);
    if (now < this.nextAt) return;

    this.act(now);
    this.nextAt = now + this.interval();
  }

  // -------------------------------------------------------------------------

  /** Seconds between actions; higher intensity ⇒ shorter interval. */
  private interval(): number {
    const t = Math.min(Math.max(this.intensity, 0), 1);
    return 28 - t * 23; // 28 s (calm) … 5 s (frantic)
  }

  private act(now: number): void {
    const choices: (() => void)[] = [];
    if (this.linkFlap) choices.push(() => this.doLinkFlap(now));
    if (this.powerCycle) choices.push(() => this.doPowerCycle(now));
    if (this.partition) choices.push(() => this.doPartition(now));
    if (this.priorityChurn) choices.push(() => this.doPriorityChurn());
    if (choices.length === 0) return;
    pick(this.rng, choices)();
  }

  private doLinkFlap(now: number): void {
    const link = this.randomActiveSwitchLink();
    if (!link) return;
    if (this.sim.cutLink(link)) {
      this.restores.push({ at: now + 3 + this.rng() * 5, run: () => this.sim.restoreLink(link) });
    }
  }

  private doPowerCycle(now: number): void {
    const id = this.randomPoweredSwitch();
    if (!id) return;
    // Don't strand the network: leave at least two switches powered.
    if (this.poweredCount() <= 2) return;
    if (this.sim.powerOff(id)) {
      this.restores.push({ at: now + 4 + this.rng() * 6, run: () => this.sim.powerOn(id) });
    }
  }

  private doPartition(now: number): void {
    if (this.sim.activeSplit.length > 0) return;
    if (this.sim.splitNetwork()) {
      this.restores.push({ at: now + 10 + this.rng() * 10, run: () => this.sim.healNetwork() });
    }
  }

  private doPriorityChurn(): void {
    const id = this.randomPoweredSwitch();
    if (!id) return;
    const steps = Math.floor(this.rng() * (MAX_BRIDGE_PRIORITY / BRIDGE_PRIORITY_STEP + 1));
    this.sim.setBridgePriority(id, steps * BRIDGE_PRIORITY_STEP);
  }

  // -------------------------------------------------------------------------

  private randomActiveSwitchLink(): LinkId | null {
    const topo = this.sim.topology;
    const candidates: LinkId[] = [];
    for (const link of topo.links.values()) {
      if (!isSwitch(topo, link.a.device) || !isSwitch(topo, link.b.device)) continue;
      if (linkActive(topo, link)) candidates.push(link.id);
    }
    return candidates.length > 0 ? pick(this.rng, candidates) : null;
  }

  private randomPoweredSwitch(): SwitchId | null {
    const powered = [...this.sim.topology.switches.values()]
      .filter((s) => s.powered)
      .map((s) => s.id);
    return powered.length > 0 ? pick(this.rng, powered) : null;
  }

  private poweredCount(): number {
    let n = 0;
    for (const s of this.sim.topology.switches.values()) if (s.powered) n += 1;
    return n;
  }
}
