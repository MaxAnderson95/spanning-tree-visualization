# Render the isometric scene with Three.js and an orthographic camera

The isometric canvas is also an interactive topology editor (drag switches/hosts,
draw links, select/delete) that must show moving BPDU packets with glow. We chose
**Three.js with a tilted orthographic camera** (true isometric, no perspective)
so we can reuse the proven `raft-visualization` rendering machinery — comet-on-arc
packets, UnrealBloom, shader timer-rings, one-shot effects, and projection-based
label placement and click-picking — and keep visual lineage with its sibling.

## Considered Options

- **Three.js + orthographic iso camera (chosen)** — maximal reuse of raft's viz
  code; editor gestures handled via raycasting plus a click-vs-drag threshold,
  both of which raft already solved.
- **SVG + DOM** — easiest editor ergonomics (native pointer events, CSS), but
  throws away raft's Three.js effects and can struggle with many simultaneously
  animating packets.
- **2D Canvas (Pixi/Konva)** — good packet performance, but still loses the raft
  reuse and adds editor-chrome boilerplate.

## Consequences

Drag-to-place and link-drawing are fiddlier in WebGL than in the DOM; we accept
that cost in exchange for reuse and a single, unified, glowing scene.
