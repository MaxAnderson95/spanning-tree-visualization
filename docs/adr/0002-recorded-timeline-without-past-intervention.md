# Record a scrubbable timeline, but apply all actions at the live edge

Like raft, the simulator records a full state Frame per event so the timeline is
losslessly scrubbable — you can rewind and replay any moment of a convergence.
Unlike raft, we deliberately **do not implement past-time intervention
(`forkAt`)**: editing the topology, failing a device, or turning a knob always
applies to the live edge, and acting while scrubbed-back snaps to live first.

## Considered Options

- **Record + scrub-back, live-edge-only actions (chosen).**
- **Full raft parity (scrub-back + `forkAt`)** — maximum power, but "edit the
  topology in the past" is confusing on a free-form editor canvas and is the most
  complex part of the simulation.
- **Live-only (no recorded history)** — simplest, but loses the rewind-and-rewatch
  capability that makes convergence studyable.

## Consequences

We keep the signature rewind/replay while dropping the hardest sim machinery;
scrubbing is strictly read-only playback, and the editor only ever mutates "now."
