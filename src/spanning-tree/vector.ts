/**
 * The priority-vector substrate shared by both protocol modes (ADR-0003).
 * Root election, path costing, and port-role tiebreaks are *all* defined by
 * comparing these vectors — so STP and RSTP can never disagree on who is root
 * or how far away it is. Smaller compares "better" everywhere.
 */

import type { BridgeId, PortVectorId, PriorityVector } from "./types.ts";

/** Compare two Bridge IDs: priority first, then MAC. <0 means `a` is superior. */
export function compareBridgeId(a: BridgeId, b: BridgeId): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0;
}

export function bridgeIdEquals(a: BridgeId, b: BridgeId): boolean {
  return a.priority === b.priority && a.mac === b.mac;
}

/** Compare two Port IDs: priority first, then port number. */
export function comparePortId(a: PortVectorId, b: PortVectorId): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.num - b.num;
}

/**
 * Compare two priority vectors lexicographically (802.1Q §17.6): root bridge,
 * root path cost, designated bridge, designated port. <0 means `a` is superior.
 */
export function compareVector(a: PriorityVector, b: PriorityVector): number {
  const root = compareBridgeId(a.rootId, b.rootId);
  if (root !== 0) return root;
  if (a.rootPathCost !== b.rootPathCost) return a.rootPathCost - b.rootPathCost;
  const dsg = compareBridgeId(a.designatedBridgeId, b.designatedBridgeId);
  if (dsg !== 0) return dsg;
  return comparePortId(a.designatedPortId, b.designatedPortId);
}

export function vectorEquals(a: PriorityVector, b: PriorityVector): boolean {
  return compareVector(a, b) === 0;
}
