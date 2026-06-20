/**
 * model: the editable switched-network topology as plain, serializable data,
 * plus pure graph operations over it. Dependency-free — imports nothing from
 * sim, viz, ui, or the spanning-tree core.
 */

export * from "./types.ts";
export {
  cycleLinks,
  deviceExists,
  devicePowered,
  farEnd,
  islandCount,
  isHost,
  isSwitch,
  linkActive,
  linksOn,
  maxPortNum,
  switchIslands,
} from "./graph.ts";
export {
  addHost,
  addLink,
  addSwitch,
  cloneTopology,
  defaultTopology,
  deserializeTopology,
  emptyTopology,
  hostOnPort,
  removeDevice,
  removeLink,
  serializeTopology,
} from "./topology.ts";
