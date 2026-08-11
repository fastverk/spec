import { Box } from "@mui/material";
import { NotBackedYet, PaneHead } from "../ui";

export function PlanMode() {
  return (
    <Box>
      <PaneHead
        title="Plan mode"
        sub="Agent tasks intersected against the requirements they could break — asked before anything runs, not after."
      />
      <NotBackedYet
        what="Plan mode"
        needs={
          <>It needs each task's blast radius from the agent side, and a requirement
          with a governed region to intersect it with. Neither exists yet: no
          requirement here is grounded, so nothing has a region.</>
        }
      />
    </Box>
  );
}

export function Liveness() {
  return (
    <Box>
      <PaneHead
        title="Liveness"
        sub="Groundings rot. A column gets renamed, an enum gains a value, a code path moves — and the check still passes, against the wrong thing."
      />
      <NotBackedYet
        what="Drift detection"
        needs={
          <>It compares a grounding's referent against the product's current shape.
          No requirement has a confirmed referent yet, so there is nothing whose
          drift could be detected.</>
        }
      />
    </Box>
  );
}
