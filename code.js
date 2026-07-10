// VoiceOver Annotator — Figma plugin (main thread)
// Stores iOS accessibility annotations on nodes via pluginData and drives the UI.

const PLUGIN_DATA_KEY = "a11y";
const HIGHLIGHT_LAYER_NAME = "♿︎ VoiceOver Annotations";

figma.showUI(__html__, { width: 380, height: 720, themeColors: true });

const SIZE_KEY = "a11y-window-size";
const MIN_W = 320;
const MIN_H = 360;

// restore the last window size the user dragged to
figma.clientStorage
  .getAsync(SIZE_KEY)
  .then((s) => {
    if (s && s.w && s.h) figma.ui.resize(s.w, s.h);
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Annotation read / write
// ---------------------------------------------------------------------------

function readAnnotation(node) {
  const raw = node.getPluginData(PLUGIN_DATA_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeAnnotation(node, annotation) {
  if (annotation == null) {
    node.setPluginData(PLUGIN_DATA_KEY, "");
  } else {
    node.setPluginData(PLUGIN_DATA_KEY, JSON.stringify(annotation));
  }
}

// ---------------------------------------------------------------------------
// VoiceOver utterance generation (kept in sync with ui.html)
// ---------------------------------------------------------------------------

// "element" (accessible) | "container" | "ignored" (non-accessible)
function annKind(a) {
  if (!a) return "element";
  if (a.kind) return a.kind;
  return a.isAccessible === false ? "ignored" : "element";
}

function resolveValue(a) {
  if (a.adjustable && a.enumerated && a.values && a.values.length) {
    const idx = Math.min(Math.max(a.selectedIndex || 0, 0), a.values.length - 1);
    return a.values[idx] || "";
  }
  return (a.value || "").trim();
}

// custom descriptions are { label, value } pairs; migrate the old single string
function getDescriptions(a) {
  if (Array.isArray(a.customDescriptions)) return a.customDescriptions;
  if (a.customDescription && a.customDescription.trim()) {
    return [{ label: "", value: a.customDescription }];
  }
  return [];
}

// spoken form of one custom description: "value, label"
function descText(d) {
  const v = (d.value || "").trim();
  const l = (d.label || "").trim();
  if (v && l) return v + ", " + l;
  return v || l;
}

function utteranceParts(a) {
  if (!a) return null;
  const kind = annKind(a);
  if (kind === "ignored") return null;
  if (kind === "container") {
    const label = (a.label || "").trim();
    if (!label) return null;
    return { main: label, traits: [], hint: "", container: true };
  }
  const label = (a.label || "").trim();
  const value = resolveValue(a);
  let main = label && value ? label + ": " + value : label || value;
  if (a.adjustable && a.enumerated && a.values && a.values.length > 1) {
    const pos = Math.min(Math.max(a.selectedIndex || 0, 0), a.values.length - 1) + 1;
    main += ", " + pos + " of " + a.values.length;
  }
  const traits = [];
  const t = a.traits || [];
  const tt = a.textTraits || [];
  if (t.indexOf("selected") !== -1) traits.push("Selected");
  if (tt.indexOf("header") !== -1) traits.push("Heading");
  if (a.adjustable || t.indexOf("adjustable") !== -1) traits.push("Adjustable");
  if (t.indexOf("button") !== -1) traits.push("Button");
  if (t.indexOf("switcher") !== -1) traits.push("Switch Button");
  if (t.indexOf("link") !== -1) traits.push("Link");
  if (t.indexOf("image") !== -1) traits.push("Image");
  if (tt.indexOf("searchField") !== -1) traits.push("Search Field");
  if (tt.indexOf("textInput") !== -1) traits.push("Text Field");
  if (t.indexOf("disabled") !== -1) traits.push("Dimmed");
  return { main, traits, hint: (a.hint || "").trim() };
}

// Custom descriptions ("value, label") and custom actions, shown as indented
// sub-lines beneath the element. Elements only (not containers/ignored).
function subLinesOf(a) {
  if (annKind(a) !== "element") return [];
  const out = [];
  getDescriptions(a).map(descText).filter(Boolean).forEach((s) => out.push(s));
  (a.customActions || []).map((s) => (s || "").trim()).filter(Boolean).forEach((s) => out.push(s));
  return out;
}

// returns { text, traitRanges:[{start,end}], hintRange } with char offsets
function buildUtterance(a) {
  const p = utteranceParts(a);
  if (!p) return null;
  let text = p.main;
  const traitRanges = [];
  for (const tr of p.traits) {
    text += ". ";
    const start = text.length;
    text += tr;
    traitRanges.push({ start, end: text.length });
  }
  if (p.traits.length) text += ".";
  let hintRange = null;
  if (p.hint) {
    text += text.endsWith(".") || text === "" ? " " : ". ";
    const start = text.length;
    text += p.hint;
    hintRange = { start, end: text.length };
  }
  return { text: text.trim(), traitRanges, hintRange, container: !!p.container };
}

// ---------------------------------------------------------------------------
// Frame discovery + reading order
// ---------------------------------------------------------------------------

// Walk up to the outermost FRAME / COMPONENT that lives directly on the page.
function topLevelFrameOf(node) {
  let current = node;
  let candidate = null;
  while (current && current.parent) {
    if (
      current.type === "FRAME" ||
      current.type === "COMPONENT" ||
      current.type === "COMPONENT_SET" ||
      current.type === "INSTANCE" ||
      current.type === "SECTION"
    ) {
      candidate = current;
    }
    if (current.parent.type === "PAGE") break;
    current = current.parent;
  }
  return candidate || node;
}

// Collect the text of every visible descendant TEXT layer, in reading order.
// Used to suggest a Label (first text layer) and Value (the rest, combined).
function innerTextParts(node) {
  const parts = [];
  const visit = (n) => {
    if (n.visible === false) return;
    if (n.type === "TEXT" && typeof n.characters === "string") {
      const t = n.characters.replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    }
    if ("children" in n) {
      for (const child of n.children) visit(child);
    }
  };
  visit(node);
  return parts;
}

function annotatedDescendants(root) {
  const out = [];
  const visit = (node) => {
    const ann = readAnnotation(node);
    if (ann) out.push({ node, ann });
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return out;
}

// iOS VoiceOver default order: top-to-bottom, then leading-to-trailing.
function readingOrderSort(a, b) {
  const ba = a.node.absoluteBoundingBox;
  const bb = b.node.absoluteBoundingBox;
  if (!ba || !bb) return 0;
  const rowThreshold = 8; // px tolerance so items roughly on one line keep L→R order
  if (Math.abs(ba.y - bb.y) > rowThreshold) return ba.y - bb.y;
  return ba.x - bb.x;
}

// Hierarchical reading order: every annotated element is nested under its
// nearest container-annotated ancestor. A container is emitted immediately
// above the first of its members (by reading order) and all its members follow
// contiguously. Within a level, items are sorted by the manual `order` field if
// set, otherwise by geometry. Returns a flat list with a `depth` per item.
function hierarchicalItems(frame) {
  const raw = annotatedDescendants(frame).filter((x) => annKind(x.ann) !== "ignored");
  if (raw.length === 0) return [];

  // geometry rank (a single comparable number per node)
  const geomRank = {};
  raw.slice().sort(readingOrderSort).forEach((x, i) => (geomRank[x.node.id] = i));

  const itemById = {};
  raw.forEach((x) => (itemById[x.node.id] = x));
  const isContainer = (x) => annKind(x.ann) === "container";
  // explicit order wins; otherwise fall back to geometry (offset so any
  // explicitly-ordered item still sorts before purely-geometric ones)
  const keyOf = (x) => (typeof x.ann.order === "number" ? x.ann.order : 1e6 + geomRank[x.node.id]);

  // nearest annotated-container ancestor within the frame
  const parentOf = {};
  for (const x of raw) {
    let p = x.node.parent;
    let found = null;
    while (p && "id" in p) {
      const cand = itemById[p.id];
      if (cand && isContainer(cand)) { found = cand.node.id; break; }
      if (p.id === frame.id) break;
      p = p.parent;
    }
    parentOf[x.node.id] = found;
  }

  const children = {};
  const roots = [];
  for (const x of raw) {
    const pid = parentOf[x.node.id];
    if (pid) (children[pid] = children[pid] || []).push(x);
    else roots.push(x);
  }

  // a container sorts at the minimum key of its whole subtree, so it lands
  // right above its first member
  const minKeyCache = {};
  const subtreeMinKey = (x) => {
    if (minKeyCache[x.node.id] !== undefined) return minKeyCache[x.node.id];
    let m = keyOf(x);
    for (const c of children[x.node.id] || []) m = Math.min(m, subtreeMinKey(c));
    return (minKeyCache[x.node.id] = m);
  };

  const sortSiblings = (list) =>
    list.slice().sort((a, b) => {
      const ka = subtreeMinKey(a), kb = subtreeMinKey(b);
      if (ka !== kb) return ka - kb;
      return (isContainer(a) ? 0 : 1) - (isContainer(b) ? 0 : 1); // container before its first member on ties
    });

  const out = [];
  const walk = (list, depth) => {
    for (const x of sortSiblings(list)) {
      out.push({ node: x.node, ann: x.ann, depth });
      if (isContainer(x)) walk(children[x.node.id] || [], depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

function buildList(frame) {
  return hierarchicalItems(frame).map(({ node, ann, depth }) => ({
    id: node.id,
    name: node.name,
    ann,
    depth,
  }));
}

// ---------------------------------------------------------------------------
// Sync helpers — push current state to the UI
// ---------------------------------------------------------------------------

async function pushSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "selection", node: null, list: [] });
    return;
  }
  let node = selection[0];

  // If a row of the description panel is selected, hop to the layer it describes
  // so the inspector shows (and edits) the real annotated element.
  if ("getPluginData" in node) {
    const linkId = node.getPluginData(LINK_KEY);
    if (linkId) {
      const src = await figma.getNodeByIdAsync(linkId);
      if (src && !src.removed) {
        figma.currentPage.selection = [src]; // re-fires selectionchange → posts for src
        return;
      }
    }
  }

  const frame = topLevelFrameOf(node);
  const textParts = innerTextParts(node);
  figma.ui.postMessage({
    type: "selection",
    node: {
      id: node.id,
      name: node.name,
      type: node.type,
      ann: readAnnotation(node),
      // Label ← first text layer; Value ← the remaining text layers combined.
      labelText: textParts[0] || "",
      valueText: textParts.slice(1).join(" "),
    },
    frame: { id: frame.id, name: frame.name },
    list: buildList(frame),
  });
}

async function pushList() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "list", list: [] });
    return;
  }
  const frame = topLevelFrameOf(selection[0]);
  figma.ui.postMessage({ type: "list", list: buildList(frame) });
}

// ---------------------------------------------------------------------------
// On-canvas highlights
// ---------------------------------------------------------------------------

const HIGHLIGHT_COLORS = [
  { r: 0.4, g: 0.78, b: 0.55 }, // green  — text / static
  { r: 0.55, g: 0.66, b: 0.96 }, // blue   — buttons
  { r: 0.74, g: 0.55, b: 0.86 }, // purple — adjustable
  { r: 0.95, g: 0.75, b: 0.42 }, // orange — image / header
];

function colorForAnnotation(ann) {
  const traits = ann.traits || [];
  if (ann.adjustable || traits.indexOf("adjustable") !== -1) return HIGHLIGHT_COLORS[2];
  if (traits.indexOf("button") !== -1 || traits.indexOf("link") !== -1) return HIGHLIGHT_COLORS[1];
  if (traits.indexOf("image") !== -1) return HIGHLIGHT_COLORS[3];
  return HIGHLIGHT_COLORS[0];
}

async function drawHighlights() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.notify("Select a frame to highlight its annotations.");
    return;
  }
  const frame = topLevelFrameOf(selection[0]);
  const items = hierarchicalItems(frame);
  if (items.length === 0) {
    figma.notify("No annotations found in this frame.");
    return;
  }

  await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });

  // Remove any previous highlight layer for this frame.
  clearHighlights();

  const overlays = [];
  items.forEach((item, index) => {
    const box = item.node.absoluteBoundingBox;
    if (!box) return;
    const color = colorForAnnotation(item.ann);

    const rect = figma.createRectangle();
    rect.name = `a11y-overlay-${index + 1}`;
    rect.x = box.x;
    rect.y = box.y;
    rect.resize(Math.max(box.width, 1), Math.max(box.height, 1));
    rect.fills = [{ type: "SOLID", color, opacity: 0.45 }];
    rect.strokes = [{ type: "SOLID", color }];
    rect.strokeWeight = 1.5;
    rect.cornerRadius = 4;
    overlays.push(rect);

    const badge = figma.createText();
    badge.fontName = { family: "Inter", style: "Semi Bold" };
    badge.fontSize = 12;
    badge.characters = String(index + 1);
    badge.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    badge.x = box.x + 4;
    badge.y = box.y + 4;
    overlays.push(badge);
  });

  if (overlays.length === 0) return;
  const group = figma.group(overlays, frame.parent || figma.currentPage);
  group.name = HIGHLIGHT_LAYER_NAME;
  group.locked = true;
  group.expanded = false;
  figma.notify(`Highlighted ${items.length} annotated element${items.length === 1 ? "" : "s"}.`);
}

function clearHighlights() {
  const existing = figma.currentPage.findAll(
    (n) => n.name === HIGHLIGHT_LAYER_NAME && n.type === "GROUP"
  );
  for (const layer of existing) layer.remove();
}

// ---------------------------------------------------------------------------
// Accumulated description panel next to the frame (left-sidebar mirror)
// ---------------------------------------------------------------------------

const PANEL_KEY = "a11yPanelId";
const LINK_KEY = "a11ySource";
const COL = {
  text: { r: 0.12, g: 0.12, b: 0.12 },
  trait: { r: 0.59, g: 0.28, b: 1 },
  hint: { r: 0.46, g: 0.46, b: 0.46 },
  num: { r: 0.6, g: 0.6, b: 0.6 },
};

async function getExistingPanel(frame) {
  const id = frame.getPluginData(PANEL_KEY);
  if (!id) return null;
  try {
    const node = await figma.getNodeByIdAsync(id);
    if (node && !node.removed) return node;
  } catch (e) {}
  return null;
}

// forceCreate=false -> only refresh a panel that already exists (live accumulate)
async function regeneratePanel(frame, forceCreate) {
  const prev = await getExistingPanel(frame);
  if (!prev && !forceCreate) return false;

  const items = hierarchicalItems(frame)
    .map((x) => ({
      id: x.node.id,
      name: x.node.name,
      depth: x.depth,
      u: buildUtterance(x.ann),
      sublines: subLinesOf(x.ann),
    }))
    .filter((x) => x.u && x.u.text);

  if (items.length === 0) {
    if (prev) prev.remove();
    frame.setPluginData(PANEL_KEY, "");
    if (forceCreate) figma.notify("No annotations in this frame yet.");
    return false;
  }

  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Medium" });
  await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });

  // keep position if a panel already exists, else park it just below the frame
  let px = frame.x;
  let py = frame.y + frame.height + 48;
  if (prev) {
    px = prev.x;
    py = prev.y;
    prev.remove();
  }

  const panel = figma.createFrame();
  panel.name = "♿︎ " + frame.name + " — VoiceOver";
  (frame.parent || figma.currentPage).appendChild(panel);
  panel.layoutMode = "VERTICAL";
  panel.primaryAxisSizingMode = "AUTO";
  panel.counterAxisSizingMode = "FIXED";
  panel.resize(Math.max(frame.width, 200), 100); // match the frame's width
  panel.itemSpacing = 7;
  panel.paddingTop = 24;
  panel.paddingBottom = 24;
  panel.paddingLeft = 24;
  panel.paddingRight = 24;
  panel.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  panel.cornerRadius = 14;
  panel.x = px;
  panel.y = py;

  const title = figma.createText();
  title.fontName = { family: "Inter", style: "Semi Bold" };
  title.fontSize = 17;
  title.characters = "VoiceOver — " + frame.name;
  title.fills = [{ type: "SOLID", color: COL.text }];
  panel.appendChild(title);
  title.layoutSizingHorizontal = "FILL"; // fill panel width (after it's in the layout)
  title.textAutoResize = "HEIGHT";

  const appendLine = (opts) => {
    const t = figma.createText();
    t.fontName = { family: "Inter", style: opts.container ? "Semi Bold" : "Regular" };
    t.fontSize = opts.container ? 15 : opts.sub ? 13 : 14;
    t.lineHeight = { value: 150, unit: "PERCENT" };
    t.characters = opts.text;
    t.fills = [{ type: "SOLID", color: opts.sub ? COL.hint : COL.text }];
    for (const r of opts.traitRanges || []) {
      t.setRangeFontName(r.start, r.end, { family: "Inter", style: "Medium" });
      t.setRangeFills(r.start, r.end, [{ type: "SOLID", color: COL.trait }]);
    }
    if (opts.hintRange) {
      t.setRangeFills(opts.hintRange.start, opts.hintRange.end, [{ type: "SOLID", color: COL.hint }]);
    }

    if (opts.depth > 0) {
      // wrap in a transparent auto-layout frame to indent the whole block
      const rowFrame = figma.createFrame();
      rowFrame.name = "row";
      panel.appendChild(rowFrame);
      rowFrame.layoutMode = "HORIZONTAL";
      rowFrame.counterAxisSizingMode = "AUTO";
      rowFrame.fills = [];
      rowFrame.paddingLeft = opts.depth * 20;
      rowFrame.layoutSizingHorizontal = "FILL";
      rowFrame.appendChild(t);
      t.layoutSizingHorizontal = "FILL";
    } else {
      panel.appendChild(t);
      t.layoutSizingHorizontal = "FILL";
    }
    t.textAutoResize = "HEIGHT";
    t.setPluginData(LINK_KEY, opts.linkId); // back-reference to the annotated source layer
  };

  items.forEach((item) => {
    const u = item.u;
    appendLine({
      text: u.text,
      depth: item.depth,
      container: u.container,
      traitRanges: u.traitRanges,
      hintRange: u.hintRange,
      linkId: item.id,
    });
    // custom descriptions + actions as indented sub-lines
    for (const sl of item.sublines) {
      appendLine({ text: sl, depth: item.depth + 1, sub: true, linkId: item.id });
    }
  });

  frame.setPluginData(PANEL_KEY, panel.id);
  return true;
}

// ---------------------------------------------------------------------------
// Messages from the UI
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "ready":
      await pushSelection();
      break;

    case "save": {
      const node = await figma.getNodeByIdAsync(msg.id);
      if (node && "setPluginData" in node) {
        try {
          writeAnnotation(node, msg.annotation);
        } catch (e) {
          figma.notify("Can't annotate this layer (it may be inside a locked instance).", { error: true });
          break;
        }
        await pushList();
        // live-accumulate: keep an existing panel in sync as you type
        const frame = topLevelFrameOf(node);
        await regeneratePanel(frame, false);
      }
      break;
    }

    case "delete": {
      const node = await figma.getNodeByIdAsync(msg.id);
      if (node && "setPluginData" in node) {
        const frame = topLevelFrameOf(node);
        writeAnnotation(node, null);
        await pushSelection();
        await regeneratePanel(frame, false);
      }
      break;
    }

    case "select": {
      const node = await figma.getNodeByIdAsync(msg.id);
      if (node && node.type !== "PAGE" && node.type !== "DOCUMENT") {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
      break;
    }

    case "reorder": {
      const ids = msg.ids || [];
      for (let i = 0; i < ids.length; i++) {
        const node = await figma.getNodeByIdAsync(ids[i]);
        if (!node || !("getPluginData" in node)) continue;
        const a = readAnnotation(node);
        if (a) {
          a.order = i;
          try {
            writeAnnotation(node, a);
          } catch (e) {}
        }
      }
      await pushSelection(); // refreshes both the list and the inspector's in-memory copy
      const sel = figma.currentPage.selection;
      if (sel.length) await regeneratePanel(topLevelFrameOf(sel[0]), false);
      break;
    }

    case "resize": {
      const w = Math.max(MIN_W, Math.round(msg.width) || MIN_W);
      const h = Math.max(MIN_H, Math.round(msg.height) || MIN_H);
      figma.ui.resize(w, h);
      figma.clientStorage.setAsync(SIZE_KEY, { w, h }).catch(() => {});
      break;
    }

    case "highlight":
      await drawHighlights();
      break;

    case "panel": {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.notify("Select a frame to build its description panel.");
        break;
      }
      const frame = topLevelFrameOf(selection[0]);
      const ok = await regeneratePanel(frame, true);
      if (ok) figma.notify("Built the VoiceOver description next to “" + frame.name + "”.");
      break;
    }

    case "clear-highlight":
      clearHighlights();
      figma.notify("Highlights removed.");
      break;

    case "export": {
      // returns the full reading list as plain data for copy/export in UI
      await pushList();
      break;
    }
  }
};

figma.on("selectionchange", () => {
  pushSelection();
});
