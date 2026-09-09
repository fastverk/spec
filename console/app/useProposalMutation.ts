"use client";

import { useCallback, useReducer } from "react";

type MutationState = {
  busy: boolean;
  error: string | null;
  note: string | null;
};

type MutationAction =
  | { type: "start" }
  | { type: "succeed"; note: string }
  | { type: "fail"; error: string }
  | { type: "clear" };

const INITIAL: MutationState = { busy: false, error: null, note: null };

function reducer(_: MutationState, action: MutationAction): MutationState {
  switch (action.type) {
    case "start":
      return { busy: true, error: null, note: null };
    case "succeed":
      return { busy: false, error: null, note: action.note };
    case "fail":
      return { busy: false, error: action.error, note: null };
    case "clear":
      return INITIAL;
  }
}

/**
 * The shared lifecycle for a proposal form.
 *
 * Keeping busy/error/success in one reducer makes impossible combinations
 * unrepresentable: a request cannot be both busy and successful, and a stale
 * error cannot survive a new attempt.
 */
export function useProposalMutation() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const run = useCallback(async (
    mutation: () => Promise<unknown>,
    success: string,
    onSuccess?: () => void,
  ): Promise<boolean> => {
    dispatch({ type: "start" });
    try {
      await mutation();
      dispatch({ type: "succeed", note: success });
      onSuccess?.();
      return true;
    } catch (error) {
      dispatch({ type: "fail", error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }, []);

  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  return { ...state, run, clear };
}
