/**
 * How much of the terminal the generated settings dialog asks pi for.
 *
 * The dialog under `./generated` lays itself out in the room its overlay is given: `width` columns
 * where the terminal has them, and as many rows as its content needs, never more than the
 * terminal's. It shrinks to 80x24; below that it is clipped, not replaced.
 */

/**
 * Overlay width: the dialog's full size. pi narrows the overlay on a narrower terminal, and the
 * dialog follows down to 80 columns. The picker that takes the dialog's place is this wide too.
 */
export const SETTINGS_DIALOG_WIDTH = 84;

/**
 * Overlay width for the startup gate's model picker: the generated picker's full size. The
 * picker lays itself out in the room it is given and shrinks to 80x24 below that.
 */
export const MODEL_PICKER_WIDTH = 88;

/**
 * `maxHeight` for `showOpenTuiDialog`: the share of the terminal's rows a dialog may take.
 * All of them: the settings view and the picker are each as tall as their content, and a terminal
 * of 24 rows is the least either is laid out for.
 */
export const DIALOG_MAX_HEIGHT = 1;
