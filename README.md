# Cuttings

A browser extension that takes a cutting from any page — the element, your sentence, and a clip if it moves — into a folder of markdown notes.

It keeps the numbers and the motion, not just the picture. Beside every still: the type, the palette, the padding, and the `transition` / `animation` declared on the element and its ancestors. Your note says "nice, slow"; the file says `cubic-bezier(.2,.8,.2,1) 420ms`.

## Install

Not in the Web Store. Load it from this folder:

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this folder.
2. `chrome://extensions/shortcuts` → make sure Cuttings has **⌥C** (Chrome sometimes drops it).
3. Take a cutting. The first one asks for a folder; every one after lands there.

Works in Chrome, Arc, Dia, Brave — anything Chromium.

## Keys

| | |
|---|---|
| **⌥C** | start — the cursor becomes a crosshair, hovering reads the type and spacing off every element |
| **click** | a still |
| **⇧click** | record that element — **⇧click** or **⏎** stops, 20s cap |
| **⌥click** | the whole thing, taller than the screen |
| **↑ ↓** | lift the selection to the parent, and back |
| **R** | redlines — every block boxed with its x, width, padding, gap |
| **C** | copy the element's address, for pasting into a chat |
| **esc** | leave |

While recording, plain clicks go to the page, so you can set off the motion you're recording.

## What lands

```
cuttings/
  2026-09-14-142211-stripe-com.md
  2026-09-14-142211-stripe-com/
    still.png
    clip.webm
```

The `.md` has your sentence as the title, the source, and a **Measured** section: element and size, type, palette, motion, computed styles. Obsidian, iA Writer, or any folder-of-markdown reader shows it as a note with the image inline.

## Why

Inspiration libraries collect beautifully and let you say nothing. Annotation tools are for feedback on your own site. Nothing collects *a fragment of someone else's page plus the reason you noticed it* — so this does. A cutting is a piece taken from someone else's plant to grow your own.
