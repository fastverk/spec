"use client";

import { useCallback, useReducer } from "react";

import { submitOp } from "./useOverlay";
import { useProposalMutation } from "./useProposalMutation";

type DecisionState = {
  definition: string;
  reason: string;
};

type DecisionAction =
  | { type: "definition"; value: string }
  | { type: "reason"; value: string }
  | { type: "reset" };

const INITIAL: DecisionState = { definition: "", reason: "" };

function reducer(state: DecisionState, action: DecisionAction): DecisionState {
  switch (action.type) {
    case "definition":
      return { ...state, definition: action.value };
    case "reason":
      return { ...state, reason: action.value };
    case "reset":
      return INITIAL;
  }
}

/** Form state and proposal lifecycle shared by both term decision surfaces. */
export function useTermDecision(project: string, parent: string, onDone: () => void) {
  const [fields, dispatch] = useReducer(reducer, INITIAL);
  const mutation = useProposalMutation();
  const { run } = mutation;

  const setDefinition = useCallback(
    (value: string) => dispatch({ type: "definition", value }),
    [],
  );
  const setReason = useCallback(
    (value: string) => dispatch({ type: "reason", value }),
    [],
  );
  const act = useCallback(async (
    op: string,
    opFields: Record<string, unknown>,
    success: string,
  ) => {
    await run(
      () => submitOp(op, { project, ...opFields }, parent),
      success,
      () => {
        dispatch({ type: "reset" });
        onDone();
      },
    );
  }, [onDone, parent, project, run]);

  return { ...fields, ...mutation, setDefinition, setReason, act };
}
