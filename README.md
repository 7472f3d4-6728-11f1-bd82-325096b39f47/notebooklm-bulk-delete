# NotebookLM Bulk Delete (Chrome Extension)

[日本語](README.ja.md)

A Chrome extension (Manifest V3) that lets you select multiple notebooks on the
NotebookLM (https://notebooklm.google.com) home screen (notebook list) and
delete them in bulk.

## Installation

1. Download this repository (top right "Code" → "Download ZIP" → extract it, or `git clone`)
2. Open `chrome://extensions` in Chrome
3. Turn on "Developer mode" in the top right
4. Click "Load unpacked"
5. Select the `notebooklm-bulk-delete` folder you extracted/cloned in step 1 (the folder that directly contains `manifest.json`)
6. Open the NotebookLM home screen (reload it if it's already open)

## Usage

1. Click the "Bulk Delete Mode" button that appears in the bottom right of the screen
2. Checkboxes appear in the top-left corner of each notebook card — check the ones you want to delete
   (you can also use "Select All" / "Deselect All" in the panel at the bottom of the screen)
3. Click "Delete N selected" in the panel
4. Press "OK" in the confirmation dialog, and the selected notebooks are processed
   automatically one by one (open the 3-dot menu → choose "Delete" → confirm the delete dialog)
5. Progress and errors are shown at the bottom of the panel

You can exit the mode by clicking the "Bulk Delete Mode" button again, or by clicking "Close" in the panel.

## How it works (implementation notes)

- `content.js` is injected only into `notebooklm.google.com`
- NotebookLM is an Angular SPA, and its class names and DOM structure change
  frequently across Google's releases, so all logic for locating actual DOM
  elements is centralized in the **`SELECTORS`** object at the top of `content.js`
- Each element is looked up via an array of candidate selectors plus candidate
  `aria-label`/`textContent` strings (Japanese and English), falling back
  through multiple candidates
- Waiting for elements to appear after a button click is done via `waitFor()`
  (MutationObserver + polling)

## How to fix it when it stops working (important)

At the time this repo was created, the actual NotebookLM DOM had not been
verified, so the values in `SELECTORS` are best-guess placeholders. If the
extension doesn't work or gets stuck partway through, adjust it as follows:

1. On the NotebookLM home screen, right-click the target element → "Inspect" to open DevTools
2. Check the element's tag name, `role` attribute, `aria-label`, and class names
3. Add the selector/label string you found to the corresponding entry in the
   `SELECTORS` object in `content.js` (just append to the existing array — no need to remove existing candidates)

Places that are most likely to need adjustment (in priority order):

| Item | Description |
|---|---|
| `SELECTORS.card` | Selector that identifies each notebook card on the home screen. If this doesn't match, the whole extension stops working. |
| `SELECTORS.moreButton` | The "more actions" (3-dot menu) button inside each card. If it's an icon button with no `aria-label`, you may need to add selectors based on other attributes (e.g. `data-*`). |
| `SELECTORS.menuPopup` | The popup menu that appears when the 3-dot menu is opened. Depends on Angular Material's CDK Overlay structure, so it changes often. |
| `SELECTORS.deleteMenuItem` | The selector/label string for the "Delete" item inside the menu. |
| `SELECTORS.confirmDialog` / `SELECTORS.confirmDeleteButton` | The delete confirmation dialog itself, and its confirm button. If the button label is something other than "Delete" (e.g. "Delete permanently"), add it to the label array. |
| `SELECTORS.cardTitle` | Selector used to read the card title for progress display. Not required for the extension to work — without it, the title just shows as "(unknown title)". |

Since each selector is an array, we recommend **appending new values instead of
removing existing ones** — this makes it easier to support multiple DOM
versions at once.

## File structure

- `manifest.json` — Manifest V3 definition (injects the content script only into `notebooklm.google.com`)
- `content.js` — Main logic (UI generation, DOM lookup, delete flow automation)
- `content.css` — Styles for the toggle button, panel, and checkboxes
- `README.md` — This file

## Permissions

No `permissions` are used. `content_scripts.matches` restricts the extension's
scope to `https://notebooklm.google.com/*` only.
