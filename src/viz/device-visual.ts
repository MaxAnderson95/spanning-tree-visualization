import * as THREE from "three";
import { HOST_BODY, REDUCED_MOTION, ROOT_GOLD, SWITCH_BODY } from "../theme.ts";
import type { HostView, SwitchView } from "./types.ts";

/** Shared geometry/texture resources for every device visual. */
export interface DeviceContext {
  readonly glow: THREE.Texture;
  readonly spark: THREE.Texture;
  readonly switchBody: THREE.BoxGeometry;
  readonly switchTop: THREE.BoxGeometry;
  readonly hostBody: THREE.BoxGeometry;
  readonly selectRing: THREE.RingGeometry;
}

export function createDeviceContext(glow: THREE.Texture, spark: THREE.Texture): DeviceContext {
  return {
    glow,
    spark,
    switchBody: new THREE.BoxGeometry(1.05, 0.34, 1.05),
    switchTop: new THREE.BoxGeometry(0.78, 0.06, 0.78),
    hostBody: new THREE.BoxGeometry(0.6, 0.5, 0.6),
    selectRing: new THREE.RingGeometry(0.86, 0.96, 48),
  };
}

function selectionRing(ctx: DeviceContext): THREE.Mesh {
  const ring = new THREE.Mesh(
    ctx.selectRing,
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.16;
  ring.visible = false;
  return ring;
}

export class SwitchVisual {
  readonly group = new THREE.Group();
  readonly core: THREE.Mesh;

  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly topMat: THREE.MeshStandardMaterial;
  private readonly halo: THREE.Sprite;
  private readonly crown: THREE.Sprite;
  private readonly selectRing: THREE.Mesh;

  private targetBody = new THREE.Color(SWITCH_BODY);
  private targetEmissive = new THREE.Color(0x0a1830);
  private targetHalo = 0.0;
  private targetCrown = 0;
  private targetY = 0;
  private breathe = Math.random() * Math.PI * 2;

  constructor(ctx: DeviceContext) {
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: SWITCH_BODY,
      roughness: 0.55,
      metalness: 0.35,
      emissive: 0x0a1830,
      emissiveIntensity: 0.6,
    });
    this.core = new THREE.Mesh(ctx.switchBody, this.bodyMat);
    this.group.add(this.core);

    this.topMat = new THREE.MeshStandardMaterial({
      color: 0x2a3a5c,
      roughness: 0.4,
      metalness: 0.5,
      emissive: 0x101d34,
      emissiveIntensity: 0.5,
    });
    const top = new THREE.Mesh(ctx.switchTop, this.topMat);
    top.position.y = 0.2;
    this.core.add(top);

    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ctx.glow,
        color: ROOT_GOLD,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.halo.scale.setScalar(2.8);
    this.group.add(this.halo);

    this.crown = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ctx.spark,
        color: ROOT_GOLD,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.crown.scale.setScalar(0.9);
    this.crown.position.y = 0.62;
    this.group.add(this.crown);

    this.selectRing = selectionRing(ctx);
    this.group.add(this.selectRing);
  }

  apply(view: SwitchView): void {
    if (!view.powered) {
      this.targetBody = new THREE.Color(SWITCH_BODY).multiplyScalar(0.3);
      this.targetEmissive = new THREE.Color(0x05080f);
      this.targetHalo = 0;
      this.targetCrown = 0;
      this.targetY = -0.22;
    } else if (view.isRoot) {
      this.targetBody = new THREE.Color(0x5a4a1f);
      this.targetEmissive = new THREE.Color(ROOT_GOLD).multiplyScalar(0.5);
      this.targetHalo = 0.42;
      this.targetCrown = 0.95;
      this.targetY = 0;
    } else {
      this.targetBody = new THREE.Color(SWITCH_BODY);
      this.targetEmissive = new THREE.Color(0x12243f);
      this.targetHalo = 0.12;
      this.targetCrown = 0;
      this.targetY = 0;
    }
    this.selectRing.visible = view.selected;
  }

  animate(dt: number): void {
    const k = 1 - Math.exp(-dt * 9);
    this.bodyMat.color.lerp(this.targetBody, k);
    this.bodyMat.emissive.lerp(this.targetEmissive, k);
    this.topMat.emissive.lerp(this.targetEmissive, k);

    const haloMat = this.halo.material;
    haloMat.opacity += (this.targetHalo - haloMat.opacity) * k;

    this.breathe += dt * 2.1;
    const crownMat = this.crown.material;
    const amp = this.targetCrown > 0 && !REDUCED_MOTION ? 0.12 * Math.sin(this.breathe) : 0;
    crownMat.opacity += (this.targetCrown + amp - crownMat.opacity) * k;
    this.crown.material.rotation += dt * 0.6;

    this.core.position.y += (this.targetY - this.core.position.y) * k;
    this.halo.position.y = this.core.position.y + 0.1;
  }

  dispose(): void {
    this.bodyMat.dispose();
    this.topMat.dispose();
    this.halo.material.dispose();
    this.crown.material.dispose();
    (this.selectRing.material as THREE.Material).dispose();
  }
}

export class HostVisual {
  readonly group = new THREE.Group();
  readonly core: THREE.Mesh;

  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly selectRing: THREE.Mesh;
  private readonly halo: THREE.Sprite;

  constructor(ctx: DeviceContext) {
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: HOST_BODY,
      roughness: 0.5,
      metalness: 0.2,
      emissive: 0x2a1d5a,
      emissiveIntensity: 0.5,
    });
    this.core = new THREE.Mesh(ctx.hostBody, this.bodyMat);
    this.core.rotation.y = Math.PI / 4;
    this.core.position.y = 0.05;
    this.group.add(this.core);

    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ctx.glow,
        color: HOST_BODY,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.halo.scale.setScalar(1.6);
    this.halo.position.y = 0.1;
    this.group.add(this.halo);

    this.selectRing = selectionRing(ctx);
    this.group.add(this.selectRing);
  }

  apply(view: HostView): void {
    this.selectRing.visible = view.selected;
  }

  animate(_dt: number): void {
    void _dt;
  }

  dispose(): void {
    this.bodyMat.dispose();
    this.halo.material.dispose();
    (this.selectRing.material as THREE.Material).dispose();
  }
}
