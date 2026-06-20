/**
 * Topology construction & mutation. Everything here keeps {@link Topology} a
 * pile of plain data: ids and MACs are derived deterministically from what
 * already exists, so a fresh build and a deserialized one behave identically,
 * and `?seed`-reproducible runs never depend on hidden counters.
 */

import { farEnd, linksOn, maxPortNum } from "./graph.ts";
import {
  DEFAULT_BRIDGE_PRIORITY,
  DEFAULT_LINK_SPEED,
  DEFAULT_PORT_PRIORITY,
  formatMac,
  type DeviceId,
  type HostConfig,
  type HostId,
  type IsoPos,
  type LinkConfig,
  type LinkId,
  type LinkSpeed,
  type SerializedTopology,
  type SwitchConfig,
  type Topology,
} from "./types.ts";

export function emptyTopology(): Topology {
  return { switches: new Map(), hosts: new Map(), links: new Map() };
}

/** Next free ordinal id for a prefix, e.g. nextId("s", switches) → "s5". */
function nextId(prefix: string, keys: Iterable<string>): string {
  let max = 0;
  for (const key of keys) {
    if (key.startsWith(prefix)) max = Math.max(max, Number(key.slice(prefix.length)) || 0);
  }
  return `${prefix}${max + 1}`;
}

interface AddSwitchOptions {
  label?: string;
  priority?: number;
  powered?: boolean;
}

export function addSwitch(
  topo: Topology,
  pos: IsoPos,
  options: AddSwitchOptions = {},
): SwitchConfig {
  const id = nextId("s", topo.switches.keys());
  const ordinal = Number(id.slice(1));
  const sw: SwitchConfig = {
    id,
    label: options.label ?? id.toUpperCase(),
    priority: options.priority ?? DEFAULT_BRIDGE_PRIORITY,
    // Switch MACs are ordered by ordinal so root election is predictable.
    mac: formatMac(ordinal),
    powered: options.powered ?? true,
    pos: { ...pos },
  };
  topo.switches.set(id, sw);
  return sw;
}

export function addHost(topo: Topology, pos: IsoPos, options: { label?: string } = {}): HostConfig {
  const id = nextId("h", topo.hosts.keys());
  const ordinal = Number(id.slice(1));
  const host: HostConfig = {
    id,
    label: options.label ?? id.toUpperCase(),
    // Hosts sit in a separate MAC range; they never run the protocol.
    mac: formatMac(0x010000 + ordinal),
    pos: { ...pos },
  };
  topo.hosts.set(id, host);
  return host;
}

interface AddLinkOptions {
  speed?: LinkSpeed;
}

/**
 * Draw a link between two devices, allocating the next port number on each end.
 * Returns null if the two devices are the same or either is missing.
 */
export function addLink(
  topo: Topology,
  deviceA: DeviceId,
  deviceB: DeviceId,
  options: AddLinkOptions = {},
): LinkConfig | null {
  if (deviceA === deviceB) return null;
  const a = topo.switches.get(deviceA) ?? topo.hosts.get(deviceA);
  const b = topo.switches.get(deviceB) ?? topo.hosts.get(deviceB);
  if (!a || !b) return null;

  const id = nextId("l", topo.links.keys());
  const link: LinkConfig = {
    id,
    a: { device: deviceA, portNum: maxPortNum(topo, deviceA) + 1 },
    b: { device: deviceB, portNum: maxPortNum(topo, deviceB) + 1 },
    speed: options.speed ?? DEFAULT_LINK_SPEED,
    costA: null,
    costB: null,
    portPriorityA: DEFAULT_PORT_PRIORITY,
    portPriorityB: DEFAULT_PORT_PRIORITY,
    cut: false,
  };
  topo.links.set(id, link);
  return link;
}

export function removeLink(topo: Topology, id: LinkId): boolean {
  return topo.links.delete(id);
}

/** Remove a device and every link that touched it. */
export function removeDevice(topo: Topology, id: DeviceId): boolean {
  const existed = topo.switches.delete(id) || topo.hosts.delete(id);
  if (!existed) return false;
  for (const link of linksOn(topo, id)) topo.links.delete(link.id);
  return true;
}

/** The host attached to a given switch port, if the far end is a host. */
export function hostOnPort(topo: Topology, link: LinkConfig, device: DeviceId): HostId | null {
  const far = farEnd(link, device);
  if (far && topo.hosts.has(far.device)) return far.device;
  return null;
}

// ---------------------------------------------------------------------------
// The built-in default network: a 4-switch loop + 2 hosts (§5.7, §9)
// ---------------------------------------------------------------------------

/**
 * A square loop of four switches with two attached hosts — the smallest
 * topology that shows the whole story: a root is elected (S1, lowest Bridge
 * ID), three links forward, and exactly one Alternate port blocks to break the
 * single loop. Hosts hang off non-root switches so their edge ports visibly
 * stay up during a sync.
 */
export function defaultTopology(): Topology {
  const topo = emptyTopology();
  const s1 = addSwitch(topo, { x: -3, y: -3 }); // top-left  → root
  const s2 = addSwitch(topo, { x: 3, y: -3 }); // top-right
  const s3 = addSwitch(topo, { x: 3, y: 3 }); // bottom-right
  const s4 = addSwitch(topo, { x: -3, y: 3 }); // bottom-left

  addLink(topo, s1.id, s2.id); // top edge
  addLink(topo, s2.id, s3.id); // right edge
  addLink(topo, s3.id, s4.id); // bottom edge
  addLink(topo, s4.id, s1.id); // left edge → closes the loop

  const h1 = addHost(topo, { x: 7, y: 4 });
  const h2 = addHost(topo, { x: -7, y: 4 });
  addLink(topo, s3.id, h1.id);
  addLink(topo, s4.id, h2.id);

  return topo;
}

// ---------------------------------------------------------------------------
// Serialization (§11)
// ---------------------------------------------------------------------------

export function serializeTopology(topo: Topology): SerializedTopology {
  return {
    switches: [...topo.switches.values()].map((s) => ({ ...s, pos: { ...s.pos } })),
    hosts: [...topo.hosts.values()].map((h) => ({ ...h, pos: { ...h.pos } })),
    links: [...topo.links.values()].map((l) => ({ ...l })),
  };
}

export function deserializeTopology(data: SerializedTopology): Topology {
  const topo = emptyTopology();
  for (const s of data.switches) topo.switches.set(s.id, { ...s, pos: { ...s.pos } });
  for (const h of data.hosts) topo.hosts.set(h.id, { ...h, pos: { ...h.pos } });
  for (const l of data.links) topo.links.set(l.id, { ...l });
  return topo;
}

/** Deep copy of a topology (used to seed the simulator without aliasing). */
export function cloneTopology(topo: Topology): Topology {
  return deserializeTopology(serializeTopology(topo));
}
