import type { IsoPos } from "../model/index.ts";
import type { Bpdu, PortRole, PortState } from "../spanning-tree/index.ts";
import type { BpduKind } from "../theme.ts";

/** One end of a link, as the scene needs to draw it. */
export interface LinkEndView {
  readonly portId: string;
  readonly deviceId: string;
  readonly num: number;
  readonly role: PortRole;
  readonly state: PortState;
  readonly edge: boolean;
  /** 0..1 remaining fraction of an active timer, or null. */
  readonly timerFraction: number | null;
  /** What the timer is counting: forward-delay vs info-age. */
  readonly timerKind: "fd" | "age" | null;
}

export interface LinkView {
  readonly id: string;
  readonly a: LinkEndView;
  readonly b: LinkEndView;
  readonly cut: boolean;
  /** Lies on a physical cycle (for the loop-highlight on hover). */
  readonly onCycle: boolean;
  readonly selected: boolean;
}

export interface SwitchView {
  readonly id: string;
  readonly pos: IsoPos;
  readonly powered: boolean;
  readonly isRoot: boolean;
  readonly label: string;
  /** Bridge ID line, e.g. "32768 · 00:01". */
  readonly sub: string;
  readonly selected: boolean;
}

export interface HostView {
  readonly id: string;
  readonly pos: IsoPos;
  readonly label: string;
  readonly selected: boolean;
}

/** A BPDU in flight at the playhead instant. */
export interface BpduFlightView {
  readonly id: number;
  readonly kind: BpduKind;
  readonly fromDevice: string;
  readonly toDevice: string;
  readonly linkId: string;
  /** 0 at sender, 1 at receiver. */
  readonly progress: number;
  readonly dying: boolean;
  readonly bpdu: Bpdu;
}

/** One-shot effect to spawn this render frame. */
export type FxSpawn =
  | { readonly kind: "rootElected"; readonly deviceId: string }
  | { readonly kind: "roleFlip"; readonly deviceId: string; readonly portId: string }
  | { readonly kind: "forwarding"; readonly linkId: string }
  | { readonly kind: "block"; readonly deviceId: string; readonly portId: string }
  | { readonly kind: "tcWave"; readonly deviceId: string }
  | {
      readonly kind: "burst";
      readonly fromDevice: string;
      readonly toDevice: string;
      readonly progress: number;
    };

/** Everything the scene needs to draw one frame. */
export interface RenderView {
  readonly switches: readonly SwitchView[];
  readonly hosts: readonly HostView[];
  readonly links: readonly LinkView[];
  readonly flights: readonly BpduFlightView[];
  readonly fx: readonly FxSpawn[];
  /** Bumped on backward scrub — live effects are stale, clear them. */
  readonly fxEpoch: number;
  readonly islandCount: number;
  readonly selectedFlight: number | null;
}
