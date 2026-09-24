// Categorical palette — distinct hues chosen to stay legible on the dark panels.
export const CATEGORICAL = [
  "#5b8cff", // blue
  "#3ecf8e", // green
  "#ffb454", // amber
  "#ff6b6b", // red
  "#b58cff", // violet
  "#4dd0e1", // cyan
  "#f78fb3", // pink
  "#a3e635", // lime
  "#f4a261", // orange
  "#9aa4b8", // grey (fallback / "other")
];

export function colorAt(i: number): string {
  return CATEGORICAL[i % CATEGORICAL.length];
}

export const AXIS = "#9aa4b8";
export const GRID = "#262f42";
