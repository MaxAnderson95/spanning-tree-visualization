/**
 * Single source of truth for colors, shared between WebGL, canvas drawing, and
 * the DOM. Keep in sync with the CSS custom properties in style.css.
 *
 * The non-negotiable convention for the network-engineer audience: **port state
 * drives color** — Forwarding = green, Learning = amber, Discarding = red/grey —
 * rendered saturated and LED-like. The root bridge is gold. Roles (RP/DP/ALT)
 * are always paired with a badge/shape so meaning never relies on hue alone.
 */

import type { PortState } from "./spanning-tree/index.ts";

/** Deep blue-teal "playground" backdrop — dark enough for bloom to read. */
export const INK = 0x0a1222;

/** Port-state palette (WebGL hex). */
export const STATE_COLORS = {
  forwarding: 0x35d07f,
  learning: 0xf4b73d,
  discarding: 0xff5a52,
  blocking: 0xff5a52,
  listening: 0xf4b73d,
  disabled: 0x46506a,
} as const;

export const STATE_CSS: Record<PortState, string> = {
  forwarding: "#35d07f",
  learning: "#f4b73d",
  discarding: "#ff5a52",
  blocking: "#ff5a52",
  listening: "#f4b73d",
  disabled: "#5b6478",
};

export function stateColor(state: PortState): number {
  return STATE_COLORS[state] ?? STATE_COLORS.disabled;
}

/** The root bridge wears gold. */
export const ROOT_GOLD = 0xffc24b;
export const ROOT_GOLD_CSS = "#ffc24b";

/** Switch chassis & host body base tints (un-rooted). */
export const SWITCH_BODY = 0x33415f;
export const HOST_BODY = 0x6b5bd0;

/** Role badge text colors (RP / DP / ALT). */
export const ROLE_CSS = {
  root: "#5cc8ff",
  designated: "#9be38f",
  alternate: "#ff8f8f",
  disabled: "#5b6478",
} as const;

export const ROLE_LABEL = {
  root: "RP",
  designated: "DP",
  alternate: "ALT",
  disabled: "—",
} as const;

/** BPDU comet palette, keyed by the BPDU's nature (its flags). */
export const BPDU_COLORS = {
  hello: 0x5cc8ff,
  proposal: 0xc77dff,
  agreement: 0x35d07f,
  tc: 0xff7a45,
} as const;

export type BpduKind = keyof typeof BPDU_COLORS;

export const DANGER = "#ff5a52";

/** Convert a 0xRRGGBB number to a "#rrggbb" string. */
export function hexCss(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

export const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
