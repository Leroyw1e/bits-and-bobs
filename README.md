# Bits and Bobs

Drawing boards, slides, Excel spreadsheets and maths tools for Obsidian, built to work well with Apple Pencil on iPad as well as on desktop.

## Features

### Drawing boards (`.mboard`)
- An endless board you can pan and zoom, with pen, highlighter, eraser, shapes, arrows and text.
- **Stylus support**: pressure-sensitive lines, palm rejection (once the pen touches the board, fingers pan instead of drawing), and pinch to zoom.
- **Maths boxes** that render LaTeX, such as `$$\frac{-b \pm \sqrt{b^2-4ac}}{2a}$$`.
- **Graphs**: type `x^2 - 3` or `2sin(x)` and the curve is drawn on the board.
- **Images** from your device, camera, clipboard, the vault, or by drag and drop. Images are saved in your attachments folder.
- Grid, dots, lined or plain backgrounds, plus undo and redo.

### Slides (`.mslides`)
- Presentations where every slide works like a drawing board.
- 11 ready-made layouts: Title slide, Title & bullets, Two columns, Compare, Section header, Equation, Worked example, Graph, Picture & text, Big statement and Blank.
- Slide thumbnails, speaker notes, and full-screen presenting with the keyboard, taps or swipes.

### Spreadsheets (`.xlsx`)
- Opens and saves real Excel files.
- Formulas with cell references and ranges, and around 55 functions, including `SUM`, `AVERAGE`, `POWER`, `SQRT`, trigonometry, logarithms, statistics and `IF`.
- Resize rows and columns by dragging their edges. Sizes are saved in the file.
- Function suggestions as you type a formula, AutoSum, click a cell to add it to a formula, multiple sheets, copy and paste, and copy as a Markdown table.
- A switch for keyboard autocorrect and predictions.

### Maths in notes
- Keyboard shortcuts for common maths (see below). You can turn them off in settings.
- Type `\` then a name, such as `\alpha`, `\frac` or `\int`, to search symbols with a live preview.
- A symbol picker with Basics, Greek, Calculus, Functions, Matrices, Sets & logic and Geometry.
- Maths buttons in the status bar on desktop and in the toolbar above the keyboard on mobile.

### Canvas and embeds
- Run **Add a drawing card to this canvas** and draw straight onto the card.
- Embed a board, deck or spreadsheet in a note with `![[file.mboard]]` to show it in place.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Inline maths `$x$` | ⌘⇧M | Ctrl+Shift+M |
| Maths block | ⌘⌥E | Ctrl+Alt+E |
| Power x^y | ⌘⌥P | Ctrl+Alt+P |
| Subscript | ⌘⌥B | Ctrl+Alt+B |
| Fraction | ⌘⌥Q | Ctrl+Alt+Q |
| Square root | ⌘⌥R | Ctrl+Alt+R |
| Sum | ⌘⌥S | Ctrl+Alt+S |
| Integral | ⌘⌥N | Ctrl+Alt+N |
| Limit | ⌘⌥L | Ctrl+Alt+L |
| Matrix | ⌘⌥X | Ctrl+Alt+X |
| Symbol picker | ⌘⌥K | Ctrl+Alt+K |
| Greek letters | ⌘⌥G | Ctrl+Alt+G |

On a board: **P** pen, **H** highlighter, **E** eraser, **V** select, **T** text, **M** maths box, **G** graph, **R O L A** shapes, **1–6** colours, **[ ]** size, hold **Space** to pan, **0** to fit.

All commands can also be given your own hotkeys in **Settings → Hotkeys**.

## Settings

Every feature has its own switch: boards, slides, spreadsheets, embeds, ribbon buttons, shortcuts, symbol search, status bar and mobile toolbar buttons, finger drawing, palm rejection, pressure, each board tool, speaker notes, full-screen presenting, spreadsheet autocorrect and function suggestions.

## Notes

- **Spreadsheets** keep your values, formulas, sheets and row and column sizes when saved. Cell colours and number formatting from Excel are not kept.
- **Slides** use their own format, and `.pptx` files can't be opened.
- **Optional integration**: if the Home + AI plugin is installed, buttons for new boards, slides and spreadsheets are added to its home screen. You can turn this off in settings.
- **Privacy**: no network requests, no telemetry and no accounts. Everything stays in your vault.

## Installing manually

Copy `main.js`, `manifest.json` and `styles.css` from the latest release into `<your vault>/.obsidian/plugins/bits-and-bobs/`, then turn on **Bits and Bobs** in **Settings → Community plugins**.

## Building

```bash
npm install
npm run build
```

## Credits

- [SheetJS Community Edition](https://sheetjs.com) for reading and writing `.xlsx` files, under the Apache License 2.0.
- [perfect-freehand](https://github.com/steveruizok/perfect-freehand) by Steve Ruiz for pressure-sensitive strokes, under the MIT License.

## Licence

[MIT](LICENSE)
