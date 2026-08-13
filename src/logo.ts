import { rgbFromHex } from "./color.ts";

export const LOGO = String.raw`

  ████████ █████████████
 ████████ ███████████████
████████ ████████████████
██     ██       ██
█     ███      ███
     ████     ████
     █████    █████
    ██████   ██████
    ███████   ███████
    ███████   ███████
    ███████   ████████████
    ███████   ███████████
    ███████   █████████
`;

export const LOGO_INK = rgbFromHex("#f2f2f2");
export const LOGO_SHADOW = rgbFromHex("#150f28");
/** Cells the drop shadow is offset by, down and to the right of the logo. */
export const LOGO_SHADOW_OFFSET = 1;

export const LOGO_LINES = LOGO.split("\n").filter((line) => line.trim().length > 0);
export const LOGO_WIDTH = Math.max(...LOGO_LINES.map((line) => line.length));
