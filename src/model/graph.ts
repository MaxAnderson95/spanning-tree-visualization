/**
 * Pure graph operations over a {@link Topology}. No mutation, no I/O. These
 * back island detection (each connected component is an independent
 * spanning-tree domain, §5.8), the loop-highlight on hover (§6.3), and the
 * port enumeration the simulator needs to wire bridges up.
 */

import type { DeviceId, LinkConfig, LinkEnd, LinkId, SwitchId, Topology } from "./types.ts";

export function isSwitch(topo: Topology, id: DeviceId): boolean {
  return topo.switches.has(id);
}

export function isHost(topo: Topology, id: DeviceId): boolean {
  return topo.hosts.has(id);
}

export function deviceExists(topo: Topology, id: DeviceId): boolean {
  return topo.switches.has(id) || topo.hosts.has(id);
}

/** Is a device powered / present? Hosts are always "on"; missing devices are off. */
export function devicePowered(topo: Topology, id: DeviceId): boolean {
  const sw = topo.switches.get(id);
  if (sw) return sw.powered;
  return topo.hosts.has(id);
}

/**
 * Can BPDUs / frames cross this link right now? Requires: not cut, both
 * endpoint devices present, and any switch endpoint powered on.
 */
export function linkActive(topo: Topology, link: LinkConfig): boolean {
  if (link.cut) return false;
  return devicePowered(topo, link.a.device) && devicePowered(topo, link.b.device);
}

/** The end of `link` that is not on `device`, or null if neither/both are. */
export function farEnd(link: LinkConfig, device: DeviceId): LinkEnd | null {
  if (link.a.device === device && link.b.device !== device) return link.b;
  if (link.b.device === device && link.a.device !== device) return link.a;
  return null;
}

/** All links with at least one end on `device`. */
export function linksOn(topo: Topology, device: DeviceId): LinkConfig[] {
  const out: LinkConfig[] = [];
  for (const link of topo.links.values()) {
    if (link.a.device === device || link.b.device === device) out.push(link);
  }
  return out;
}

/** The highest port number currently allocated on a device (0 if none). */
export function maxPortNum(topo: Topology, device: DeviceId): number {
  let max = 0;
  for (const link of topo.links.values()) {
    if (link.a.device === device) max = Math.max(max, link.a.portNum);
    if (link.b.device === device) max = Math.max(max, link.b.portNum);
  }
  return max;
}

/** Switch-to-switch adjacency over *active* links only (used for islands & loops). */
function switchAdjacency(topo: Topology): Map<SwitchId, { linkId: LinkId; to: SwitchId }[]> {
  const adj = new Map<SwitchId, { linkId: LinkId; to: SwitchId }[]>();
  for (const id of topo.switches.keys()) adj.set(id, []);

  for (const link of topo.links.values()) {
    if (!isSwitch(topo, link.a.device) || !isSwitch(topo, link.b.device)) continue;
    if (!linkActive(topo, link)) continue;
    adj.get(link.a.device)?.push({ linkId: link.id, to: link.b.device });
    adj.get(link.b.device)?.push({ linkId: link.id, to: link.a.device });
  }
  return adj;
}

/**
 * Connected components of *powered* switches joined by active switch-switch
 * links. Each component is an independent spanning-tree island that elects its
 * own root (§5.8). Powered-off switches are dropped entirely.
 */
export function switchIslands(topo: Topology): SwitchId[][] {
  const adj = switchAdjacency(topo);
  const seen = new Set<SwitchId>();
  const islands: SwitchId[][] = [];

  const powered = [...topo.switches.values()].filter((s) => s.powered).map((s) => s.id);
  // Deterministic ordering keeps island indices stable across runs.
  powered.sort();

  for (const start of powered) {
    if (seen.has(start)) continue;
    const island: SwitchId[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const cur = stack.pop() as SwitchId;
      island.push(cur);
      for (const { to } of adj.get(cur) ?? []) {
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    island.sort();
    islands.push(island);
  }
  islands.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  return islands;
}

/** Number of distinct spanning-tree islands among powered switches. */
export function islandCount(topo: Topology): number {
  return switchIslands(topo).length;
}

/**
 * Whether two powered switches can reach each other over active links —
 * optionally pretending `excludeLink` is gone (used to detect cycle membership).
 */
function switchesConnected(
  topo: Topology,
  from: SwitchId,
  to: SwitchId,
  excludeLink: LinkId | null,
): boolean {
  if (from === to) return true;
  const adj = switchAdjacency(topo);
  const seen = new Set<SwitchId>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop() as SwitchId;
    for (const { linkId, to: next } of adj.get(cur) ?? []) {
      if (linkId === excludeLink) continue;
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * The set of active switch-switch links that lie on at least one cycle — i.e.
 * removing the link would leave its endpoints still connected (a parallel path
 * or a longer loop exists). These are exactly the links RSTP must consider
 * blocking; one Alternate port per independent cycle ends up Discarding.
 */
export function cycleLinks(topo: Topology): Set<LinkId> {
  const onCycle = new Set<LinkId>();
  for (const link of topo.links.values()) {
    if (!isSwitch(topo, link.a.device) || !isSwitch(topo, link.b.device)) continue;
    if (!linkActive(topo, link)) continue;
    if (switchesConnected(topo, link.a.device, link.b.device, link.id)) {
      onCycle.add(link.id);
    }
  }
  return onCycle;
}
