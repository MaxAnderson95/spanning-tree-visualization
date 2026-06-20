import * as THREE from "three";
import type { PortRole } from "../spanning-tree/index.ts";
import { ROLE_CSS, ROLE_LABEL, stateColor, STATE_COLORS } from "../theme.ts";
import type { LinkEndView, LinkView } from "./types.ts";

const CABLE_Y = 0.18;
const CABLE_RADIUS = 0.05;
const BADGE_INSET = 0.26; // fraction in from each end

/** Depleting-arc shader for a port's countdown ring (forward-delay / aging). */
const RING_VERT = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFraction;
  uniform float uOpacity;
  varying vec2 vPos;
  const float TAU = 6.28318530718;
  void main() {
    float angle = atan(-vPos.x, vPos.y);
    float a = mod(angle / TAU + 1.0, 1.0);
    if (a > uFraction) discard;
    gl_FragColor = vec4(uColor, uOpacity);
  }
`;

export interface LinkContext {
  readonly glow: THREE.Texture;
  readonly badge: Map<PortRole, THREE.Texture>;
  readonly barrier: THREE.Texture;
  readonly ringGeo: THREE.RingGeometry;
}

function roleBadgeTexture(role: PortRole): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 44px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ROLE_LABEL[role], 64, 34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function barrierTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    // A bold "no-entry" slash bar.
    ctx.beginPath();
    ctx.moveTo(14, 50);
    ctx.lineTo(50, 14);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(14, 14);
    ctx.lineTo(50, 50);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createLinkContext(glow: THREE.Texture): LinkContext {
  const badge = new Map<PortRole, THREE.Texture>();
  for (const role of ["root", "designated", "alternate", "disabled"] as const) {
    badge.set(role, roleBadgeTexture(role));
  }
  return {
    glow,
    badge,
    barrier: barrierTexture(),
    ringGeo: new THREE.RingGeometry(0.26, 0.36, 40),
  };
}

const UP = new THREE.Vector3(0, 1, 0);

/** Orient + size a unit-cylinder (default along Y) to span `from`→`to`. */
function spanCylinder(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length() || 0.0001;
  mesh.position.copy(from).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
  mesh.scale.set(1, len, 1);
}

/** One end's fittings: a colored cable half, a role badge, a barrier, a timer ring. */
class EndFittings {
  readonly half: THREE.Mesh;
  readonly mat: THREE.MeshStandardMaterial;
  readonly badge: THREE.Sprite;
  readonly barrier: THREE.Sprite;
  readonly ring: THREE.Mesh;
  readonly ringMat: THREE.ShaderMaterial;
  private readonly ctx: LinkContext;

  constructor(ctx: LinkContext, group: THREE.Group, radius: number) {
    this.ctx = ctx;
    this.mat = new THREE.MeshStandardMaterial({
      color: STATE_COLORS.discarding,
      emissive: STATE_COLORS.discarding,
      emissiveIntensity: 0.2,
      roughness: 0.4,
      metalness: 0.1,
    });
    this.half = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 10), this.mat);
    group.add(this.half);

    this.badge = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0.92 }),
    );
    this.badge.scale.set(0.62, 0.31, 1);
    group.add(this.badge);

    this.barrier = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ctx.barrier,
        color: STATE_COLORS.discarding,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    this.barrier.scale.setScalar(0.42);
    group.add(this.barrier);

    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(STATE_COLORS.learning) },
        uFraction: { value: 1 },
        uOpacity: { value: 0 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(ctx.ringGeo, this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    group.add(this.ring);
  }

  /** Update this end: `near` is the device, `mid` the cable midpoint. */
  apply(
    end: LinkEndView,
    near: THREE.Vector3,
    mid: THREE.Vector3,
    cut: boolean,
    highlight: boolean,
  ): void {
    spanCylinder(this.half, near, mid);

    // A cut/down link stays visibly *there* but severed: dim red, low glow.
    const color = cut ? STATE_COLORS.discarding : stateColor(end.state);
    this.mat.color.setHex(color);
    this.mat.emissive.setHex(color);
    const base = cut
      ? 0.18
      : end.state === "forwarding"
        ? 1.3
        : end.state === "learning"
          ? 0.7
          : 0.12;
    // Hover-tracing a physical cycle brightens every rung of the loop.
    this.mat.emissiveIntensity = highlight ? base + 0.8 : base;
    this.mat.transparent = cut;
    this.mat.opacity = cut ? 0.42 : 1;

    // Role badge sits a little in from the device end, lifted above the cable.
    const badgePos = near.clone().lerp(mid, BADGE_INSET);
    badgePos.y += 0.34;
    this.badge.position.copy(badgePos);
    const tex = this.ctx.badge.get(end.role) ?? null;
    if (this.badge.material.map !== tex) this.badge.material.map = tex;
    this.badge.material.color.set(ROLE_CSS[end.role]);
    this.badge.visible = !cut && end.role !== "disabled";

    // Barrier: the unmistakable blocked rung — a non-edge discarding end.
    const blocked = !cut && end.state === "discarding" && end.role === "alternate";
    this.barrier.position.copy(near.clone().lerp(mid, 0.5));
    this.barrier.position.y += 0.32;
    this.barrier.material.opacity = blocked ? 1 : 0;
    this.barrier.visible = blocked;

    // Timer ring at the device end.
    const ringPos = near.clone().lerp(mid, 0.16);
    this.ring.position.set(ringPos.x, 0.06, ringPos.z);
    const frac = end.timerFraction;
    if (frac !== null && !cut) {
      this.ringMat.uniforms.uOpacity!.value = 0.9;
      this.ringMat.uniforms.uFraction!.value = frac;
      (this.ringMat.uniforms.uColor!.value as THREE.Color).setHex(
        end.timerKind === "age" ? STATE_COLORS.discarding : STATE_COLORS.learning,
      );
      this.ring.visible = true;
    } else {
      this.ringMat.uniforms.uOpacity!.value = 0;
      this.ring.visible = false;
    }
  }

  dispose(): void {
    this.half.geometry.dispose();
    this.mat.dispose();
    this.badge.material.dispose();
    this.barrier.material.dispose();
    this.ringMat.dispose();
  }
}

/** A link drawn as a raised iso cable, each end showing its port role + state. */
export class LinkVisual {
  readonly group = new THREE.Group();
  readonly pick: THREE.Mesh;

  private readonly endA: EndFittings;
  private readonly endB: EndFittings;
  private readonly pickMat: THREE.MeshBasicMaterial;

  constructor(ctx: LinkContext) {
    this.endA = new EndFittings(ctx, this.group, CABLE_RADIUS);
    this.endB = new EndFittings(ctx, this.group, CABLE_RADIUS);

    // A fat invisible cylinder along the whole cable for forgiving click-picking.
    this.pickMat = new THREE.MeshBasicMaterial({ visible: false });
    this.pick = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1, 8), this.pickMat);
    this.group.add(this.pick);
  }

  apply(view: LinkView, aPos: THREE.Vector3, bPos: THREE.Vector3, highlight = false): void {
    const a = aPos.clone();
    a.y = CABLE_Y;
    const b = bPos.clone();
    b.y = CABLE_Y;
    const mid = a.clone().lerp(b, 0.5);

    this.endA.apply(view.a, a, mid, view.cut, highlight);
    this.endB.apply(view.b, b, mid, view.cut, highlight);
    spanCylinder(this.pick, a, b);
  }

  dispose(): void {
    this.endA.dispose();
    this.endB.dispose();
    this.pick.geometry.dispose();
    this.pickMat.dispose();
  }
}
