import * as THREE from "three";

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Soft white radial glow — tinted per-use via material color. */
export function createGlowTexture(): THREE.Texture {
  return canvasTexture(128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.55)");
    g.addColorStop(0.6, "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}

/** Hollow glowing annulus — a bright ring around an empty centre. */
export function createRingTexture(): THREE.Texture {
  return canvasTexture(128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.42, "rgba(255,255,255,0)");
    g.addColorStop(0.62, "rgba(255,255,255,1)");
    g.addColorStop(0.78, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}

/** Faint pool of light beneath the playground. */
export function createStageTexture(): THREE.Texture {
  return canvasTexture(512, (ctx) => {
    const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
    g.addColorStop(0, "rgba(86,128,205,0.18)");
    g.addColorStop(0.5, "rgba(70,105,180,0.06)");
    g.addColorStop(1, "rgba(60,90,160,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
  });
}

/** A four-point sparkle/crown glint for the root bridge. */
export function createSparkTexture(): THREE.Texture {
  return canvasTexture(128, (ctx) => {
    ctx.translate(64, 64);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    for (let i = 0; i < 4; i += 1) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(8, 12);
      ctx.lineTo(0, 64);
      ctx.lineTo(-8, 12);
      ctx.closePath();
      ctx.fill();
    }
  });
}
