"use client";

import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo } from "react";

import type { GroundingSuggestion } from "../lib/grounding-suggestions";
import { MONO } from "./theme";

export function GroundingComposer({ value, onChange, suggestions, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  suggestions: GroundingSuggestion[];
  disabled?: boolean;
}) {
  const byLocator = useMemo(
    () => new Map(suggestions.map((suggestion) => [suggestion.locator, suggestion])),
    [suggestions],
  );
  const selected = byLocator.get(value);

  return (
    <Box>
      <Autocomplete
        freeSolo
        options={suggestions.map((suggestion) => suggestion.locator)}
        inputValue={value}
        disabled={disabled}
        onInputChange={(_, next) => onChange(next)}
        onChange={(_, next) => onChange(next ?? "")}
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            label="Project referent"
            placeholder="Search existing bindings or enter an exact locator"
            helperText={
              suggestions.length
                ? `${suggestions.length} existing project ${suggestions.length === 1 ? "binding" : "bindings"} available to reuse.`
                : "Enter the stable locator your project understands. Spec stores it but never parses or runs it."
            }
            slotProps={{ input: { ...params.InputProps, sx: { fontFamily: MONO, fontSize: 13 } } }}
          />
        )}
        renderOption={(props, locator) => {
          const suggestion = byLocator.get(locator);
          return (
            <Box component="li" {...props} sx={{ display: "block !important", py: "10px !important" }}>
              <Typography sx={{ fontFamily: MONO, fontSize: 12.5, overflowWrap: "anywhere" }}>
                {locator}
              </Typography>
              {suggestion ? (
                <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: "wrap", gap: 0.5 }}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={suggestion.source === "adapter" ? "project catalog" : "existing binding"}
                    sx={{ fontSize: 9.5 }}
                  />
                  {suggestion.usedBy.slice(0, 3).map((surface) => (
                    <Chip key={surface} size="small" label={surface} sx={{ fontSize: 9.5 }} />
                  ))}
                  {suggestion.usedBy.length > 3 ? (
                    <Chip size="small" label={`+${suggestion.usedBy.length - 3}`} sx={{ fontSize: 9.5 }} />
                  ) : null}
                  {suggestion.count !== undefined ? (
                    <Chip
                      size="small"
                      color={suggestion.count === 0 ? "error" : "success"}
                      label={`${suggestion.count.toLocaleString()} records`}
                      sx={{ fontSize: 9.5 }}
                    />
                  ) : null}
                </Stack>
              ) : null}
            </Box>
          );
        }}
      />

      {selected ? (
        <Box sx={{ mt: 1.25, p: 1.5, borderRadius: 1.5, bgcolor: "action.hover" }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
            <Chip size="small" color="success" variant="outlined" label="Reusing a known referent" />
            <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12 }}>
              Already used for {selected.usedBy.join(", ")}.
            </Typography>
          </Stack>
          {selected.caveat ? (
            <Typography variant="body2" sx={{ color: "warning.main", fontSize: 12, mt: 0.75 }}>
              {selected.caveat}
            </Typography>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
