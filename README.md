# VoiceOver Annotator — Figma plugin

Annotate Figma frames with iOS accessibility settings and get the generated
VoiceOver reading aloud — the way [VoiceLab / Apple's Accessibility Inspector]
works, but inside Figma.

- **Inspector** (mirrors the right panel): set Label, Value, Adjustable values,
  Traits, Text traits, Custom actions, Custom description and Hint per layer.
- **Reading order** (mirrors the left panel): every annotated layer, sorted in
  VoiceOver's default top→bottom / leading→trailing order (drag to override),
  with the exact utterance VoiceOver would speak (`Size: Medium, 2 of 3. Adjustable.`).
- **Highlight on canvas**: paints colour-coded, numbered overlays over each
  annotated element.
- **Copy script**: exports the whole reading order as plain text.

Annotations are stored on each node with `setPluginData`, so they travel with
the file and survive reopening.

## Install (development)

1. Figma desktop app → **Plugins → Development → Import plugin from manifest…**
2. Select `manifest.json` in this folder.
3. Run it from **Plugins → Development → VoiceOver Annotator**.

No build step is required — the plugin is plain JS/HTML.

## Usage

1. Select a layer (text, button, frame, image…).
2. In **Inspector**, fill in the Label and any Value / Traits.
   - For a heading, tick **Header** under *Text traits*.
   - For a button, tick **Button** under *Traits*.
   - For a segmented/stepper control, tick **Adjustable**, then **Enumerated**
     and add the values; pick the current one with the radio button.
3. The top bar shows the live VoiceOver utterance as you type.
4. Switch to **Reading order** to see the whole screen's script; click a row to
   jump to that layer on the canvas. **Drag rows** (or use the ▲▼ buttons) to
   override VoiceOver's default order — the new order is saved on the layers and
   used by the list, highlights and the description panel.
5. **Highlight on canvas** draws the overlays; **Clear** removes them.

## How the utterance is built

```
[Custom description]                      ← if set, overrides everything
Label[: Value][, N of M]. Trait. Trait.   ← otherwise generated
[Hint]                                     ← spoken after a pause
```

Trait order follows VoiceOver: state (Selected) → role (Heading / Adjustable /
Button / Link / Image / …) → Dimmed.

## Files

| File            | Role                                                |
|-----------------|-----------------------------------------------------|
| `manifest.json` | Plugin manifest                                     |
| `code.js`       | Main thread — reads/writes `pluginData`, builds list, draws highlights |
| `ui.html`       | Inspector + reading-order UI and utterance generator |
