# Bits and Bobs

Drawing boards, slides, Excel spreadsheets and maths tools for Obsidian, built to work well with Apple Pencil on iPad as well as on desktop.

## Features

### Drawing boards (`.mboard`)
- An endless board you can pan and zoom, with pen, highlighter, eraser, shapes, arrows and text.
- **Stylus support**: pressure-sensitive lines, palm rejection (once the pen touches the board, fingers pan instead of drawing), and pinch to zoom.
- **Maths boxes** that render LaTeX, such as `$$\frac{-b \pm \sqrt{b^2-4ac}}{2a}$$`.
- **Snap to shape**: draw a line, circle, rectangle or triangle, then hold the pen still at the end and it turns into a clean shape. A snapped line can be aimed before you lift, and a highlighter stroke snaps to a straight underline.
- **Lasso**: circle things with the pen to select them, then drag them together.
- **Graphs**: type `x^2 - 3` or `2sin(x)` and the curve is drawn. You can also add shaded areas (`y > x^2`), vertical lines (`x = 3`) and named points (`(1, 2) A`). The **trace** tool reads values off a curve as you drag across it.
- **Charts you type the numbers into**: press the chart button, say how many bars there are, type a name and a number for each, and choose the lowest and highest number up the side. Bar, line and pie charts, up to four sets of numbers, with side and bottom labels. Double-click a chart to change it. The command **Insert a chart into this note** puts the same kind of chart into a note as a picture.
- **Layers**: stack parts of a board, hide or lock each layer, rename and reorder them, and move a selection onto another layer. You can also lock single items so they can't be moved or erased.
- **Ruler and protractor**: drag them into place, turn them with the round handle (they click into 15° steps), and draw close to an edge for a perfectly straight line. The ruler shows its length in cm. Fingers and the mouse move the tools, and the Pencil draws against them.
- **Images** from your device, camera, clipboard, the vault, or by drag and drop. Images are saved in your attachments folder. iPhone HEIC photos are converted to JPEG automatically (on iPad, iPhone and macOS).
- Grid, dots, lined or plain backgrounds, plus undo and redo (⌘Z / ⇧⌘Z, or Ctrl+Z / Ctrl+Y).

### Slides (`.mslides`)
- Presentations where every slide works like a drawing board.
- 11 ready-made layouts: Title slide, Title & bullets, Two columns, Compare, Section header, Equation, Worked example, Graph, Picture & text, Big statement and Blank.
- **Themes**: Classic, Dark, Chalkboard, Ocean, Sunset, Paper and Midnight (colours and fonts for the whole deck), plus a font choice (clean, serif, rounded, handwriting, typewriter).
- **Transitions** (fade, slide, zoom, rise) and **one click at a time**: show bullets, or each object, as you click through.
- Slide thumbnails, speaker notes, and full-screen presenting with the keyboard, taps or swipes.
- **Draw while presenting**: pen, highlighter and laser pointer on top of the slide (**P**, **H**, **L**, clear with **C**). Drawings stay with their slide until you finish.

### Spreadsheets (`.xlsx`)
- Opens and saves real Excel files.
- Formulas with cell references and ranges, and around 55 functions, including `SUM`, `AVERAGE`, `POWER`, `SQRT`, trigonometry, logarithms, statistics and `IF`.
- A big grid to start with (200 rows and columns A to AZ) that keeps growing as you move past the edge.
- Resize rows and columns by dragging their edges. Sizes are saved in the file.
- **Formatting**: bold, italic, text and fill colours, alignment, and number formats (currency, percent, decimals, scientific).
- **Drag to fill**: drag the small square on the selection to continue numbers (1, 2 gives 3, 4, 5), weekdays and months, text such as Item 1, and formulas with their references moved.
- **Charts**: select cells and make a **bar**, **line**, **pie** or **scatter** chart. Charts update as you change the numbers, and can be saved as an image to use on a note, board or slide.
- Function suggestions as you type a formula, AutoSum, click a cell to add it to a formula, multiple sheets, copy and paste, and copy as a Markdown table.
- A switch for keyboard autocorrect and predictions.

### Share as a link
- Share any note, drawing board, slide deck, spreadsheet, PDF or picture as a web link: right-click it in the file list and choose **Share as a link**, press the share button at the top of a board or deck (or **Share** in a spreadsheet's toolbar), or run **Share this file as a link**. You need to be signed in with Keyring (see Cloud sync).
- Choose **Keep it up to date with my changes** or **Share a copy of it as it is now**, then press **Make link and copy it** and send the link to anyone. Links live at [obsidian.leroyw1e.workers.dev](https://obsidian.leroyw1e.workers.dev) and open in any web browser, phones too.
- What people see:
  - **Notes**: formatted, with maths, pictures, tables, callouts and highlights. Links to your other notes show as plain text.
  - **Boards**: drawn exactly as they look, with pan and zoom.
  - **Slides**: one slide at a time with **Next** and **Back** (or the arrow keys, or a swipe), in the deck's theme with its transitions.
  - **Spreadsheets**: formulas worked out, colours, bold, alignment, number formats and sheet tabs. Charts aren't shown online.
  - **PDFs and pictures**: shown in the page, with a download button for PDFs.
- Everything is **view only**, except spreadsheets, where you can also choose **Edit**. People change cells with the box at the top of the page. For a spreadsheet that's kept up to date, their changes come back into your spreadsheet within about 20 seconds while it's open (and on **Sync now**), and you get a message saying so. If a cell is changed in both places, the newest change wins. On a copy, their changes stay online only.
- **Editors must sign in** (spreadsheets, optional): anyone can still look, but only people signed in with Keyring can make changes. Leave it off if you want anyone with the link to be able to edit.
- **Shared links** in the Share menu, and **Shared links** in settings, list your links with **Copy link**, **Change options** and **Stop sharing**. Stopping sharing turns the link off straight away.
- Links are long and random, so they can't be guessed, but anyone you send a link to can pass it on.

### Maths in notes
- Keyboard shortcuts for common maths (see below). You can turn them off in settings.
- Type `\` then a name, such as `\alpha`, `\frac` or `\int`, to search symbols with a live preview.
- **Symbols menu** in the left sidebar, with Basics, Greek, Calculus, Functions, Matrices, Sets & logic and Geometry. Click where you want it, then tap a symbol. It also works for text boxes on boards.
- **Small raised numbers**: type `x^2` and it becomes x², `10^-3` becomes 10⁻³, and `n^(n+1)` becomes n⁽ⁿ⁺¹⁾. Only a `^` stuck to a number, letter or bracket is used, so block ids and footnotes are left alone, and it isn't used inside maths or code.
- **Auto solve**: type a sum followed by `=` and the answer appears, for example `12*(3+4)=` gives 84 and `3²+4²=` gives 25. It also converts units: `5 km =` gives 3.1069 miles, `100 F =` gives °C, and `5 km to m =` picks the unit you name. Lengths, weights, volumes, speeds, times and temperatures. If you'd rather check first, turn on **Show the answer first, press Tab to use it** and the answer appears faded after the `=`; Tab keeps it, and typing on ignores it.
- **Type `pi` for π**: `pi` on its own becomes π (or `\pi` inside maths). Words like pie, spin and pizza are left alone, and so are links and tags. Delete a π and type pi again in the same place and it stays as plain pi.
- **Real × and ÷**: `3*4` becomes 3×4 and `8/2` becomes 8÷2 as you type. Press Backspace straight after to get the plain `*` or `/` back (so `2/4` then a space still makes a fraction). Links, web addresses, dates and **bold** are left alone.
- **Number and symbol shortcuts**: type `2/4` then a space for a fraction, `sqrt(16)` for a square root, and `<=`, `>=`, `!=`, `+-`, `->` for ≤ ≥ ≠ ± →. Dates such as 1/2/2025 are left alone. Anything made of letters (Greek, integrals and so on) uses the symbols menu or the bottom row.
- **Fractions without braces**: the fraction button opens a small box with a top and a bottom. A number just before the cursor becomes the top, and a selected `3/4` turns into a fraction straight away.
- Maths buttons in the status bar on desktop and in the toolbar above the keyboard on mobile.

### PDFs and photos into notes
- Drag a PDF from Finder (or Files on iPad) onto the file list and it becomes a new note in that folder. Only the note is made: the PDF isn't kept, unless you've chosen to show the PDF itself or it had nothing in it to copy.
- The note gets the PDF's text with its look kept: big text becomes headings, bold and italic stay, bullets and numbered lists become lists, and paragraphs run on across pages. Page numbers are left out, and there's a link back to the PDF at the end. Pictures in the PDF come into the note too, in the same place among the text (a picture used on every page, like a logo, is saved once). A scanned PDF, which is only pictures, comes in as its page pictures. In settings you can choose to always show the PDF itself.
- Right-click a PDF already in your vault, or run **Make a note from a PDF**, to do the same.
- Drop photos on the file list and they become one new note showing them all (named after the photo, or **Photos** and the date for several). iPhone HEIC photos are turned into JPEGs so they show on every device.
- Dropping anything else on the file list works as normal.

### Citations
- A citation maker in its own tab: press the quote button in the left ribbon, or run **Open citations**.
- Choose **Website**, **Book**, **Journal article**, **Video** or **Newspaper or magazine** and fill in the details, or paste a web address and press **Fill in from link** to fill them in for you.
- Pick **APA 7**, **MLA 9**, **Harvard** or **Chicago**. Your list is kept in alphabetical order and changes style straight away.
- Each citation shows its in-text version too, like (Smith, 2023), with buttons to copy, change or delete it.
- **Copy all** copies the whole list with the italics kept, ready to paste into Word, Google Docs or PowerPoint. **Add to slides** adds References slides to one of your decks, and **Add to note** puts a References section at the end of a note.
- **Your Source lists**: when you're signed in (see Cloud sync below), the list menu at the top of the Citations tab shows your lists from the [Source](https://source.leroyw1e.workers.dev) website. Pick one to see and change it here; changes save to Source within a couple of seconds, and changes made on the website show up here within a minute (or press the sync button). **New Source list…** makes a list that also appears on the website, and the bin button deletes the open list in both places. **In Obsidian** is the list that only lives in this vault.

### Pictures and tags in notes
- **Move pictures and wrap text around them**: in Live Preview, click a picture for buttons to put it on the left or right with text flowing beside it, centre it, or make it bigger or smaller. Drag a picture to move it to another line. The choice is saved in the link (for example `![[photo.jpg|left|300]]`), so it looks the same in Reading view.
- **Folder tags**: new notes and notes you move get tags for the folders they're in. A note in `School work/Maths` gets `#school-work` and `#maths`, and when it moves the old folder tags come off. Run **Tag all notes with their folders** to add them to the notes you already have (it asks first).

### Cloud sync (optional)
- **Sign in with Keyring**: in **Settings → Bits and Bobs → Cloud sync**, press **Sign in with Keyring**. Your browser opens the Keyring sign-in page (passkey, email or an auth code), then comes back to Obsidian. If Obsidian doesn't open by itself, paste the code shown on the page into **Use code**.
- **Choose what to sync**: add the folders or files you want (or the whole vault). Nothing is synced until you choose something.
- **Sync now**, or turn on **Sync automatically** to sync when Obsidian opens, every 5 minutes, and shortly after you change a synced file. Sign in on your other devices with the same account to get the same files.
- **Citations** sync too, so your citation list is the same everywhere.
- If a file was changed on two devices before syncing, both copies are kept: the other device's copy is saved next to it as `name (other device date).md`.
- Deleting a synced file on one device moves it to the trash on the others.
- Each Keyring account can store up to 2 GB, and single files up to 60 MB. A sign-in lasts 30 days, then you sign in again.

### Sync files with OneDrive (optional)
- In **Settings → Bits and Bobs → Cloud sync**, set **Keep synced files in** to **OneDrive**. Your files then go straight between your devices and your own OneDrive, not through Keyring. You still choose the folders to sync, press **Sync now**, or turn on **Sync automatically**, exactly as above. Citations and share links keep using Keyring.
- Files are kept in the OneDrive folder **Apps → (the name you gave your app)**, with the same folders as in your vault. Only that folder is touched; the plugin can't see the rest of your OneDrive.
- It works with personal Microsoft accounts (outlook.com, hotmail.com, live.com). Work and school accounts aren't supported.
- If a file changed in both places, both copies are kept (the OneDrive one is saved next to yours as `name (other device date)`). A file deleted on one side is moved to the trash or recycle bin on the other. Files over 100 MB, and files with names OneDrive can't store (such as ones with `:` or `?`), are skipped.
- **One-time setup: make a free app ID.** Microsoft needs this to let a plugin sign in to OneDrive. It takes a few minutes and you only do it once:
  1. Go to [entra.microsoft.com](https://entra.microsoft.com), sign in with your Microsoft account, and open **Entra ID → App registrations → New registration**. (If it asks you to set up a free directory, accept.)
  2. Name it **Bits and Bobs** (that's the folder name you'll see in OneDrive). Under **Supported account types** choose **Personal Microsoft accounts only**. Leave the redirect address empty and press **Register**.
  3. On the page that opens, copy the **Application (client) ID**.
  4. Open **Authentication** (on the left), then **Settings**, and switch **Allow public client flows** to **Yes**. Press **Save**.
- Back in Obsidian, paste the app ID into **OneDrive app ID** and press **Connect OneDrive**. A code appears: press **Open the page**, type the code at microsoft.com/devicelogin, and sign in. This works on iPad and iPhone too.
- **Disconnect** stops syncing and forgets the sign-in on this device. It doesn't delete anything in OneDrive or in your vault.

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

On a board: **P** pen, **H** highlighter, **E** eraser, **V** select, **S** lasso, **T** text, **M** maths box, **G** graph, **C** trace, **R O L A** shapes, **1–6** colours, **[ ]** size, hold **Space** to pan, **0** to fit.

All commands can also be given your own hotkeys in **Settings → Hotkeys**.

## Settings

Every feature has its own switch: boards, slides, spreadsheets, embeds, ribbon buttons, shortcuts, symbol search, small raised numbers, auto solve, the symbols sidebar, status bar and mobile toolbar buttons, finger drawing, palm rejection, pressure, snapping shapes (and how long to hold), each board tool (including layers, ruler and protractor), speaker notes, slide effects,, drawing while presenting, full-screen presenting, and for spreadsheets autocorrect, function suggestions, formatting, drag to fill and charts.

## Notes

- **Spreadsheets** keep your values, formulas, sheets, row and column sizes, and number formats in the Excel file. Bold, italic, colours, alignment and charts are saved on an extra hidden sheet named `__bits_meta` inside the file, so Excel won't show them. Cell colours made in Excel itself are not read.
- **Slides** use their own format, and `.pptx` files can't be opened.
- **Optional integration**: if the Home + AI plugin is installed, buttons for new boards, slides and spreadsheets are added to its home screen. You can turn this off in settings.
- **Privacy**: no telemetry, and nothing is sent anywhere unless you use one of these:
  - **Fill in from link** in Citations reads that one web page.
  - **Cloud sync** is off until you sign in. After you sign in, only the folders and files you choose, and your citation list (if **Sync citations** is on), are sent to the sync server at `obsidian.leroyw1e.workers.dev` (a Cloudflare Worker), where they're stored under your Keyring account so your other devices can get them. While you're signed in, the Citations tab also reads and saves your Source citation lists at `source.leroyw1e.workers.dev` (the Source website) when it's open or when you press Sync now. Signing in happens on Keyring (`account.leroyw1e.workers.dev`); the plugin never sees your password, only a sign-in token that's kept in the plugin's settings. If you turn on **OneDrive** sync, the folders and files you choose are sent straight to your own OneDrive by Microsoft's service (`login.microsoftonline.com` and `graph.microsoft.com`), and nothing else is sent anywhere; the plugin keeps a Microsoft sign-in token in its settings until you press **Disconnect**. If you share something as a link, a copy of it (and any pictures it shows) is stored on the same server so the link works, and anyone with the link can see it; **Stop sharing** deletes it from the server. Shared pages load their Markdown, maths and PDF viewers from jsDelivr. **Delete everything in the cloud** removes your copy from the server (shared links too), and **Sign out** ends the sign-in.

## More plugins

All my Obsidian plugins, with what they do and where to get them, are at [obsidian.leroyw1e.workers.dev](https://obsidian.leroyw1e.workers.dev).

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
