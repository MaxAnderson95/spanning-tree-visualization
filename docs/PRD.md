# RSTP — Spanning Tree, Visualized

**Product Requirements Document**

A browser-based, interactive, **isometric** visualization of the Rapid Spanning
Tree Protocol (RSTP, IEEE 802.1w). You build a switched network on a canvas —
drag switches and hosts on, draw links between them — and watch the spanning
tree converge in real time: a root bridge is elected, ports take on roles and
states, BPDUs flow link to link, and exactly the right ports block to break
every loop. Then you break things — power off a switch, cut a link, retune a
bridge's priority — and watch it reconverge. A mode toggle replays the same
failure under classic STP (802.1D) so you can _feel_ why "Rapid" matters.

The product is not the network gear — it is the **protocol itself**: how a set
of switches with no central coordinator, exchanging nothing but BPDUs, agree on
a single loop-free forwarding topology, and how they heal when it changes.

This project deliberately reuses the architecture and engineering patterns of
its sibling, `raft-visualization`: a pure, sans-I/O protocol core; a
discrete-event simulator with a recorded, scrubbable timeline; a Three.js scene;
and a DOM HUD — all under the Vite+ toolchain.

---

## 1. Goals & Non-Goals

### Goals

- **Teach RSTP by watching it.** Make spanning tree legible: root election,
  per-port role and state, path cost, the proposal/agreement handshake, timer
  expiry, topology-change flooding, and reconvergence are all visible and
  narrated.
- **Make the loop-break obvious.** The single most important moment — a physical
  loop exists, and RSTP blocks exactly one port to break it — must be
  unmistakable: you can see the loop _and_ see precisely where the tree severed
  it.
- **Let the learner build and break.** A real isometric editor: drag switches
  and hosts on, draw links, delete them, retune priorities and costs, then power
  off / restart / cut / shut things and watch the tree respond.
- **Stress it, and split it.** A **chaos mode** that continuously injects
  failures (link flaps, switch power-cycles, partitions, priority churn, lossy
  links) so the network's resilience plays out hands-free; and **partitioning**
  that shows each isolated island electing its _own_ root bridge, then merging
  back to a single root when healed.
- **Contrast slow vs rapid.** A first-class STP↔RSTP toggle replays the same
  topology and the same failure under 802.1D (timer-driven, ~30–50 s) and 802.1w
  (handshake-driven, sub-second) — including the end-host downtime that makes the
  difference matter.
- **Make time a control.** Pause, slow down to study a handshake frame by frame,
  speed up to skip STP's long countdowns, and scrub backward to replay any past
  moment of a convergence — losslessly.
- **Be a distinctive, playful scene.** A bright isometric "network playground,"
  not a utilitarian diagram — rewarding to watch, while staying instantly
  readable to network engineers.
- **Keep the algorithm honest and reusable.** The spanning-tree implementation
  is written from scratch (no networking libraries) and lives as a
  self-contained, dependency-free, sans-I/O module that could be lifted out and
  embedded elsewhere.

### Non-Goals

- **Not a production STP implementation.** Clarity over performance; no real
  frames on a real NIC, no disk, no persistence of switch config.
- **Not a data-plane simulator.** We model the control plane (BPDUs and the
  resulting port states). Whether user data would flow is _shown_ through port
  state (forwarding vs discarding), not by simulating individual data frames.
  (A broadcast-storm demo is a documented Future Opportunity, not v1.)
- **Single spanning-tree instance only.** No MSTP, no PVST+/Rapid-PVST, no
  per-VLAN trees, no MST regions. One tree over the whole topology. This is a
  documented simplification (§14).
- **No shared media / hubs, hence no Backup port role.** Links are point-to-point
  switch-to-switch (or switch-to-host). The Backup role only arises on shared
  segments, which modern networks don't have. Documented simplification (§14).

## 2. Personas

- **The learner** — a student or engineer who knows STP exists and wants
  intuition: why is _that_ port blocked, why is _that_ switch the root, why did
  the network go quiet for 30 seconds. Default experience must be calm,
  watchable, and self-explanatory.
- **The tinkerer / network engineer** — wants the real knobs (bridge priority,
  path cost, port priority) to force a specific root, move which port blocks,
  and break ties on parallel links — and wants to fail things and watch
  reconvergence. The CLI mental model should map cleanly onto the controls.
- **The reuser** — a developer who wants the `spanning-tree-core` module for
  their own project and expects it to be clean, typed, faithful to 802.1D/802.1w,
  and free of UI/runtime coupling.

---

## 3. Architecture Overview

Five layers, strictly separated, each independently testable. Dependencies point
**downward only**.

```
src/spanning-tree/ — the algorithm core (pure, sans-I/O, dependency-free,
                     pluckable). One port-local Bridge, dual-mode (STP/RSTP):
                     a shared substrate + mode-specific state machines behind a
                     single interface.
src/model/         — the topology graph types (switches, hosts, links, ports)
                     and pure graph operations. Shared, dependency-free data.
src/sim/           — discrete-event simulator: owns the topology, drives each
                     Bridge, carries BPDUs across links, records the timeline,
                     runs chaos.
src/viz/           — Three.js isometric scene (switches, hosts, links, BPDU
                     comets, effects, bloom).
src/ui/            — DOM HUD (editor toolbar/palette, inspector, dials, mode
                     toggle, event feed, timeline scrubber, BPDU modal).
src/app.ts         — controller bridging sim-time ↔ wall-time and editor
                     gestures ↔ simulation mutations.
```

`viz`/`ui` depend on `sim`; `sim` depends on `spanning-tree` and `model`;
`spanning-tree` and `model` depend on nothing. The `spanning-tree` core imports
nothing from the rest of the app — no sim, viz, ui, timers, DOM, or network — and
is **the pluckable artifact**: the whole package could be lifted into a Node
service, a worker, or another project unchanged.

**Key faithfulness decision:** the Bridge core is **port-local**. A bridge knows
only its own ports and the last BPDU heard on each — exactly like real 802.1w,
which is defined as a set of per-port state machines. The _global_ topology (who
connects to whom, link costs, which links are up) lives in `sim`, never in the
bridge. This keeps the core honest and the simulation authoritative.

**STP and RSTP live inside that one core, factored apart.** A shared substrate —
Bridge ID & root election, path cost, the priority-vector comparison, the port
abstraction, the `StepResult` contract, and snapshots — is common to both modes.
The parts that differ (state set, transition mechanism, BPDU origination,
topology-change handling) sit in mode-specific modules behind a single
`Bridge` / port-state-machine interface, each separately tested. This mirrors
802.1w (which specifies RSTP with STP-compatibility as one framework) and keeps
the two algorithms separable without duplicating the identical election and
costing logic.

## 4. The Spanning-Tree Core (`src/spanning-tree/`)

### 4.1 Sans-I/O, port-local design

The library never touches timers, the network, or `Math.random` directly. The
host (the simulator) drives every bridge:

- `tick(now)` — advance logical time; fire Hello transmissions, expire timers
  (Max-Age, Forward-Delay), run role/state transitions.
- `receive(bpdu, portId, now)` — deliver a BPDU that arrived on a specific port.
- `setPortEnabled(portId, up, now)` — a link came up or went down on a port
  (cable cut, neighbor powered off, admin shut).
- `addPort(portId, opts)` / `removePort(portId)` — the editor wired or removed a
  link.
- `nextWakeAt()` — the earliest time the host must call `tick`.
- A seeded RNG is **injected** at construction (used sparingly — see §11).

Every call returns a `StepResult` describing what the world should do next:

```ts
interface StepResult {
  bpdus: { portId: PortId; bpdu: Bpdu }[]; // to transmit; the host delivers them
  events: StpEvent[]; // semantic events to narrate/animate
}
```

Port roles and states are read from an immutable `snapshot()` (see §4.7). Same
seed + same inputs ⇒ same run, so the core is fully deterministic and testable
without mocks.

### 4.2 Dual-mode: RSTP (802.1w) and classic STP (802.1D)

The core runs in one of two protocol modes, selectable live (the STP↔RSTP
toggle), because the headline lesson is the contrast:

|                          | **STP (802.1D)**                                      | **RSTP (802.1w)**                                        |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------------- |
| Port states              | Blocking, Listening, Learning, Forwarding (+Disabled) | Discarding, Learning, Forwarding                         |
| Who originates BPDUs     | only the root; others relay                           | every bridge, every Hello                                |
| Transition to Forwarding | timers: Listening (FwdDelay) → Learning (FwdDelay)    | proposal/agreement handshake on P2P, else timer fallback |
| Failure detection        | Max-Age expiry (20 s)                                 | missing 3× Hello (≈6 s), faster                          |
| Topology change          | TCN BPDUs toward root, root sets TC flag              | TC flooded directly, MAC flush                           |
| Convergence              | ~30–50 s                                              | sub-second on P2P                                        |

Switching mode re-runs the relevant state machines from the current topology.
Only the rows that differ above live in the mode-specific modules; everything
else is the shared substrate, so the two modes can never disagree on root
election or path cost.

### 4.3 Algorithm coverage

- **Root election** by lowest **Bridge ID** = `priority (16-bit) ‖ MAC (48-bit)`.
  Priority is configured in steps of 4096 (default 32768); MAC is the
  tiebreaker. Every bridge boots believing it is root and converges on the
  lowest ID.
- **Root Path Cost** accumulation: a bridge's distance to root is the sum of the
  ingress port costs along the best path. Default per-port cost is derived from
  link speed using the classic IEEE short-cost table (10M=100, 100M=19, 1G=4,
  10G=2) and is overridable.
- **Port role selection** per port: **Root Port** (best path to root),
  **Designated Port** (best on its segment, forwards away from root), or
  **Alternate Port** (a strictly-worse path to root — held Discarding to break
  the loop). _Backup is out of scope (§14)._
- **Best-vector comparison** — the 802.1w priority vector
  `{ rootId, rootPathCost, senderBridgeId, senderPortId }`, compared in that
  order, decides roles and ties. **Port priority** (default 128, step 16) feeds
  the sender-port-id field and is the tiebreaker on parallel equal-cost links.
- **Port states**: Discarding / Learning / Forwarding (RSTP), with the classic
  five in STP mode.
- **Proposal/agreement (sync) handshake** (RSTP, P2P): a designated port that
  wants to forward sends a proposal; the receiving bridge **syncs** (moves its
  other non-edge designated ports to Discarding), agrees, and the port goes
  straight to Forwarding without waiting out Forward-Delay. This is the "rapid."
- **Edge ports** (`§4.5`): ports to end hosts go straight to Forwarding and are
  excluded from sync.
- **Topology Change**: a non-edge port going to Forwarding triggers TC; RSTP
  floods TC and flushes learned addresses; STP relays TCN toward the root.
- **Timer fallback**: a non-edge port that can't complete the handshake (or any
  port in STP mode) transitions via the Forward-Delay timer.

### 4.4 Failure detection & aging

Each port stores the best BPDU it has heard and ages it. When `now` passes the
stored info's Max-Age (or, in RSTP, after 3 missed Hellos), the info expires,
the port reverts to believing _it_ is the designated/root candidate, and
role selection reconverges. This is the timer the UI counts down after a link
or neighbor dies (§6.7).

### 4.5 Edge ports (PortFast)

A port flagged `edge` (set automatically when a host is attached, or manually)
transitions immediately to Forwarding, never participates in the sync handshake,
and does not, on its own, cause a topology change. If a BPDU is ever received on
an edge port, it loses edge status (an honest 802.1w behavior worth showing).

### 4.6 Live retuning

`setBridgePriority()`, `setPortCost()`, `setPortPriority()`, and `setTiming()`
(Hello / Max-Age / Forward-Delay) all apply to a running bridge and take effect
on the next transmission/timer reset. These back the inspector and timing dials.

### 4.7 Snapshots

`snapshot()` returns a complete, immutable view of bridge state: its Bridge ID,
the elected root it believes in, its root path cost, and per-port role, state,
cost, priority, edge flag, timers, and last-heard BPDU. Internals are
copy-on-write so snapshots are cheap to take on every event — this is what makes
the recorded timeline (§5.3) affordable.

## 5. The Simulation (`src/sim/`) and Topology Model (`src/model/`)

### 5.1 The topology model

The editable network is plain, serializable data (also the unit of save/share,
§11):

- **Switch** — id, label, bridge priority, MAC, power state (on/off), iso
  position `(x, y)`.
- **Host** — id, label, MAC, iso position. Attaches to exactly one switch port.
- **Link** — id, two endpoints `{ switchId|hostId, portId }`, speed (→ default
  cost), per-end path cost and port priority overrides, and an up/cut state.
- **Port** — derived: created on demand when a link is drawn, labeled `P1, P2,
…` in creation order per device, carries role/state at runtime, and is
  flagged `edge` when its link's far end is a host.

`src/model/` also holds pure graph helpers (enumerate a device's ports, find a
link's far end, detect physical cycles for highlighting, and split the graph
into connected components — each is an independent spanning-tree island, §5.8).

### 5.2 Discrete-event engine

A priority loop over the next two kinds of event: the **next BPDU delivery** and
the **next bridge wake-up** (`nextWakeAt()` across all powered switches).
Simulated time (sim-seconds) is decoupled from wall time. The loop advances to
the earliest event, processes it (deliver a BPDU → `receive`, or wake a bridge →
`tick`), queues any resulting BPDUs as in-flight, records a frame, and repeats.

Determinism is preserved by a per-bridge seeded RNG plus a network RNG, each
consumed a fixed number of times per event so that changing a dial never desyncs
a seeded run.

### 5.3 Timeline recording & scrub-back (live-edge actions)

Every event produces a **Frame**: the complete world state at that instant —
every bridge snapshot, every port role/state, all in-flight BPDUs, the active
timers, and the narrated events. This makes scrubbing **lossless**: any past
moment of a convergence renders exactly.

- **Scrub backward = pure replay.** The recorded future is preserved; you can
  rewind to rewatch a handshake or a reconvergence.
- **All actions happen at the live edge.** Editing the topology, powering a
  switch off, cutting a link, or turning a knob always applies to _now_;
  initiating an action while scrubbed-back snaps the timeline to the live edge
  first. (We deliberately do **not** implement raft's `forkAt` past-time
  intervention — "edit the topology in the past" is confusing on a free-form
  canvas, and dropping it removes the single most complex piece of the sim.)
- A bounded ring of frames (`maxFrames`) caps memory; the scrubber's left edge
  is the retained horizon.

### 5.4 The link model (live-tunable)

Each link carries BPDUs from a port on one end to a port on the other with a
small, tunable one-way delay (`latency + U(0, jitter)`) so packets are visible
in flight. Delays are short relative to the protocol's second-scale timers;
visibility primarily comes from playback speed (§10), not bent timers. Links are
point-to-point full-duplex.

These are **live-tunable network conditions** (reused from raft): **latency**,
**jitter**, and a **BPDU-loss** fraction. Loss is the interesting one for
spanning tree — a dropped BPDU is never retransmitted, so losing ~3 in a row on
an otherwise-healthy link ages out the port's stored info (Max-Age / 3×Hello,
§4.4) and triggers a **spurious reconvergence**: the role recomputes, an
Alternate may unblock, then everything snaps back once BPDUs resume. A
lost-in-flight BPDU comet reddens and bursts mid-arc (raft's effect). The dials
live in the Chaos panel (§7.9).

A **cut** link drops BPDUs in both directions and signals
`setPortEnabled(port, false)` to both ends; **restoring** it re-enables the
ports. A **powered-off** switch drops all its links the same way.

### 5.5 Interventions (all at the live edge)

The simulator exposes the full operation set:

- **Reversible failures:** `powerOff(switch)` / `powerOn(switch)`,
  `restart(switch)` (power-cycle: down, then back up cold so it briefly believes
  it is root and re-learns), `shutPort(port)` / `noShutPort(port)`,
  `cutLink(link)` / `restoreLink(link)`.
- **Partition:** `splitNetwork()` auto-cuts a clean cut into two islands;
  `healNetwork()` restores exactly those links. (Cutting links or powering off an
  articulation switch partitions organically too — the sim detects connected
  components either way; see §5.8.)
- **Live edits:** `setBridgePriority`, `setLinkSpeed`/`setPortCost`,
  `setPortPriority`, `setTiming`, `setProtocolMode("stp"|"rstp")`,
  `setPortEdge`.
- **Permanent editor ops:** `addSwitch`, `addHost`, `addLink`, `removeSwitch`,
  `removeHost`, `removeLink`.

Each mutation updates the topology, informs the affected bridges (`addPort` /
`removePort` / `setPortEnabled` / setters), records a frame, and lets
reconvergence play out.

### 5.6 Cold start & convergence

On load (and after a hard reset), switches power on **cold**: every bridge
believes it is root, and you watch the real convergence unfold — root election,
proposals and agreements rippling outward, ports settling into roles, and the
loop's Alternate port dropping to Discarding. (Unlike raft, we do _not_
fast-forward the opening; the first convergence is the headline and is meant to
be watched, slowed down if desired.)

### 5.7 Reset semantics

Three distinct resets, matching the requested behavior:

- **Re-converge (soft):** keep the topology and all settings; power-cycle the
  whole network cold and re-run spanning tree. Blanks the timeline.
- **Reset to default:** discard the current topology and restore the built-in
  4-switch-loop + 2-host network (§9 default), then cold-start.
- **Clear canvas:** remove every switch, host, and link — an empty canvas to
  build from scratch.

### 5.8 Partitions & islands

A partition in RSTP is **not** a protocol state — no quorum, no split-brain
stall (unlike raft). It is simply the topology graph splitting into ≥2 connected
**islands**: by cutting links, powering off an articulation switch, or the
one-click `splitNetwork()`. The sim recomputes connected components on every
structural change and treats each as an independent spanning-tree domain:

- **Each island elects its own root** — the lowest Bridge ID present in that
  component — and converges to its own loop-free tree. Both sides forward
  happily; there is no "minority that can't make progress."
- **Healing is the interesting part.** When islands reconnect, the superior
  root's BPDUs flood across the restored link(s); the higher-Bridge-ID island's
  root **yields**, its ports re-role, and the two trees merge into one. The RSTP
  sync handshake (Discarding-before-Forwarding) prevents a transient loop during
  the merge — a great slow-mo moment.
- Per-island root, size, and convergence status are surfaced in the topbar/feed,
  so you watch "2 networks, 2 roots → 1 network, 1 root."

A `splitNetwork()` / `healNetwork()` pair (Chaos panel, §7.9) makes this a clean
one-click demo on any topology; the visual seam is described in §6.8.

### 5.9 Chaos mode (optional, default off)

A first-class, hands-off mischief engine so the scene tells a resilience story on
its own (raft had a Chaos panel too). Independently-armable disruption types,
each reusing an operation above:

- **Link flap** — cut a random link, auto-restore it after a beat.
- **Switch power-cycle** — power off a random switch, bring it back cold.
- **Partition / heal** — `splitNetwork()` then `healNetwork()` after a dwell, so
  the per-island re-election (§5.8) plays out unattended.
- **Priority churn** — bump a random bridge's priority to provoke root changes.
- **Lossy / slow links** — the BPDU-loss / latency / jitter conditions (§5.4).

A single **intensity** control governs cadence. Chaos is **seeded** (it draws
from the network RNG), so `?seed=N` reproduces an exact chaos run. Everything is
**off by default** — the page loads quiet and the learner opts in. Pair chaos
with the STP↔RSTP toggle and a slow speed for a self-running comparison.

## 6. The Visualization (`src/viz/`)

A WebGL scene (Three.js) rendering an isometric "network playground," with the
DOM HUD layered on top. Reuses raft's proven viz machinery: bloom via
`EffectComposer` + `UnrealBloomPass`, comet-on-arc message rendering, shader
timer rings, wall-time one-shot effects, and projection-based label placement
and click-picking.

### 6.1 Isometric camera

A **tilted orthographic camera** gives a true isometric look (no perspective
foreshortening). Controls: drag to pan, wheel/pinch to zoom (clamped), no orbit
(the iso angle is fixed so the scene stays readable). Click-picking and DOM
label projection go through the same projection matrix. A click-vs-drag
threshold keeps selection from firing at the end of a pan or a node drag.

### 6.2 Switches and hosts

- **Switches** render as device-like iso boxes (a stylized switch chassis with
  port LEDs along the edge). The **root bridge** wears a gold crown / corona
  (the analog of raft's leader halo). A **powered-off** switch darkens, desat-
  urates, and drops its links.
- **Hosts** render as small endpoint devices (PC/server), visually distinct from
  switches, connected by an edge-port link.
- Each device carries a DOM label: its name and Bridge ID (priority + short MAC),
  with the root annotated.

### 6.3 Links, port roles, and the loop-break "money shot"

Links are the heart of the read. Each link is drawn as a raised iso cable, and
each **end** (port) shows its role and state:

- **State drives color** (the convention every network engineer reads instantly):
  **Forwarding = green**, **Learning = amber**, **Discarding = red/grey**.
  Forwarding links glow as live LED-lit cables; discarding ends are dimmed.
- **Role is badged** at the port: **RP** (Root Port), **DP** (Designated), **ALT**
  (Alternate). Root ports point "uphill" toward the root (a subtle directional
  cue).
- **The blocked link is unmistakable.** Where RSTP breaks a loop, the Alternate
  end shows a clear **barrier/lock** marker and the cable is rendered severed/
  dimmed — while the physical link is still obviously _there_. The active tree
  reads as a connected glowing graph; the one blocked rung visibly interrupts an
  otherwise-complete loop. A subtle highlight can trace the physical cycle on
  hover so you see exactly what's being prevented.

### 6.4 BPDU packets & effects

- **BPDUs are glowing comets** travelling along links, on raised arcs with
  opposing directions in separate lanes (so a proposal and its agreement don't
  overlap). Trails are sampled behind the head so they render correctly even when
  scrubbing backward.
- **Comet color/marking encodes the BPDU's nature** via its flags: a normal/
  Hello BPDU, a **proposal**, an **agreement**, or a **topology-change** BPDU
  each look distinct, so the rapid handshake reads as a visible call-and-response.
- **One-shot effects** (wall-time, so they finish while paused; cleared on
  scrub-back via an effect-epoch counter): a **root-elected** burst on the new
  root, a **role-flip** pop when a port changes role, a **goes-forwarding** ripple
  along a link, a **TC flood** wave rolling across the tree, and a **block** snap
  when a port drops to Discarding.

### 6.5 Reading the tree at a glance

The converged active topology (all Forwarding links) forms the visible spanning
tree rooted at the gold-crowned switch; Alternate/blocked rungs are the dim,
barred exceptions. During convergence and reconvergence, the green "wave" of
forwarding spreading from the root — and the red snap of a port blocking — are
the primary motions to watch.

### 6.6 Edge ports & host connectivity

Edge-port links (to hosts) sit green almost immediately (PortFast) and visibly
**stay up during a sync** while interior designated ports briefly drop — the
visual proof that end hosts aren't disrupted by the handshake. In STP mode the
same host link instead crawls through Listening/Learning, going dark for the
Forward-Delay duration: the downtime made visible.

### 6.7 Timers on the scene

A port that is counting down shows a depleting ring/arc at its end (raft's
shader-ring pattern), color-matched to what it's waiting on:

- **Info-age toward Max-Age** — after a link/neighbor dies, the surviving port
  counts down before it reacts and reconverges.
- **Forward-Delay** — a port crawling Listening→Learning→Forwarding (STP mode,
  or RSTP timer fallback).
- **Hello** — a subtle periodic pulse marking each bridge's BPDU cadence.

Exact remaining seconds appear in the inspector (§7.3).

### 6.8 Partitions & islands

When the network splits, each island is visually set apart and **each gets its
own gold-crowned root**, so two (or more) simultaneous roots is the obvious read.
A one-click `splitNetwork()` draws a glowing **seam** along the cut (raft's
partition-wall effect); BPDU comets that would cross a severed boundary race to
the seam and **burst** there. On **heal**, the seam dissolves, superior BPDUs
sweep across the reconnected link, and the losing island's crown winks out as its
root yields and its ports re-role into the merged tree. Organic partitions (from
manually cut links / powered-off switches) get the same per-island crowning and
framing, minus the explicit seam.

## 7. The HUD (`src/ui/`)

DOM panels layered over the scene, following raft's HUD patterns.

### 7.1 Topbar

Wordmark; live stats (root Bridge ID, switch/host/link counts, # blocked ports,
"converged ✓ / converging…"); and global actions: **Add switch**, **Add host**
(or drag from the palette), **Chaos** (opens the Chaos panel, §7.9), and the
**Reset** menu (Re-converge / Reset to default / Clear canvas, per §5.7).

### 7.2 Mode toggle: STP ↔ RSTP

A prominent first-class toggle. Flipping it re-runs the tree under the other
protocol on the same topology. A short readout states the expected difference
("RSTP: sub-second via handshake" vs "STP: ~30–50 s via timers"), making the
toggle itself a teaching control.

### 7.3 Inspector (selection-aware)

Click any element:

- **Switch:** Bridge ID (priority + MAC), whether it is the root, its root path
  cost and which port is its Root Port, and a **per-port table** (port, role,
  state, cost, priority, edge flag, active timer). Editable: **bridge priority**
  (stepper of 4096). Actions: **Power off / Power on**, **Restart**.
- **Link:** endpoints and their port labels, **speed** (→ cost), **per-end cost**
  and **port-priority** overrides, the two ports' roles/states. Actions: **Cut /
  Restore**, **Delete**.
- **Port:** role, state, cost, priority, **edge** toggle, live timer readout.
  Actions: **Shut / No-shut**.

The panel rebuilds only on structural change so its inputs/buttons stay live.

### 7.4 Timing dials

The protocol's own timers, applied live to every bridge, each with a mini reset
and a live readout: **Hello** (default 2 s), **Forward Delay** (15 s), **Max
Age** (20 s). A **stability readout** warns when values violate the 802.1D
relationships (e.g. `2·(FwdDelay−1) ≥ MaxAge`, `MaxAge ≥ 2·(Hello+1)`), making
the standard's timer math tangible.

### 7.5 Event feed

A narrated, color-coded log: root elected/changed, port role changes, state
transitions, proposal/agreement completions, timer expiries, TC events, link/
switch up/down. Consecutive duplicates coalesce.

### 7.6 BPDU inspector (modal)

Click a BPDU comet (or an entry in the feed) to open its contents: Root Bridge
ID, Root Path Cost, Sender Bridge ID, Sender Port ID, message age / Max-Age, and
the **flags** (port role, proposal, agreement, learning, forwarding, topology
change). This turns the abstract "BPDU" into a concrete, readable frame.

### 7.7 Timeline (bottom)

- Play / pause and a **logarithmic speed slider** that goes both **slower** (down
  to study a handshake frame by frame) and **faster** (up to skip STP's long
  Forward-Delay countdowns), with a live readout.
- A scrubber whose track is painted with history: convergence episodes, root
  changes, link/switch failures, and TC events as marks — drag to rewind and
  replay.
- A **LIVE** indicator / jump-to-now button.

### 7.8 Keyboard

`Space` play/pause · `←`/`→` scrub · `[`/`]` slower/faster · `L` jump to live ·
`Delete` remove selection · `Esc` deselect / cancel link draw.

### 7.9 Chaos panel

A left-side panel (raft-style) gathering everything that stresses the network,
each control with a live readout and a mini reset:

- **Disruption toggles** — Link flap, Switch power-cycle, Partition/heal, and
  Priority churn, each independently armable (§5.9).
- **Intensity** — one slider governing how often chaos acts.
- **Network conditions** — BPDU-loss %, link latency, and jitter dials (§5.4),
  usable on their own (e.g. crank loss to watch a healthy link flap).
- **Manual Split / Heal** — one-click `splitNetwork()` / `healNetwork()` for a
  deliberate partition demo without arming full chaos.

All chaos is seeded and off by default.

---

## 8. Editor / Interaction Model

The canvas is a real editor; this is the biggest capability raft never had.

- **Add devices:** drag a switch or host from a palette onto the canvas, or use
  the topbar buttons. New devices snap to the iso grid.
- **Move devices:** drag to reposition; links follow. (Click-vs-drag threshold
  distinguishes a move from a select.)
- **Draw links:** drag from one device to another (or click source then target).
  A ghost cable previews the link; releasing on a valid target creates it,
  auto-allocating a port on each end. Dropping on a host end flags that port as
  an edge port.
- **Select & inspect:** click an element to select it and open the inspector;
  `Esc` deselects.
- **Delete:** `Delete`/`Backspace` or the inspector's Delete removes the
  selected switch/host/link (and any dependent links/ports).
- **Fail vs delete:** the inspector cleanly separates _reversible_ failure (power
  off, shut, cut) from _permanent_ removal (delete), mirroring raft's stop-vs-
  remove distinction.
- **Pan/zoom:** drag empty canvas to pan, wheel/pinch to zoom.
- **Reset menu:** Re-converge / Reset to default / Clear canvas (§5.7).

Edits are live: every gesture mutates the topology at the live edge and the tree
reconverges immediately, so building and breaking the network _is_ the
experiment.

## 9. Visual Design

**Direction: a bright isometric "network playground."** Distinct from raft's
academic "published paper" tone — playful, device-like, satisfying to poke — but
still instantly legible to network engineers.

- **Aesthetic:** isometric devices with depth and chunky, toy-like switch
  chassis; glowing LED-lit cables; juicy, game-feel feedback on state changes
  (pops, ripples, snaps). Bloom keeps the glow rich without blowing to white.
- **Primary color encoding = port state (the standard convention):**
  **Forwarding = green**, **Learning = amber**, **Discarding = red/grey** —
  rendered saturated and LED-like, not muted. This is non-negotiable for the
  network-engineer audience and is honored regardless of the playful styling.
- **Root bridge = gold**, crowned. **Role badges** (RP/DP/ALT) are clear, compact
  labels at port ends.
- **BPDU flags** get distinct comet treatments (normal/Hello, proposal,
  agreement, topology-change) so the handshake reads as call-and-response.
- **Type:** a clean, slightly characterful display face for the wordmark/stat
  numerals over a monospace for all data/labels (port tables, Bridge IDs, timer
  readouts), keeping data unambiguous.
- **Signature moment:** the blocked rung — the one barred, dimmed link
  interrupting an otherwise-complete glowing loop. It is the whole point of the
  protocol, so it is the most legible thing on screen.
- **Accessibility floor:** visible keyboard focus; `prefers-reduced-motion`
  tones down camera/idle motion, pulses, and comet trails; color is always
  paired with a badge/shape (RP/DP/ALT, the block marker) so state never relies
  on hue alone; responsive down to collapsing side panels on narrow screens.

---

## 10. Timing & Realism Model

Spanning tree runs on **second-scale** timers (Hello 2 s, Forward Delay 15 s,
Max Age 20 s), which is both a gift and a problem: RSTP converges sub-second
(watchable at 1×), while STP takes ~30–50 s (tedious at 1×). The product
separates protocol time from watching time:

- **Protocol timing stays standard** and tunable to standard defaults; the timer
  math (§7.4) is part of the lesson.
- **Link delays are a small visibility aid**, not a distortion — short relative
  to the timers, just enough to see comets travel.
- **Visibility lives in playback speed**, which is **bidirectional**: slow down
  (≪1×) to watch a proposal/agreement handshake or a single role flip frame by
  frame; speed up (≫1×) to skip STP's long Forward-Delay countdowns. The default
  sits where an RSTP convergence is a calm, watchable few seconds.

The STP↔RSTP contrast is therefore felt directly: at a fixed playback speed, the
RSTP tree snaps to green in a beat while the STP tree gates through amber for
what feels like an age — and the attached host link is the visible casualty.

---

## 11. Determinism, Reproducibility & Sharing

- **The protocol is deterministic** by construction: roles and the root are a
  pure function of Bridge IDs, costs, and port priorities. There is no
  randomized election timer to seed (unlike raft).
- **The seed drives all non-protocol randomness** — link jitter, BPDU-loss
  draws, and chaos's choices (which link to flap, when to act, where to split) —
  so a `?seed=N` URL parameter reproduces an exact run, including a whole chaos
  session; omitting it picks a random seed. RNG is consumed a fixed number of
  times per event so dial changes never desync a seeded run.
- **Live dial/knob changes affect only the live edge**, so recorded history stays
  valid; no fork is needed (and none exists — §5.3).
- **Topology is serializable** (§5.1): export/import a network as JSON, and
  (Future, §15) encode it into a shareable permalink alongside the protocol mode
  and timer settings.

## 12. Quality Bar

`spanning-tree-core` and `sim` carry a deterministic test suite:

- **Root election** by lowest Bridge ID (priority first, then MAC tiebreak).
- **Root path cost** accumulation and **Root Port** selection along the lowest-
  cost path.
- **Port-priority tiebreak** on parallel equal-cost links (the predictable
  "which port blocks?" case).
- **Loop safety:** any topology with cycles yields exactly enough Alternate
  (Discarding) ports to leave the active forwarding graph acyclic — never a loop,
  never a partition of a connected topology.
- **Proposal/agreement convergence** on P2P links transitions to Forwarding
  without waiting Forward-Delay (sub-second).
- **STP-mode convergence** gates through Listening→Learning→Forwarding over the
  Forward-Delay timer, originating BPDUs only from the root.
- **Failure & reconvergence:** cutting a link or powering off a switch promotes
  the right Alternate to Root/Designated and reconverges.
- **Edge ports** go straight to Forwarding, skip sync, and lose edge status on
  receiving a BPDU.
- **Topology-change** propagation/flooding fires on the right transitions.
- **Partition & merge:** each connected component independently elects its own
  root; on reconnect the higher-Bridge-ID root yields and the trees merge with no
  transient loop.
- **Determinism:** identical inputs (and seed) ⇒ identical roles, states, timing,
  and chaos sequence.

`vp check` (format + lint + types) and `vp test` are green on every change; the
app builds clean via `vp build`.

---

## 13. Tech Stack

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`).
- **Toolchain:** Vite+ (`vp`) — dev, check (Oxlint/Oxfmt/tsgo), test (Vitest),
  build (Rolldown).
- **Rendering:** Three.js (WebGL ortho-isometric scene + UnrealBloom) with a DOM
  HUD.
- **Dependencies:** Three.js and self-hosted fonts only. `spanning-tree-core`
  has zero runtime dependencies.
- **Deployment:** static, GitHub Pages with a project base path (as raft does),
  via `vp build`.

---

## 14. Documented Simplifications

Called out explicitly, not hidden:

- **Single spanning-tree instance.** No MSTP, no PVST+/Rapid-PVST, no per-VLAN
  trees. The Bridge ID's system-ID-extension (VLAN) field is fixed to 0.
- **No shared media / hubs**, therefore **no Backup port role**. Links are
  point-to-point switch-to-switch or switch-to-host. Roles shown: Root,
  Designated, Alternate.
- **Control plane only.** We simulate BPDUs and port states; we do not simulate
  individual data frames. A Forwarding port _means_ reachable; we don't push
  packets through it.
- **Topology changes are host-driven.** Links go up/down because the editor says
  so; we don't model physical-layer detection protocols (UDLD, LACP, link
  debounce).
- **MAC addresses are auto-assigned** (deterministic, displayed) and not user-
  editable — bridge priority covers all "who is root" intent.

---

## 15. Future Opportunities

- **Broadcast-storm demo:** a "disable STP" / "inject a broadcast" mode showing a
  loop melting down, and how a single blocked port prevents it — the most
  visceral argument for the protocol's existence.
- **Shareable permalinks** encoding topology + protocol mode + timer settings.
- **Guided scenarios:** scripted lessons (clean root election, indirect link
  failure, parallel-link tiebreak, edge-port PortFast).
- **Protection features:** BPDU Guard, Root Guard, Loop Guard demonstrations.
- **Shared-media/hub element** to introduce the Backup port role.
- **MSTP / per-VLAN** instances as a larger stretch.
