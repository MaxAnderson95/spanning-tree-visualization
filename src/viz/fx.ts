import * as THREE from "three";
import { BPDU_COLORS, ROOT_GOLD, STATE_COLORS } from "../theme.ts";

/** A transient one-shot effect. Returns false from update() when finished. */
export interface Fx {
  readonly object: THREE.Object3D;
  update(dt: number): boolean;
  dispose(): void;
}

export type FxKind = "rootElected" | "forwarding" | "block" | "roleFlip" | "tcWave" | "fizzle";

/** Expanding ground ring. */
class RippleFx implements Fx {
  readonly object: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private life = 0;
  private readonly duration: number;
  private readonly maxScale: number;

  constructor(position: THREE.Vector3, color: number, duration: number, maxScale: number) {
    this.duration = duration;
    this.maxScale = maxScale;
    this.material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.object = new THREE.Mesh(new THREE.RingGeometry(0.78, 0.9, 56), this.material);
    this.object.rotation.x = -Math.PI / 2;
    this.object.position.copy(position);
    this.object.position.y = 0.03;
  }

  update(dt: number): boolean {
    this.life += dt;
    const t = this.life / this.duration;
    if (t >= 1) return false;
    const eased = 1 - (1 - t) ** 3;
    this.object.scale.setScalar(0.5 + eased * this.maxScale);
    this.material.opacity = 0.85 * (1 - t);
    return true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

interface BurstOptions {
  readonly color?: number;
  readonly duration?: number;
  readonly maxScale?: number;
  readonly rise?: number;
}

/** A brief glowing burst (packet death, role flip pop). */
class BurstFx implements Fx {
  readonly object: THREE.Sprite;
  private life = 0;
  private readonly duration: number;
  private readonly maxScale: number;

  constructor(position: THREE.Vector3, glow: THREE.Texture, options: BurstOptions = {}) {
    this.duration = options.duration ?? 0.5;
    this.maxScale = options.maxScale ?? 1.1;
    this.object = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: options.color ?? 0xffffff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.object.position.copy(position);
    this.object.position.y += options.rise ?? 0.5;
  }

  update(dt: number): boolean {
    this.life += dt;
    const t = this.life / this.duration;
    if (t >= 1) return false;
    this.object.scale.setScalar(0.25 + t * this.maxScale);
    this.object.material.opacity = 0.9 * (1 - t);
    return true;
  }

  dispose(): void {
    this.object.material.dispose();
  }
}

/** A red collapsing ring — a port snapping to Discarding (the loop break). */
class SnapFx implements Fx {
  readonly object: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private life = 0;
  private readonly duration = 0.45;

  constructor(position: THREE.Vector3) {
    this.material = new THREE.MeshBasicMaterial({
      color: STATE_COLORS.discarding,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.object = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.72, 40), this.material);
    this.object.rotation.x = -Math.PI / 2;
    this.object.position.copy(position);
    this.object.position.y = 0.3;
  }

  update(dt: number): boolean {
    this.life += dt;
    const t = this.life / this.duration;
    if (t >= 1) return false;
    // Collapse inward then vanish — a "snap shut".
    this.object.scale.setScalar(1.6 - t * 1.2);
    this.material.opacity = 0.95 * (1 - t);
    return true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

export function createFx(kind: FxKind, position: THREE.Vector3, glow: THREE.Texture): Fx {
  switch (kind) {
    case "rootElected":
      return new RippleFx(position, ROOT_GOLD, 1.2, 4.4);
    case "forwarding":
      return new RippleFx(position, STATE_COLORS.forwarding, 0.7, 2.0);
    case "tcWave":
      return new RippleFx(position, STATE_COLORS.learning, 1.0, 3.6);
    case "block":
      return new SnapFx(position);
    case "roleFlip":
      return new BurstFx(position, glow, {
        color: 0xffffff,
        duration: 0.4,
        maxScale: 1.0,
        rise: 0.4,
      });
    case "fizzle":
      return new BurstFx(position, glow, { color: BPDU_COLORS.tc, duration: 0.55, maxScale: 1.6 });
  }
}
