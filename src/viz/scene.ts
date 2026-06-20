import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { IsoPos } from "../model/index.ts";
import { INK, REDUCED_MOTION, ROOT_GOLD_CSS } from "../theme.ts";
import { BpduVisual, type BpduTextures } from "./bpdu-visual.ts";
import {
  createDeviceContext,
  type DeviceContext,
  HostVisual,
  SwitchVisual,
} from "./device-visual.ts";
import { createFx, type Fx } from "./fx.ts";
import { isoToWorld, worldToIso } from "./iso.ts";
import { createLinkContext, type LinkContext, LinkVisual } from "./link-visual.ts";
import {
  createGlowTexture,
  createRingTexture,
  createSparkTexture,
  createStageTexture,
} from "./textures.ts";
import type { RenderView } from "./types.ts";

const ISO_DIR = new THREE.Vector3(1, 0.92, 1).normalize();
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const FLIGHT_PICK_RADIUS = 34;
const MOVE_THRESHOLD = 6;
const MIN_VIEW = 4;
const MAX_VIEW = 30;

export interface SceneCallbacks {
  onSelectDevice(id: string | null): void;
  onSelectLink(id: string | null): void;
  onSelectFlight(id: number): void;
  onMoveDevice(id: string, pos: IsoPos): void;
  onDrawLink(from: string, to: string): void;
  onBackground(): void;
  onHoverLink(id: string | null): void;
}

type DragMode = "none" | "maybe" | "pan" | "move" | "link";

export class TopologyScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly root: THREE.Group;
  private readonly camera: THREE.OrthographicCamera;
  private readonly composer: EffectComposer;

  private readonly deviceCtx: DeviceContext;
  private readonly linkCtx: LinkContext;
  private readonly bpduTextures: BpduTextures;
  private readonly glow: THREE.Texture;

  private readonly switches = new Map<string, SwitchVisual>();
  private readonly hosts = new Map<string, HostVisual>();
  private readonly links = new Map<string, LinkVisual>();
  private readonly bpdus = new Map<number, BpduVisual>();
  private readonly labels = new Map<string, HTMLElement>();
  private readonly devicePos = new Map<string, IsoPos>();
  private fx: Fx[] = [];
  private fxEpoch = 0;
  private ghost: THREE.Line | null = null;

  private readonly container: HTMLElement;
  private readonly labelLayer: HTMLElement;
  private readonly callbacks: SceneCallbacks;

  // camera control
  private target = new THREE.Vector3(0, 0, 0);
  private viewSize = 11;

  // pointer / gesture state
  private readonly pointer = new THREE.Vector2(99, 99);
  private readonly raycaster = new THREE.Raycaster();
  private dragMode: DragMode = "none";
  private downAt: { x: number; y: number } | null = null;
  private lastPointer = { x: 0, y: 0 };
  private moveDeviceId: string | null = null;
  private linkSourceId: string | null = null;
  private ghostTo: IsoPos | null = null;
  private hoverLink: string | null = null;
  private linkDrawMode = false;
  private elapsed = 0;

  constructor(container: HTMLElement, labelLayer: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.labelLayer = labelLayer;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(INK);
    this.scene.fog = new THREE.FogExp2(INK, 0.012);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
    this.updateCamera();

    this.scene.add(new THREE.AmbientLight(0x6f86c9, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(8, 16, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-8, 6, -10);
    this.scene.add(fill);

    this.glow = createGlowTexture();
    this.deviceCtx = createDeviceContext(this.glow, createSparkTexture());
    this.linkCtx = createLinkContext(this.glow);
    this.bpduTextures = { glow: this.glow, ring: createRingTexture() };

    this.buildFloor();

    const size = new THREE.Vector2(container.clientWidth || 1, container.clientHeight || 1);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(size, 0.6, 0.6, 0.55));
    this.composer.addPass(new OutputPass());

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.bindPointer();
  }

  setLinkDrawMode(on: boolean): void {
    this.linkDrawMode = on;
    this.renderer.domElement.style.cursor = on ? "crosshair" : "default";
    if (!on) this.linkSourceId = null;
  }

  /** Convert the current pointer to a logical grid position (for placing devices). */
  pointerIso(): IsoPos {
    const hit = new THREE.Vector3();
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.ray.intersectPlane(GROUND, hit);
    return worldToIso(hit);
  }

  /** A free-ish grid spot near the view center, for topbar "add" buttons. */
  spawnSpot(index: number): IsoPos {
    const base = worldToIso(this.target);
    const angle = index * 1.2;
    return {
      x: Math.round(base.x + Math.cos(angle) * 4),
      y: Math.round(base.y + Math.sin(angle) * 4),
    };
  }

  // -------------------------------------------------------------------------

  update(view: RenderView, dt: number): void {
    this.elapsed += dt;

    if (view.fxEpoch !== this.fxEpoch) {
      this.fxEpoch = view.fxEpoch;
      for (const fx of this.fx) {
        this.root.remove(fx.object);
        fx.dispose();
      }
      this.fx = [];
    }

    this.reconcileDevices(view, dt);
    this.reconcileLinks(view);
    this.reconcileBpdus(view);
    this.spawnFx(view);
    this.updateGhost();

    this.fx = this.fx.filter((fx) => {
      if (fx.update(dt)) return true;
      this.root.remove(fx.object);
      fx.dispose();
      return false;
    });

    if (!REDUCED_MOTION) this.root.rotation.y = Math.sin(this.elapsed * 0.04) * 0.015;

    this.placeLabels(view);
    this.composer.render();
  }

  worldOf(id: string): THREE.Vector3 {
    const pos = this.devicePos.get(id);
    return pos ? isoToWorld(pos) : new THREE.Vector3();
  }

  // -------------------------------------------------------------------------

  private reconcileDevices(view: RenderView, dt: number): void {
    const seen = new Set<string>();
    this.devicePos.clear();

    for (const sw of view.switches) {
      seen.add(sw.id);
      this.devicePos.set(sw.id, sw.pos);
      let visual = this.switches.get(sw.id);
      if (!visual) {
        visual = new SwitchVisual(this.deviceCtx);
        visual.core.userData.deviceId = sw.id;
        this.switches.set(sw.id, visual);
        this.root.add(visual.group);
        this.createLabel(sw.id, "switch");
      }
      visual.group.position.copy(isoToWorld(sw.pos));
      visual.apply(sw);
      visual.animate(dt);
    }
    for (const host of view.hosts) {
      seen.add(host.id);
      this.devicePos.set(host.id, host.pos);
      let visual = this.hosts.get(host.id);
      if (!visual) {
        visual = new HostVisual(this.deviceCtx);
        visual.core.userData.deviceId = host.id;
        this.hosts.set(host.id, visual);
        this.root.add(visual.group);
        this.createLabel(host.id, "host");
      }
      visual.group.position.copy(isoToWorld(host.pos));
      visual.apply(host);
      visual.animate(dt);
    }

    for (const [id, visual] of this.switches) {
      if (!seen.has(id)) {
        this.root.remove(visual.group);
        visual.dispose();
        this.switches.delete(id);
        this.dropLabel(id);
      }
    }
    for (const [id, visual] of this.hosts) {
      if (!seen.has(id)) {
        this.root.remove(visual.group);
        visual.dispose();
        this.hosts.delete(id);
        this.dropLabel(id);
      }
    }
  }

  private reconcileLinks(view: RenderView): void {
    const seen = new Set<string>();
    // When hovering a link that lies on a cycle, trace the whole loop (§6.3).
    const hovered = this.hoverLink ? view.links.find((l) => l.id === this.hoverLink) : undefined;
    const traceCycle = hovered?.onCycle === true;
    for (const link of view.links) {
      const aPos = this.devicePos.get(link.a.deviceId);
      const bPos = this.devicePos.get(link.b.deviceId);
      if (!aPos || !bPos) continue;
      seen.add(link.id);
      let visual = this.links.get(link.id);
      if (!visual) {
        visual = new LinkVisual(this.linkCtx);
        visual.pick.userData.linkId = link.id;
        this.links.set(link.id, visual);
        this.root.add(visual.group);
      }
      visual.apply(link, isoToWorld(aPos), isoToWorld(bPos), traceCycle && link.onCycle);
    }
    for (const [id, visual] of this.links) {
      if (!seen.has(id)) {
        this.root.remove(visual.group);
        visual.dispose();
        this.links.delete(id);
      }
    }
  }

  private reconcileBpdus(view: RenderView): void {
    const seen = new Set<number>();
    for (const flight of view.flights) {
      const from = this.devicePos.get(flight.fromDevice);
      const to = this.devicePos.get(flight.toDevice);
      if (!from || !to) continue;
      seen.add(flight.id);
      const laneSign = flight.fromDevice < flight.toDevice ? 1 : -1;
      let visual = this.bpdus.get(flight.id);
      if (!visual) {
        visual = new BpduVisual(
          flight.kind,
          isoToWorld(from),
          isoToWorld(to),
          this.bpduTextures,
          laneSign,
        );
        this.bpdus.set(flight.id, visual);
        this.root.add(visual.group);
      } else {
        visual.retarget(isoToWorld(from), isoToWorld(to), laneSign);
      }
      visual.apply(flight);
      visual.setSelected(view.selectedFlight === flight.id);
    }
    for (const [id, visual] of this.bpdus) {
      if (!seen.has(id)) {
        this.root.remove(visual.group);
        visual.dispose();
        this.bpdus.delete(id);
      }
    }
  }

  private spawnFx(view: RenderView): void {
    for (const spawn of view.fx) {
      let pos: THREE.Vector3 | null = null;
      let kind: Parameters<typeof createFx>[0] = "roleFlip";
      switch (spawn.kind) {
        case "rootElected":
          pos = this.deviceWorld(spawn.deviceId);
          kind = "rootElected";
          break;
        case "tcWave":
          pos = this.deviceWorld(spawn.deviceId);
          kind = "tcWave";
          break;
        case "roleFlip":
          pos = this.deviceWorld(spawn.deviceId);
          kind = "roleFlip";
          break;
        case "block":
          pos = this.deviceWorld(spawn.deviceId);
          kind = "block";
          break;
        case "forwarding": {
          pos = this.linkMid(spawn.linkId);
          kind = "forwarding";
          break;
        }
        case "burst": {
          const a = this.devicePos.get(spawn.fromDevice);
          const b = this.devicePos.get(spawn.toDevice);
          if (a && b) pos = isoToWorld(a).lerp(isoToWorld(b), spawn.progress);
          kind = "fizzle";
          break;
        }
      }
      if (!pos) continue;
      const fx = createFx(kind, pos, this.glow);
      this.fx.push(fx);
      this.root.add(fx.object);
    }
  }

  private deviceWorld(id: string): THREE.Vector3 | null {
    const pos = this.devicePos.get(id);
    return pos ? isoToWorld(pos) : null;
  }

  private linkMid(linkId: string): THREE.Vector3 | null {
    const visual = this.links.get(linkId);
    if (!visual) return null;
    return visual.pick.position.clone();
  }

  // -------------------------------------------------------------------------
  // Labels (DOM, projected through the camera)
  // -------------------------------------------------------------------------

  private createLabel(id: string, kind: "switch" | "host"): void {
    const el = document.createElement("button");
    el.className = `node-label ${kind === "host" ? "is-host" : ""}`;
    el.type = "button";
    el.innerHTML = `<div class="node-id"></div><div class="node-sub"></div>`;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      this.callbacks.onSelectDevice(id);
    });
    this.labelLayer.appendChild(el);
    this.labels.set(id, el);
  }

  private dropLabel(id: string): void {
    this.labels.get(id)?.remove();
    this.labels.delete(id);
  }

  private placeLabels(view: RenderView): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const scratch = new THREE.Vector3();
    const byId = new Map<
      string,
      { label: string; sub: string; root: boolean; off: boolean; sel: boolean; host: boolean }
    >();
    for (const sw of view.switches)
      byId.set(sw.id, {
        label: sw.label,
        sub: sw.sub,
        root: sw.isRoot,
        off: !sw.powered,
        sel: sw.selected,
        host: false,
      });
    for (const host of view.hosts)
      byId.set(host.id, {
        label: host.label,
        sub: "host",
        root: false,
        off: false,
        sel: host.selected,
        host: true,
      });

    for (const [id, el] of this.labels) {
      const info = byId.get(id);
      const pos = this.devicePos.get(id);
      if (!info || !pos) {
        el.style.display = "none";
        continue;
      }
      scratch.copy(isoToWorld(pos));
      scratch.y += 0.7;
      scratch.project(this.camera);
      const x = (scratch.x * 0.5 + 0.5) * w;
      const y = (-scratch.y * 0.5 + 0.5) * h;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.display = scratch.z > 1 ? "none" : "";

      const idEl = el.querySelector<HTMLElement>(".node-id");
      const subEl = el.querySelector<HTMLElement>(".node-sub");
      if (idEl) {
        idEl.innerHTML = info.root
          ? `<span class="crown" style="color:${ROOT_GOLD_CSS}">♛</span>${info.label}`
          : info.label;
      }
      if (subEl) subEl.textContent = info.sub;
      el.classList.toggle("is-selected", info.sel);
      el.classList.toggle("is-root", info.root);
      el.classList.toggle("is-off", info.off);
      el.classList.toggle("is-host", info.host);
    }
  }

  // -------------------------------------------------------------------------
  // Camera & resize
  // -------------------------------------------------------------------------

  private buildFloor(): void {
    const stage = new THREE.Mesh(
      new THREE.CircleGeometry(16, 64),
      new THREE.MeshBasicMaterial({
        map: createStageTexture(),
        transparent: true,
        depthWrite: false,
      }),
    );
    stage.rotation.x = -Math.PI / 2;
    stage.position.y = -0.2;
    this.root.add(stage);

    const grid = new THREE.GridHelper(48, 48, 0x223052, 0x18233c);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.y = -0.18;
    this.root.add(grid);
  }

  private updateCamera(): void {
    this.camera.position.copy(this.target).addScaledVector(ISO_DIR, 120);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    this.camera.top = this.viewSize;
    this.camera.bottom = -this.viewSize;
    this.camera.left = -this.viewSize * aspect;
    this.camera.right = this.viewSize * aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  // -------------------------------------------------------------------------
  // Pointer: pan / zoom / select / move / draw-link
  // -------------------------------------------------------------------------

  private bindPointer(): void {
    const dom = this.renderer.domElement;

    dom.addEventListener("pointermove", (e) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.onPointerMove(e);
    });

    dom.addEventListener("pointerdown", (e) => {
      dom.setPointerCapture(e.pointerId);
      this.downAt = { x: e.clientX, y: e.clientY };
      this.lastPointer = { x: e.clientX, y: e.clientY };
      const device = this.pickDevice();
      const link = this.pickLink();
      if (this.linkDrawMode && device) {
        this.dragMode = "link";
        this.linkSourceId = device;
      } else if (device) {
        this.dragMode = "maybe";
        this.moveDeviceId = device;
      } else if (link) {
        this.dragMode = "maybe";
        this.moveDeviceId = null;
      } else {
        this.dragMode = "maybe";
        this.moveDeviceId = null;
      }
    });

    dom.addEventListener("pointerup", (e) => {
      this.onPointerUp(e);
      this.dragMode = "none";
      this.moveDeviceId = null;
      this.linkSourceId = null;
      this.ghostTo = null;
    });

    dom.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.viewSize = THREE.MathUtils.clamp(
          this.viewSize * (1 + e.deltaY * 0.0012),
          MIN_VIEW,
          MAX_VIEW,
        );
        this.resize();
      },
      { passive: false },
    );
  }

  private onPointerMove(e: PointerEvent): void {
    const moved = this.downAt
      ? Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > MOVE_THRESHOLD
      : false;

    if (this.dragMode === "maybe" && moved) {
      this.dragMode = this.moveDeviceId ? "move" : "pan";
    }

    if (this.dragMode === "move" && this.moveDeviceId) {
      this.callbacks.onMoveDevice(this.moveDeviceId, this.pointerIso());
    } else if (this.dragMode === "pan") {
      this.panBy(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y);
    } else if (this.dragMode === "link") {
      this.ghostTo = this.pointerIso();
    }
    this.lastPointer = { x: e.clientX, y: e.clientY };

    if (this.dragMode === "none") this.updateHover();
  }

  private onPointerUp(e: PointerEvent): void {
    const moved = this.downAt
      ? Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > MOVE_THRESHOLD
      : false;

    if (this.dragMode === "link" && this.linkSourceId) {
      const target = this.pickDevice();
      if (target && target !== this.linkSourceId)
        this.callbacks.onDrawLink(this.linkSourceId, target);
      return;
    }
    if (moved) return; // a drag (move/pan) — nothing to select

    // A click: device → link → flight → background.
    const device = this.pickDevice();
    if (device) {
      this.callbacks.onSelectDevice(device);
      return;
    }
    const link = this.pickLink();
    if (link) {
      this.callbacks.onSelectLink(link);
      return;
    }
    const flight = this.pickFlight();
    if (flight !== null) {
      this.callbacks.onSelectFlight(flight);
      return;
    }
    this.callbacks.onBackground();
  }

  private panBy(dxPx: number, dyPx: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    right.y = 0;
    up.y = 0;
    right.normalize();
    up.normalize();
    const pxToWorld = (2 * this.viewSize) / (this.container.clientHeight || 1);
    this.target.addScaledVector(right, -dxPx * pxToWorld);
    this.target.addScaledVector(up, dyPx * pxToWorld);
    this.updateCamera();
  }

  private updateGhost(): void {
    const source = this.linkSourceId ? this.devicePos.get(this.linkSourceId) : null;
    if (!source || !this.ghostTo) {
      if (this.ghost) {
        this.root.remove(this.ghost);
        (this.ghost.material as THREE.Material).dispose();
        this.ghost.geometry.dispose();
        this.ghost = null;
      }
      return;
    }
    const from = isoToWorld(source);
    from.y = 0.2;
    const to = isoToWorld(this.ghostTo);
    to.y = 0.2;
    if (!this.ghost) {
      this.ghost = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineDashedMaterial({
          color: 0x8fd6ff,
          dashSize: 0.3,
          gapSize: 0.2,
          transparent: true,
          opacity: 0.8,
        }),
      );
      this.root.add(this.ghost);
    }
    this.ghost.geometry.setFromPoints([from, to]);
    this.ghost.computeLineDistances();
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  private pickDevice(): string | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const cores: THREE.Object3D[] = [];
    for (const v of this.switches.values()) cores.push(v.core);
    for (const v of this.hosts.values()) cores.push(v.core);
    const hit = this.raycaster.intersectObjects(cores, false)[0]?.object;
    return (hit?.userData.deviceId as string | undefined) ?? null;
  }

  private pickLink(): string | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const picks: THREE.Object3D[] = [];
    for (const v of this.links.values()) picks.push(v.pick);
    const hit = this.raycaster.intersectObjects(picks, false)[0]?.object;
    return (hit?.userData.linkId as string | undefined) ?? null;
  }

  private pickFlight(): number | null {
    if (this.bpdus.size === 0) return null;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const px = (this.pointer.x * 0.5 + 0.5) * w;
    const py = (-this.pointer.y * 0.5 + 0.5) * h;
    const scratch = new THREE.Vector3();
    let best = FLIGHT_PICK_RADIUS;
    let nearest: number | null = null;
    for (const [id, visual] of this.bpdus) {
      visual.worldHead(scratch).project(this.camera);
      if (scratch.z > 1) continue;
      const sx = (scratch.x * 0.5 + 0.5) * w;
      const sy = (-scratch.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - px, sy - py);
      if (d < best) {
        best = d;
        nearest = id;
      }
    }
    return nearest;
  }

  private updateHover(): void {
    const device = this.pickDevice();
    const link = device ? null : this.pickLink();
    const flight = device || link ? null : this.pickFlight();
    if (link !== this.hoverLink) {
      this.hoverLink = link;
      this.callbacks.onHoverLink(link);
    }
    this.renderer.domElement.style.cursor = this.linkDrawMode
      ? "crosshair"
      : device || link || flight !== null
        ? "pointer"
        : "default";
  }
}
