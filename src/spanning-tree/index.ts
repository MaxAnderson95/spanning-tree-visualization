/**
 * spanning-tree: a dependency-free, deterministic, sans-I/O implementation of
 * IEEE 802.1D (STP) and 802.1w (RSTP) as one internally-factored, port-local
 * bridge (ADR-0003). This directory imports nothing from the rest of the app
 * (no sim, viz, ui, timers, DOM, or network) and can be lifted out and reused
 * as-is.
 */

export { Bridge } from "./bridge.ts";
export {
  bridgeIdEquals,
  compareBridgeId,
  comparePortId,
  compareVector,
  vectorEquals,
} from "./vector.ts";
export {
  DEFAULT_TIMING,
  EMPTY_STEP,
  type AddPortOptions,
  type Bpdu,
  type BpduFlags,
  type BpduType,
  type BridgeId,
  type BridgeOptions,
  type BridgeSnapshot,
  type PortId,
  type PortRole,
  type PortSnapshot,
  type PortState,
  type PortVectorId,
  type PriorityVector,
  type ProtocolMode,
  type StepResult,
  type StpEvent,
  type Timing,
} from "./types.ts";
