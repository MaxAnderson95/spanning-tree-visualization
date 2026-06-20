import * as THREE from "three";
import type { IsoPos } from "../model/index.ts";

/** Logical grid units → world units. Devices sit on the y = 0 ground plane. */
export const WORLD_SCALE = 1.15;

export function isoToWorld(pos: IsoPos, y = 0): THREE.Vector3 {
  return new THREE.Vector3(pos.x * WORLD_SCALE, y, pos.y * WORLD_SCALE);
}

export function worldToIso(world: THREE.Vector3): IsoPos {
  return { x: world.x / WORLD_SCALE, y: world.z / WORLD_SCALE };
}
