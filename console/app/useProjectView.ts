"use client";

import { useCallback, useEffect, useReducer } from "react";

import { openingProject } from "../lib/project";

const PROJECT_KEY = "spec:selected-project";

type ViewState = {
  project: string;
  query: string;
};

type ViewAction =
  | { type: "project"; value: string }
  | { type: "query"; value: string };

function reducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "project":
      return { ...state, project: action.value };
    case "query":
      return { ...state, query: action.value };
  }
}

/**
 * Shared project context for every project-scoped pane.
 *
 * Selection is remembered across navigation, while the server-safe initial
 * value still comes from the corpus. Search is part of the same reducer because
 * both fields jointly determine the visible collection.
 */
export function useProjectView(available: readonly string[]) {
  const [state, dispatch] = useReducer(
    reducer,
    available,
    (projects): ViewState => ({ project: openingProject(projects), query: "" }),
  );

  useEffect(() => {
    const remembered = window.sessionStorage.getItem(PROJECT_KEY);
    if (remembered && available.includes(remembered) && remembered !== state.project) {
      dispatch({ type: "project", value: remembered });
    }
    // The available project list is corpus data and therefore immutable for a
    // deployment. Reading it once avoids a stored value fighting a user click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  useEffect(() => {
    if (state.project) window.sessionStorage.setItem(PROJECT_KEY, state.project);
  }, [state.project]);

  const setProject = useCallback((value: string) => dispatch({ type: "project", value }), []);
  const setQuery = useCallback((value: string) => dispatch({ type: "query", value }), []);

  return { project: state.project, query: state.query, setProject, setQuery };
}
