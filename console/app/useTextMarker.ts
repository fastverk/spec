"use client";

import { useCallback, useRef } from "react";

export type ConceptMark = "`" | "**";

/** Selection-aware concept markup shared by create and reword forms. */
export function useTextMarker(value: string, onChange: (value: string) => void) {
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const markSelection = useCallback((mark: ConceptMark) => {
    const input = inputRef.current;
    if (!input) return;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const selected = value.slice(start, end);
    const fallback = mark === "`" ? "system field" : "business term";
    const replacement = `${mark}${selected || fallback}${mark}`;

    onChange(`${value.slice(0, start)}${replacement}${value.slice(end)}`);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + mark.length, start + mark.length + (selected || fallback).length);
    });
  }, [onChange, value]);

  return { inputRef, markSelection };
}
