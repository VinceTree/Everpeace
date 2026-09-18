export const TUI_COLORS = {
  agent: "magenta",
  error: "red",
  status: "cyan",
  success: "green",
  warning: "yellow",
  secondary: "gray",
} as const;

export interface DiffPalette {
  addedBackground?: string;
  addedForeground?: string;
  deletedBackground?: string;
  deletedForeground?: string;
  headerForeground?: string;
}

export function terminalColorDepth(
  stdout: NodeJS.WriteStream = process.stdout,
): number {
  return typeof stdout.getColorDepth === "function" ? stdout.getColorDepth() : 1;
}

export function isLightTerminal(
  colorForegroundBackground = process.env.COLORFGBG,
): boolean {
  const background = colorForegroundBackground?.split(";").at(-1);
  const value = background === undefined ? Number.NaN : Number(background);
  return Number.isFinite(value) && value >= 7 && value !== 8;
}

export function diffPalette(options: {
  colorDepth?: number;
  colorForegroundBackground?: string;
  noColor?: boolean;
} = {}): DiffPalette {
  if (options.noColor ?? process.env.NO_COLOR !== undefined) return {};

  const colorDepth = options.colorDepth ?? terminalColorDepth();
  const light = isLightTerminal(
    options.colorForegroundBackground ?? process.env.COLORFGBG,
  );
  if (colorDepth >= 24) {
    return light
      ? {
          addedBackground: "#DAFBE1",
          addedForeground: "#116329",
          deletedBackground: "#FFEBE9",
          deletedForeground: "#82071E",
          headerForeground: "#0550AE",
        }
      : {
          addedBackground: "#213A2B",
          addedForeground: "#7EE787",
          deletedBackground: "#4A221D",
          deletedForeground: "#FFA198",
          headerForeground: "#79C0FF",
        };
  }
  if (colorDepth >= 8) {
    return {
      addedBackground: "#1C3326",
      addedForeground: "green",
      deletedBackground: "#3D1F1E",
      deletedForeground: "red",
      headerForeground: "cyan",
    };
  }
  return {
    addedForeground: "green",
    deletedForeground: "red",
    headerForeground: "cyan",
  };
}
