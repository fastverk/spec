"use client";

import Alert from "@mui/material/Alert";
import { useEffect, useReducer } from "react";

type AdapterState =
  | { status: "checking" }
  | { status: "configured" }
  | { status: "unavailable" }
  | { status: "error" };

type AdapterAction =
  | { type: "configured" }
  | { type: "unavailable" }
  | { type: "error" };

function reducer(_: AdapterState, action: AdapterAction): AdapterState {
  return { status: action.type };
}

export function GroundingAdapterNotice() {
  const [state, dispatch] = useReducer(reducer, { status: "checking" });

  useEffect(() => {
    fetch("/api/health", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`health → ${response.status}`);
        return response.json() as Promise<{ grounding_adapter?: string }>;
      })
      .then((health) => dispatch({
        type: health.grounding_adapter === "configured" ? "configured" : "unavailable",
      }))
      .catch(() => dispatch({ type: "error" }));
  }, []);

  if (state.status === "configured") {
    return (
      <Alert severity="success" sx={{ mb: 2 }}>
        <b>Project Probe adapter connected.</b> It can measure candidate locators inside the
        project without exposing project data to spec.
      </Alert>
    );
  }

  if (state.status === "unavailable") {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        <b>Schema-backed suggestions and record counts are unavailable.</b> The optional project
        Probe adapter is not configured. This is not the decomposer: decomposition is already
        working and only identifies which words need a referent.
      </Alert>
    );
  }

  if (state.status === "error") {
    return (
      <Alert severity="warning" sx={{ mb: 2 }}>
        Could not check whether the project Probe adapter is configured. Existing project bindings
        are still available for autocomplete.
      </Alert>
    );
  }

  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      Checking for a project Probe adapter…
    </Alert>
  );
}
