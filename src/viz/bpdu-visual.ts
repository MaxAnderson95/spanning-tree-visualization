import * as THREE from "three";
import { BPDU_COLORS, type BpduKind } from "../theme.ts";
import type { BpduFlightView } from "./types.ts";

const TRAIL_POINTS = 14;
const TRAIL_SPAN = 0.22;
const DEATH_COLOR = new THREE.Color(0xff4040);

const HEAD_SCALE: Record<BpduKind, number> = {
  hello: 0.34,
  proposal: 0.44,
  agreement: 0.44,
  tc: 0.4,
};

/**
 * The raised bezier a BPDU travels, pushed sideways so opposing directions get
 * separate lanes (a proposal and its agreement don't overlap). Shared with the
 * fx system so a mid-flight burst lands where the packet died.
 */
export function bpduCurve(
  from: THREE.Vector3,
  to: THREE.Vector3,
  laneSign: number,
): THREE.QuadraticBezierCurve3 {
  const a = from.clone();
  a.y = 0.2;
  const b = to.clone();
  b.y = 0.2;
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const along = b.clone().sub(a).normalize();
  const perp = new THREE.Vector3(-along.z, 0, along.x);
  const span = a.distanceTo(b);
  const control = mid
    .add(new THREE.Vector3(0, 0.7 + span * 0.14, 0))
    .add(perp.multiplyScalar(laneSign * 0.42));
  return new THREE.QuadraticBezierCurve3(a, control, b);
}

export interface BpduTextures {
  readonly glow: THREE.Texture;
  readonly ring: THREE.Texture;
}

/** A BPDU travelling along a raised arc; the trail samples the curve so it
 *  renders correctly even when time is scrubbed backwards. */
export class BpduVisual {
  readonly group = new THREE.Group();

  private curve: THREE.QuadraticBezierCurve3;
  private readonly head: THREE.Sprite;
  private readonly selection: THREE.Sprite;
  private readonly trail: THREE.Line;
  private readonly trailPositions: Float32Array;
  private readonly baseColor: THREE.Color;

  constructor(
    kind: BpduKind,
    from: THREE.Vector3,
    to: THREE.Vector3,
    textures: BpduTextures,
    laneSign: number,
  ) {
    this.curve = bpduCurve(from, to, laneSign);
    const color = new THREE.Color(BPDU_COLORS[kind]);
    this.baseColor = color.clone();

    this.head = new THREE.Sprite(
      new THREE.SpriteMaterial({
        // A topology-change BPDU flies as a hollow ring (a warning beacon);
        // everything else is a solid glow.
        map: kind === "tc" ? textures.ring : textures.glow,
        color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.head.scale.setScalar(HEAD_SCALE[kind]);
    this.group.add(this.head);

    this.selection = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: textures.ring,
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.selection.scale.setScalar(HEAD_SCALE[kind] * 2.6);
    this.selection.visible = false;
    this.group.add(this.selection);

    this.trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const trailColors = new Float32Array(TRAIL_POINTS * 3);
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      const fade = (i / (TRAIL_POINTS - 1)) ** 1.6;
      trailColors[i * 3] = color.r * fade;
      trailColors[i * 3 + 1] = color.g * fade;
      trailColors[i * 3 + 2] = color.b * fade;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.trailPositions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
    this.trail = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.group.add(this.trail);
  }

  /** Re-aim the arc (endpoints may move as devices are dragged). */
  retarget(from: THREE.Vector3, to: THREE.Vector3, laneSign: number): void {
    this.curve = bpduCurve(from, to, laneSign);
  }

  apply(view: BpduFlightView): void {
    const p = Math.min(Math.max(view.progress, 0), 1);
    const headPos = this.curve.getPoint(p);
    this.head.position.copy(headPos);
    this.selection.position.copy(headPos);

    if (view.dying) {
      const redness = Math.min(Math.max((p - 0.2) / 0.3, 0), 1);
      this.head.material.color.copy(this.baseColor).lerp(DEATH_COLOR, redness);
    } else {
      this.head.material.color.copy(this.baseColor);
    }

    const tailStart = Math.max(0, p - TRAIL_SPAN);
    const scratch = new THREE.Vector3();
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      const t = tailStart + ((p - tailStart) * i) / (TRAIL_POINTS - 1);
      this.curve.getPoint(t, scratch);
      this.trailPositions[i * 3] = scratch.x;
      this.trailPositions[i * 3 + 1] = scratch.y;
      this.trailPositions[i * 3 + 2] = scratch.z;
    }
    (this.trail.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  pointAt(progress: number): THREE.Vector3 {
    return this.curve.getPoint(Math.min(Math.max(progress, 0), 1));
  }

  worldHead(target: THREE.Vector3): THREE.Vector3 {
    return this.head.getWorldPosition(target);
  }

  setSelected(on: boolean): void {
    this.selection.visible = on;
  }

  dispose(): void {
    this.head.material.dispose();
    this.selection.material.dispose();
    this.trail.geometry.dispose();
    (this.trail.material as THREE.Material).dispose();
  }
}
