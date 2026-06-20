# One internally-factored spanning-tree core, separated from the app

The spanning-tree algorithm lives in a single pure, sans-I/O, dependency-free
package (`src/spanning-tree/`) that imports nothing from sim/viz/ui and is
liftable on its own — exactly like raft's `src/raft/`. Because we implement both
802.1D (STP) and 802.1w (RSTP), the package exposes one port-local `Bridge` with a
`mode` flag: a shared substrate (Bridge ID & root election, path cost, the
priority-vector comparison, the `StepResult` contract, snapshots) plus
mode-specific state-machine modules behind a single interface.

## Considered Options

- **One factored package, dual-mode (chosen)** — faithful to 802.1w, which
  specifies RSTP with STP-compatibility as one state-machine framework; no
  duplication of the identical election/costing substrate.
- **Two sibling packages on a shared substrate (`common/` + `stp/` + `rstp/`)** —
  each protocol independently liftable, at the cost of more structure and
  duplicated transition scaffolding.
- **Two fully independent packages** — maximal separation, but duplicates the
  Bridge ID / path-cost / vector logic and invites the two from drifting apart.

## Consequences

STP- and RSTP-specific logic must stay behind the shared interface and be
separately tested, so the two modes can never diverge on root election or path
cost. The whole core remains decoupled from the app and publishable standalone.
