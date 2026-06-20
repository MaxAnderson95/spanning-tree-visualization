/**
 * Topology model types: the editable switched network as plain, serializable
 * data. This module is dependency-free and sans-runtime — it knows nothing of
 * the simulator, the spanning-tree core, Three.js, or the DOM. It is the unit
 * of save / share (§11) and the shared vocabulary between `sim` and the editor.
 *
 * Ports are *derived*: a device's ports are exactly the link ends that point at
 * it, numbered in the order their links were drawn (P1, P2, …). There is no
 * standalone port record — a port exists because a link uses it.
 */

export type SwitchId = string; // "s1", "s2", …
export type HostId = string; // "h1", "h2", …
export type DeviceId = SwitchId;
export type LinkId = string; // "l1", "l2", …

/** Globally unique port identifier, `${device}#${portNum}` e.g. "s1#2". */
export type PortId = string;

/** Logical isometric grid position. The renderer maps this to world space. */
export interface IsoPos {
  x: number;
  y: number;
}

/** Link speeds we model, in Mbps. Each maps to a classic IEEE short cost. */
export type LinkSpeed = 10 | 100 | 1000 | 10000;

export interface SwitchConfig {
  readonly id: SwitchId;
  label: string;
  /** Bridge priority: 0…61440 in steps of 4096. Default 32768. */
  priority: number;
  /** Auto-assigned, deterministic, displayed; not user-editable (§14). */
  readonly mac: string;
  /** Reversible failure: a powered-off switch drops all its links. */
  powered: boolean;
  pos: IsoPos;
}

export interface HostConfig {
  readonly id: HostId;
  label: string;
  readonly mac: string;
  pos: IsoPos;
}

/** One end of a link: a device and the port ordinal allocated on it. */
export interface LinkEnd {
  readonly device: DeviceId;
  /** 1-based port number on `device`, assigned when the link was drawn. */
  readonly portNum: number;
}

export interface LinkConfig {
  readonly id: LinkId;
  readonly a: LinkEnd;
  readonly b: LinkEnd;
  speed: LinkSpeed;
  /** Per-end path cost override; falls back to the speed's default cost. */
  costA: number | null;
  costB: number | null;
  /** Per-end port priority (0…240, step 16). Default 128. */
  portPriorityA: number;
  portPriorityB: number;
  /** Reversible failure: a cut link drops BPDUs in both directions. */
  cut: boolean;
}

/** Runtime topology: Maps for fast lookup. Mutated in place by the simulator. */
export interface Topology {
  readonly switches: Map<SwitchId, SwitchConfig>;
  readonly hosts: Map<HostId, HostConfig>;
  readonly links: Map<LinkId, LinkConfig>;
}

/** JSON-friendly snapshot of a topology for export / import (§11). */
export interface SerializedTopology {
  readonly switches: readonly SwitchConfig[];
  readonly hosts: readonly HostConfig[];
  readonly links: readonly LinkConfig[];
}

// ---------------------------------------------------------------------------
// Constants & small pure helpers
// ---------------------------------------------------------------------------

export const BRIDGE_PRIORITY_STEP = 4096;
export const DEFAULT_BRIDGE_PRIORITY = 32768;
export const MAX_BRIDGE_PRIORITY = 61440;

export const PORT_PRIORITY_STEP = 16;
export const DEFAULT_PORT_PRIORITY = 128;
export const MAX_PORT_PRIORITY = 240;

export const DEFAULT_LINK_SPEED: LinkSpeed = 1000;

/** Classic IEEE 802.1D short path-cost table, keyed by link speed (Mbps). */
const SHORT_COST: Record<LinkSpeed, number> = {
  10: 100,
  100: 19,
  1000: 4,
  10000: 2,
};

export function defaultCostForSpeed(speed: LinkSpeed): number {
  return SHORT_COST[speed];
}

export function makePortId(device: DeviceId, portNum: number): PortId {
  return `${device}#${portNum}`;
}

export function portIdOf(end: LinkEnd): PortId {
  return makePortId(end.device, end.portNum);
}

export function parsePortId(portId: PortId): { device: DeviceId; portNum: number } {
  const hash = portId.lastIndexOf("#");
  return { device: portId.slice(0, hash), portNum: Number(portId.slice(hash + 1)) };
}

/** Human label for a port, e.g. "P2". */
export function portLabel(portNum: number): string {
  return `P${portNum}`;
}

/** Format an integer as a 48-bit MAC, e.g. 1 → "00:00:00:00:00:01". */
export function formatMac(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return (hex.match(/.{2}/g) ?? []).join(":");
}

/** Short, label-friendly MAC tail, e.g. "…00:01". */
export function shortMac(mac: string): string {
  const parts = mac.split(":");
  return parts.slice(-2).join(":");
}
