# Desk workflow controls

The Workflows button manages each desk's workflows and routines. Imported skills
are not desk workflows and are not shown here.

- **Hide / Reveal** changes only what is displayed, saved in `desks.json`.
  **Show hidden workflows** always lets you bring one back.
- **Disable** pauses a desk. It cancels the desk's queued and running non-user
  work through the scheduler and stops new autonomous work from starting. Your
  own direct requests to a bot still run in the protected user lane.
- **Enable** lets queued work and scheduled routines run again. Cancelled runs are
  never resurrected. Runs with uncertain side effects keep their normal
  reconciliation in the Attention pane.
- **Routines** can be added, disabled, enabled, and removed within their desk.
  They run once, at an interval, or on a cron schedule with a time zone, using the
  host's automation service. Pausing a desk keeps its routines and their
  instructions.
- Re-enabling an individually disabled routine creates a new schedule generation,
  so the earlier cancellation still holds.

Display state is separate from execution state. A pause is enforced by the host
scheduler, not by rewriting prompts or asking the model to stop.
