/**
 * Core types for the spanning-tree library (IEEE 802.1D STP + 802.1w RSTP).
 *
 * This library is **sans-I/O** and **port-local**: it never touches timers,
 * the network, the DOM, or `Math.random` directly, and a bridge knows only its
 * own ports and the last BPDU heard on each — exactly like a real 802.1w bridge,
 * which is specified as a set of per-port state machines. The host (the
 * simulator) drives every bridge by advancing time, delivering BPDUs, and
 * supplying a seeded RNG. Same inputs ⇒ same run, so the core is deterministic
 * and testable without mocks.
 *
 * Everything is in **seconds** — the protocol's native scale (Hello 2 s,
 * Forward Delay 15 s, Max Age 20 s).
 */

import type { PortId } from "../model/types.ts";

export type { PortId };

export type ProtocolMode = "stp" | "rstp";

/** Bridge ID = 16-bit priority ‖ 48-bit MAC. Lower is better. */
export interface BridgeId {
  /** 0…61440 in steps of 4096 (the system-ID-extension/VLAN field is fixed 0). */
  readonly priority: number;
  /** "00:00:00:00:00:01" — the tiebreaker when priorities are equal. */
  readonly mac: string;
}

/** Port ID used in priority vectors: 4-bit-ish priority ‖ port number. Lower is better. */
export interface PortVectorId {
  /** Port priority, 0…240 in steps of 16 (default 128). */
  readonly priority: number;
  /** Per-bridge port ordinal (P1 → 1). */
  readonly num: number;
}

/**
 * The 802.1 priority vector that decides root, path, and roles. Compared
 * lexicographically: root bridge, then path cost, then designated bridge, then
 * designated port.
 */
export interface PriorityVector {
  readonly rootId: BridgeId;
  readonly rootPathCost: number;
  readonly designatedBridgeId: BridgeId;
  readonly designatedPortId: PortVectorId;
}

export type PortRole = "root" | "designated" | "alternate" | "disabled";

/** Unified state set. RSTP uses discarding/learning/forwarding; STP adds the classic gates. */
export type PortState =
  | "disabled"
  | "blocking"
  | "listening"
  | "learning"
  | "forwarding"
  | "discarding";

export interface BpduFlags {
  readonly topologyChange: boolean;
  readonly topologyChangeAck: boolean;
  /** RSTP: the designated port is proposing to go forwarding. */
  readonly proposal: boolean;
  /** RSTP: the receiver agrees, unblocking the proposer immediately. */
  readonly agreement: boolean;
  /** RSTP port state of the sender. */
  readonly learning: boolean;
  readonly forwarding: boolean;
  /** RSTP role of the sending port. */
  readonly portRole: PortRole;
}

export type BpduType = "config" | "tcn" | "rst";

/** A Bridge Protocol Data Unit — the only thing bridges ever exchange. */
export interface Bpdu {
  readonly version: ProtocolMode;
  readonly type: BpduType;
  readonly rootId: BridgeId;
  readonly rootPathCost: number;
  readonly senderBridgeId: BridgeId;
  readonly senderPortId: PortVectorId;
  readonly flags: BpduFlags;
  /** Hops from the root; ages the stored info toward Max Age. */
  readonly messageAge: number;
  readonly maxAge: number;
  readonly helloTime: number;
  readonly forwardDelay: number;
}

/** The protocol's three timers (seconds). */
export interface Timing {
  readonly helloTime: number;
  readonly forwardDelay: number;
  readonly maxAge: number;
}

export const DEFAULT_TIMING: Timing = {
  helloTime: 2,
  forwardDelay: 15,
  maxAge: 20,
};

// ---------------------------------------------------------------------------
// Semantic events — emitted so the host can narrate / animate what happened
// ---------------------------------------------------------------------------

export type StpEvent =
  | { readonly type: "rootChanged"; readonly rootId: BridgeId; readonly wasRoot: boolean }
  | { readonly type: "becameRoot" }
  | {
      readonly type: "roleChanged";
      readonly portId: PortId;
      readonly from: PortRole;
      readonly to: PortRole;
    }
  | {
      readonly type: "stateChanged";
      readonly portId: PortId;
      readonly from: PortState;
      readonly to: PortState;
    }
  | { readonly type: "proposing"; readonly portId: PortId }
  | { readonly type: "agreed"; readonly portId: PortId }
  | { readonly type: "topologyChange"; readonly portId: PortId | null }
  | { readonly type: "infoExpired"; readonly portId: PortId }
  | { readonly type: "edgeLost"; readonly portId: PortId };

/** Everything a bridge wants the host to do after one input. */
export interface StepResult {
  /** BPDUs to transmit; the host delivers them across links (and may lose them). */
  readonly bpdus: readonly { readonly portId: PortId; readonly bpdu: Bpdu }[];
  /** Semantic events for narration / visualization. */
  readonly events: readonly StpEvent[];
}

export const EMPTY_STEP: StepResult = { bpdus: [], events: [] };

// ---------------------------------------------------------------------------
// Construction & introspection
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  readonly id: BridgeId;
  readonly mode: ProtocolMode;
  readonly now: number;
  readonly timing?: Partial<Timing>;
  /** Seeded RNG in [0,1). Injected for determinism; used sparingly. */
  readonly rng?: () => number;
}

export interface AddPortOptions {
  /** Per-bridge port ordinal (P1 → 1); feeds the designated-port-id field. */
  readonly num: number;
  readonly cost: number;
  readonly priority: number;
  /** A port to an end host: PortFast in RSTP, excluded from sync. */
  readonly edge: boolean;
  /** Is the link up right now? Defaults true. */
  readonly enabled?: boolean;
}

/** Immutable per-port view. */
export interface PortSnapshot {
  readonly id: PortId;
  readonly num: number;
  readonly role: PortRole;
  readonly state: PortState;
  readonly cost: number;
  readonly priority: number;
  readonly edge: boolean;
  readonly enabled: boolean;
  /** Seconds left on the forward-delay gate, or null when not transitioning. */
  readonly forwardTimer: number | null;
  /** Seconds until the stored info expires (Max Age / 3×Hello), or null. */
  readonly ageTimer: number | null;
  readonly proposing: boolean;
  readonly agreed: boolean;
  /** The last BPDU heard on this port (for the BPDU inspector), or null. */
  readonly lastBpdu: Bpdu | null;
}

/** A complete, immutable view of a bridge's state. Cheap to take every event. */
export interface BridgeSnapshot {
  readonly id: BridgeId;
  readonly mode: ProtocolMode;
  readonly rootId: BridgeId;
  readonly rootPathCost: number;
  readonly isRoot: boolean;
  readonly rootPortId: PortId | null;
  readonly timing: Timing;
  readonly ports: readonly PortSnapshot[];
}
