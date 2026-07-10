# VoiceOver Annotator — Figma plugin

Annotate Figma frames with iOS accessibility settings and get the generated
VoiceOver reading aloud — the way [VoiceOver Designer](https://github.com/akaDuality/VoiceOverDesigner)
and [Apple's Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector)
work, but inside Figma.

- **Element inspector**: mark a layer Accessible / Container / Non-accessible,
  then set Label, Value, Adjustable (enumerated) values, Traits, Text traits,
  Behaviour traits, Custom actions and Custom descriptions per layer.
- **Reading order**: every annotated layer, sorted in VoiceOver's default
  top→bottom / leading→trailing order (drag to override), with the exact
  utterance VoiceOver would speak (`Size: Medium, 2 of 3. Adjustable.`).
- **Outline accessibility frames**: colour-coded, numbered overlays over each
  annotated element on the canvas.
- **Annotate → Below frame**: a live description panel next to the frame.
- **Annotate → Dev Mode**: native Figma annotations, visible in Dev Mode.
- **Download preview**: export a `.vodesign` package (controls.json + info.json
  + screen.png) for the [VoiceOver Designer](https://github.com/akaDuality/VoiceOverDesigner) app.
- **Auto-annotate**: **Quick suggest** (local name heuristic, no network) or
  **Generate with AI** (Anthropic Claude or OpenAI — your key, stored locally).

Annotations are stored on each node with `setPluginData`, so they travel with
the file and survive reopening.

## Install (development)

1. Figma desktop app → **Plugins → Development → Import plugin from manifest…**
2. Select `manifest.json` in this folder.
3. Run it from **Plugins → Development → VoiceOver Annotator**.

No build step is required — the plugin is plain JS/HTML.

## Usage

1. Select a layer (text, button, frame, image…).
2. In the **Element** tab, choose the kind, then fill in the Label and any
   Value / Traits.
   - For a heading, tick **Header**; for a button, tick **Button**.
   - For a segmented/stepper control, tick **Adjustable**, then **Enumerated**
     and add the values; pick the current one with the radio button.
   - Focused empty Label / Value fields suggest the layer's own text — press
     **→** to accept.
3. The preview shows the live VoiceOver utterance as you type.
4. Switch to **Reading order** to see the whole screen's script; click a row to
   jump to that layer on the canvas. **Drag rows** (or use the ▲▼ buttons) to
   override VoiceOver's default order — the new order is saved on the layers.
5. Use **Outline accessibility frames** to draw the overlays (clear them from
   **Settings**), the **Annotate** buttons for the on-canvas panel or Dev Mode
   annotations, and **Download preview** to export a `.vodesign` package.

## AI annotation

**Generate with AI** sends the selected frame's layer structure (names, types,
geometry, text — not the image) to Anthropic (`claude-opus-4-8`) or OpenAI
(`gpt-4o`), guided by the [iOS Accessibility Skill](https://github.com/akaDuality/iOSAccessibilitySkill),
and writes the result into the same annotation model for you to refine. Your API
key is entered in **Settings** and stored only on your machine via
`figma.clientStorage`; it never travels with the file. `manifest.json` allows
network access to `api.anthropic.com` and `api.openai.com` for this.

## How the utterance is built

```
Label[: Value][, N of M]. Trait. Trait.   ← generated from the annotation
[Hint]                                     ← spoken after a pause, if set
```

Trait order follows VoiceOver: state (Selected) → role (Heading / Adjustable /
Button / Link / Image / …) → Dimmed. (`Hint` is part of the data model and is
spoken/exported, but has no dedicated editor in the current UI.)

## Files

| File            | Role                                                |
|-----------------|-----------------------------------------------------|
| `manifest.json` | Plugin manifest                                     |
| `code.js`       | Main thread — reads/writes `pluginData`, builds list, draws highlights |
| `ui.html`       | Inspector + reading-order UI and utterance generator |

## Related

- [VoiceOver Designer](https://github.com/akaDuality/VoiceOverDesigner) — desktop app that reads the `.vodesign` format (with containers) this plugin can export to.
- [iOS Accessibility Skill](https://github.com/akaDuality/iOSAccessibilitySkill) — Claude Code skill with the iOS accessibility rules (label → value → trait) used to guide AI annotation.
- [*About accessibility on iOS*](https://rubanov.dev/a11y-book/) — the book by Mikhail Rubanov the skill is based on.
- [Apple's Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector) — Apple's tool for auditing accessibility.
