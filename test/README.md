# Harness

Runs `content.js` unmodified in a plain page with a stubbed `chrome.*`, so the picker can be
driven and asserted without loading the extension into Chrome. The fixture reproduces the trap
that broke real captures: a transparent full-viewport wrapper (`#glass`) and a transparent band
(`#band`) sitting on top of the artwork, plus a card whose *ancestor* carries the transition.

    python3 -m http.server 5321 --directory "$(dirname "$0")/.."
    open http://localhost:5321/test/

Then in the console:

    pick()                        // as if ⌥⇧C
    at(640, 500, 'mousemove')     // over the transparent band
    boxLabel()                    // must be canvas#art, never div#band or div#glass
    press('ArrowUp')              // lift the selection to the parent
    at(200, 200, 'click')         // still → opens the note card
    shiftClick(200, 200)          // starts a take; click again or press Enter to stop
    __sent                        // the messages that would have gone to the background

The viewport must be non-zero or `elementsFromPoint` returns nothing and every pick looks broken.
