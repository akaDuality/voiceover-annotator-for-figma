// VoiceOver Annotator — Figma plugin (main thread)
// Stores iOS accessibility annotations on nodes via pluginData and drives the UI.

const PLUGIN_DATA_KEY = "a11y";
const HIGHLIGHT_LAYER_NAME = "♿︎ VoiceOver Annotations";

figma.showUI(__html__, { width: 380, height: 900, themeColors: true });

const SIZE_KEY = "a11y-window-size";
const MIN_W = 320;
const MIN_H = 360;

// AI settings — stored locally per user via figma.clientStorage (never in the file).
const AI_PROVIDER_KEY = "a11y-ai-provider";
const ANTHROPIC_KEY = "a11y-anthropic-key";
const OPENAI_KEY = "a11y-openai-key";

// PNG export scale for .vodesign — the same value is written as info.imageScale
// so the overlays always line up with the exported image.
const EXPORT_SCALE = 3;

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
  if (a.adjustable && a.values && a.values.length) {
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
  if (a.adjustable) traits.push("Adjustable");
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
  if (!ba && !bb) return 0;
  if (!ba) return 1; // nodes without a rendered box sort deterministically last
  if (!bb) return -1;
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
  // explicit order wins; un-ordered (newly annotated) items fall back to their
  // geometry rank so they interleave by on-screen position instead of always
  // sorting after every manually-ordered item.
  const keyOf = (x) => (typeof x.ann.order === "number" ? x.ann.order : geomRank[x.node.id]);

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
  const walk = (list, depth, parentId) => {
    for (const x of sortSiblings(list)) {
      out.push({ node: x.node, ann: x.ann, depth, parentId });
      if (isContainer(x)) walk(children[x.node.id] || [], depth + 1, x.node.id);
    }
  };
  walk(roots, 0, null);
  return out;
}

function buildList(frame) {
  return hierarchicalItems(frame).map(({ node, ann, depth, parentId }) => ({
    id: node.id,
    name: node.name,
    ann,
    depth,
    parentId: parentId || null, // reading-order parent container, for same-parent reordering
  }));
}

// ---------------------------------------------------------------------------
// Sync helpers — push current state to the UI
// ---------------------------------------------------------------------------

// Which annotation outputs already exist for a frame (drives button "on" state):
//  panel  — a description panel next to the frame ("Below frame")
//  native — native Figma annotations present on any element ("Dev Mode")
async function frameAnnotationState(frame) {
  let panel = false;
  try { panel = !!(await getExistingPanel(frame)); } catch (e) {}
  let native = false;
  for (const { node } of hierarchicalItems(frame)) {
    if ("getPluginData" in node && node.getPluginData(NATIVE_KEY)) {
      native = true;
      break;
    }
  }
  return { panel, native };
}

async function pushFrameState(frame) {
  const s = frame ? await frameAnnotationState(frame) : { panel: false, native: false };
  figma.ui.postMessage({ type: "frame-state", panel: s.panel, native: s.native });
}

// Monotonic token: rapid selection changes run pushSelection concurrently, and
// a slower earlier call must not post after a newer one and show the wrong node.
let selectionSeq = 0;

async function pushSelection() {
  const seq = ++selectionSeq;
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "selection", node: null, list: [] });
    figma.ui.postMessage({ type: "frame-state", panel: false, native: false });
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
  if (seq !== selectionSeq) return; // a newer selection superseded this one
  figma.ui.postMessage({
    type: "selection",
    node: {
      id: node.id,
      name: node.name,
      type: node.type,
      ann: readAnnotation(node),
      // Label ← first text layer; Value ← the remaining text layers, one per row.
      labelText: textParts[0] || "",
      valueText: textParts.slice(1).join("\n"),
    },
    frame: { id: frame.id, name: frame.name },
    list: buildList(frame),
  });
  if (seq !== selectionSeq) return;
  await pushFrameState(frame);
}

async function pushList() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "list", list: [] });
    return;
  }
  const frame = topLevelFrameOf(selection[0]);
  figma.ui.postMessage({ type: "list", list: buildList(frame) });
  await pushFrameState(frame);
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
  if (ann.adjustable) return HIGHLIGHT_COLORS[2];
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

  // Remove only THIS frame's previous highlight layer (not other frames').
  clearHighlightsForFrame(frame);

  const overlays = [];
  items.forEach((item, index) => {
    const node = item.node;
    const box = node.absoluteBoundingBox;
    if (!box) return;
    const color = colorForAnnotation(item.ann);

    const rect = figma.createRectangle();
    rect.name = `a11y-overlay-${index + 1}`;
    // Match the node's own size + absolute rotation/position so rotated elements
    // get a tight, rotated overlay instead of an inflated axis-aligned box.
    rect.resize(Math.max(node.width, 1), Math.max(node.height, 1));
    if (node.absoluteTransform) {
      rect.relativeTransform = node.absoluteTransform; // rect is page-parented → relative == absolute
    } else {
      rect.x = box.x;
      rect.y = box.y;
    }
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
    badge.x = box.x + 4; // badge stays upright at the element's top-left corner
    badge.y = box.y + 4;
    overlays.push(badge);
  });

  if (overlays.length === 0) return;
  const group = figma.group(overlays, frame.parent || figma.currentPage);
  group.name = HIGHLIGHT_LAYER_NAME;
  group.setPluginData(HIGHLIGHT_FRAME_KEY, frame.id); // scope so redraws only clear this frame
  group.locked = true;
  group.expanded = false;
  figma.notify(
    `Highlighted ${items.length} annotated element${items.length === 1 ? "" : "s"} — re-run after moving layers.`
  );
}

const HIGHLIGHT_FRAME_KEY = "a11yHlFrame";

// Remove only the highlight group belonging to a specific frame.
function clearHighlightsForFrame(frame) {
  const existing = figma.currentPage.findAll(
    (n) =>
      n.type === "GROUP" && n.name === HIGHLIGHT_LAYER_NAME &&
      "getPluginData" in n && n.getPluginData(HIGHLIGHT_FRAME_KEY) === frame.id
  );
  for (const layer of existing) layer.remove();
}

// Remove every highlight group on the page (the explicit "Clear" action).
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
// Debounced live-panel refresh: coalesce rapid saves (typing) into one rebuild.
let panelTimer = null;
function schedulePanelRegen(frame) {
  if (panelTimer) clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    panelTimer = null;
    regeneratePanel(frame, false);
  }, 600);
}

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
// .vodesign export (VoiceOver Designer markup)
// ---------------------------------------------------------------------------

// this plugin's string trait keys -> VoiceOver Designer numeric trait bitmask
// Switch Button lives at bit 53 (2^53) — beyond JS 32-bit bitwise ops, so trait
// bitmasks are combined by ADDITION (distinct powers of two) and this high bit
// is read arithmetically.
const SWITCH_TRAIT = 9007199254740992; // 2^53
const TRAIT_BITS = {
  button: 1, header: 2, adjustable: 4, switcher: SWITCH_TRAIT, link: 8, selected: 16,
  image: 32, staticText: 64, summaryElement: 128, updatesFrequently: 256,
  playsSound: 512, startsMediaSession: 1024, allowsDirectInteraction: 2048,
  causesPageTurn: 4096, textInput: 8192, isEditing: 16384, searchField: 32768,
  keyboardKey: 65536, disabled: 131072,
};

// Returns a BigInt so switch(2^53) combined with odd low bits (e.g. + button)
// stays exact — a JS Number would round 2^53+1 down to 2^53.
function traitsToBitmask(a) {
  let bits = 0n;
  const added = {};
  const add = (k) => {
    const v = TRAIT_BITS[k];
    if (v && !added[v]) { bits += BigInt(v); added[v] = 1; }
  };
  (a.traits || []).forEach(add);
  (a.textTraits || []).forEach(add);
  if (a.adjustable) add("adjustable");
  return bits;
}

// JSON.stringify can't serialize BigInt, so encode any BigInt as a sentinel
// string, then unquote it back to an exact integer literal (VoiceOver Designer
// decodes it losslessly into a 64-bit trait).
function stringifyControls(controls) {
  const json = JSON.stringify(
    controls,
    (k, v) => (typeof v === "bigint" ? "@@int:" + v.toString() + "@@" : v),
    2
  );
  return json.replace(/"@@int:(\d+)@@"/g, "$1");
}

// hex-only UUID (VoiceOver Designer requires 0-9 A-F)
function newUUID() {
  const chars = "0123456789ABCDEF";
  let s = "";
  for (let i = 0; i < 36; i++) {
    s += i === 8 || i === 13 || i === 18 || i === 23 ? "-" : chars[Math.floor(Math.random() * 16)];
  }
  return s;
}

// Build controls.json in the reading order the user set (manual `order`),
// elements only — containers are intentionally skipped for now (see issue).
function buildControls(frame) {
  const fb = frame.absoluteBoundingBox;
  return hierarchicalItems(frame)
    .filter((x) => annKind(x.ann) === "element")
    .map(({ node, ann }) => {
      const b = node.absoluteBoundingBox;
      const x = fb && b ? Math.round(b.x - fb.x) : 0;
      const y = fb && b ? Math.round(b.y - fb.y) : 0;
      const w = b ? Math.round(b.width) : 0;
      const h = b ? Math.round(b.height) : 0;
      const enumerated = !!(ann.adjustable && ann.enumerated);
      const options = enumerated ? (ann.values || []).slice() : [];
      const currentIndex = options.length
        ? Math.min(Math.max(ann.selectedIndex || 0, 0), options.length - 1)
        : 0;
      const descriptions = getDescriptions(ann)
        .map((d) => ({ label: (d.label || "").trim(), value: (d.value || "").trim() }))
        .filter((d) => d.label || d.value);
      return {
        hint: (ann.hint || "").trim(),
        id: newUUID(),
        frame: [[x, y], [w, h]],
        customActions: {
          names: (ann.customActions || []).map((s) => (s || "").trim()).filter(Boolean),
        },
        isAccessibilityElement: true,
        customDescriptions: { descriptions: descriptions },
        label: (ann.label || "").trim(),
        adjustableOptions: {
          options: options,
          isEnumerated: !!ann.enumerated,
          currentIndex: currentIndex,
        },
        value: resolveValue(ann),
        trait: traitsToBitmask(ann),
      };
    });
}

// ---------------------------------------------------------------------------
// Native Figma annotations (shown in Dev Mode)
// ---------------------------------------------------------------------------

// pluginData marker storing the exact native-annotation label this plugin
// wrote on a node, so we can update/remove only our own — never the user's.
const NATIVE_KEY = "a11yNativeLabel";

// Find the built-in "Accessibility" annotation category. Returns undefined
// (no category) rather than guessing a wrong one when none matches.
async function accessibilityCategoryId() {
  if (!figma.annotations || !figma.annotations.getAnnotationCategoriesAsync) return undefined;
  try {
    const cats = await figma.annotations.getAnnotationCategoriesAsync();
    const a11y = cats.find((c) => /accessib/i.test(c.label || ""));
    return a11y ? a11y.id : undefined;
  } catch (e) {
    return undefined;
  }
}

// Write each annotated element/container's utterance as a native Figma
// annotation (visible in Dev Mode), preserving any annotations the plugin
// didn't create and replacing only its own previous one (idempotent).
async function syncNativeAnnotations(frame) {
  const categoryId = await accessibilityCategoryId();
  let count = 0;
  for (const { node, ann } of hierarchicalItems(frame)) {
    if (!("annotations" in node)) continue;
    const u = buildUtterance(ann);
    if (!u || !u.text) continue;
    const subs = subLinesOf(ann);
    const label = u.text + subs.map((s) => "\n• " + s).join("");
    const prev = "getPluginData" in node ? node.getPluginData(NATIVE_KEY) : "";
    const others = (node.annotations || []).filter((a) => !(prev && a.label === prev));
    try {
      node.annotations = others.concat([categoryId ? { label, categoryId } : { label }]);
      if ("setPluginData" in node) node.setPluginData(NATIVE_KEY, label);
      count++;
    } catch (e) {}
  }
  return count;
}

// Remove only the native annotations this plugin created for the frame.
function removeNativeAnnotations(frame) {
  let removed = 0;
  for (const { node } of hierarchicalItems(frame)) {
    if (!("annotations" in node) || !("getPluginData" in node)) continue;
    const prev = node.getPluginData(NATIVE_KEY);
    if (!prev) continue;
    const kept = (node.annotations || []).filter((a) => a.label !== prev);
    if (kept.length !== (node.annotations || []).length) {
      try { node.annotations = kept; removed++; } catch (e) {}
    }
    node.setPluginData(NATIVE_KEY, "");
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Auto-annotation — local heuristic + AI (Anthropic / OpenAI)
// ---------------------------------------------------------------------------

// VoiceOver Designer numeric trait bitmask -> this plugin's string trait model.
function bitmaskToAnn(trait) {
  trait = trait || 0;
  const traits = [];
  const textTraits = [];
  const low = trait % SWITCH_TRAIT; // 32-bit-safe portion (all defined low bits < 2^18)
  const has = (bit) => (low & bit) !== 0;
  if (has(1)) traits.push("button");
  if (has(8)) traits.push("link");
  if (has(16)) traits.push("selected");
  if (has(32)) traits.push("image");
  if (has(128)) traits.push("summaryElement");
  if (has(256)) traits.push("updatesFrequently");
  if (has(512)) traits.push("playsSound");
  if (has(1024)) traits.push("startsMediaSession");
  if (has(2048)) traits.push("allowsDirectInteraction");
  if (has(4096)) traits.push("causesPageTurn");
  if (has(131072)) traits.push("disabled");
  if (Math.floor(trait / SWITCH_TRAIT) % 2 === 1) traits.push("switcher");
  if (has(2)) textTraits.push("header");
  if (has(64)) textTraits.push("staticText");
  if (has(8192)) textTraits.push("textInput");
  if (has(16384)) textTraits.push("isEditing");
  if (has(32768)) textTraits.push("searchField");
  if (has(65536)) textTraits.push("keyboardKey");
  return { traits, textTraits, adjustable: has(4) };
}

// Local, name-based fallback analyzer. Returns [{ node, ann }] in our model.
// Defaults to static text (not button) when nothing signals interactivity.
function guessTraits(name, type) {
  if (/header|title|заголовок|название/.test(name)) return { traits: [], textTraits: ["header"] };
  if (/tab/.test(name)) return { traits: ["button", "causesPageTurn"], textTraits: [] };
  if (/button|btn|back|cell|ячейка|кнопка|item|элемент/.test(name)) return { traits: ["button"], textTraits: [] };
  return { traits: [], textTraits: ["staticText"] };
}

function heuristicAnnotations(frame) {
  const out = [];
  const visit = (n) => {
    if (n.visible === false) return;
    const name = (n.name || "").toLowerCase();
    if (name.includes("status bar")) return;
    const interactiveName = /cell|button|btn|tab|header|title|back|ячейка|кнопка|заголовок/.test(name);
    const parts = innerTextParts(n);
    const box = n.absoluteBoundingBox;
    const small = !!(box && box.width <= 48 && box.height <= 48);
    const include = interactiveName || n.type === "TEXT" || n.type === "INSTANCE";
    let decorative =
      /background|container|wrapper/.test(name) ||
      (name.includes("icon") && !name.includes("button"));
    // an unlabeled, small instance is almost certainly decorative (icon/avatar/chevron)
    if (n.type === "INSTANCE" && !interactiveName && parts.length === 0 && small) decorative = true;
    if (include && !decorative) {
      const t = guessTraits(name, n.type);
      out.push({
        node: n,
        ann: {
          kind: "element",
          label: (parts[0] || n.name || "").trim(),
          value: parts.slice(1).join(" ").trim(),
          hint: "",
          adjustable: false,
          enumerated: false,
          values: [],
          selectedIndex: 0,
          traits: t.traits,
          textTraits: t.textTraits,
          customActions: [],
          customDescriptions: [],
        },
      });
      return; // treat as one element; don't descend into it
    }
    if ("children" in n) for (const c of n.children) visit(c);
  };
  if ("children" in frame) for (const c of frame.children) visit(c);
  return out;
}

// Layer tree (with nodeId + frame-relative coords + text) sent to the AI.
function collectFrameData(frame) {
  const fb = frame.absoluteBoundingBox;
  const visit = (n) => {
    if (n.visible === false) return null;
    if ((n.name || "").toLowerCase().includes("status bar")) return null;
    const b = n.absoluteBoundingBox;
    const d = {
      nodeId: n.id,
      name: n.name,
      type: n.type,
      x: fb && b ? Math.round(b.x - fb.x) : 0,
      y: fb && b ? Math.round(b.y - fb.y) : 0,
      width: b ? Math.round(b.width) : 0,
      height: b ? Math.round(b.height) : 0,
    };
    if (n.type === "TEXT" && typeof n.characters === "string") {
      const t = n.characters.replace(/\s+/g, " ").trim();
      if (t) d.text = t;
    }
    if ("children" in n) {
      const kids = [];
      for (const c of n.children) {
        const cd = visit(c);
        if (cd) kids.push(cd);
      }
      if (kids.length) d.children = kids;
    }
    return d;
  };
  const out = [];
  if ("children" in frame) {
    for (const c of frame.children) {
      const cd = visit(c);
      if (cd) out.push(cd);
    }
  }
  return out;
}

// Distilled from the iOS Accessibility Skill (github.com/akaDuality/iOSAccessibilitySkill).
const AI_SKILL =
  'Follow the iOS Accessibility Skill (github.com/akaDuality/iOSAccessibilitySkill), based on the book "About accessibility on iOS" by Mikhail Rubanov.\n\n' +
  "Structure every element as label -> value -> trait:\n" +
  '- label: the name / main content the user scans for. Keep it short. NEVER put the element type ("button", "cell", "image") in the label — the trait already says it.\n' +
  '- value: secondary or additional content, or the current state (e.g. "On", "3 of 5"). Empty if there is none.\n' +
  "- trait: the role/state as a bitmask, summed: button 1, header 2, adjustable 4, link 8, selected 16, image 32, static text 64, updates frequently 256, text input 8192, is editing 16384, search field 32768, disabled 131072, switch button 9007199254740992. Combine by summing, e.g. selected button = 17.\n" +
  "- hint: what happens on activation (optional, starts with a verb).\n\n" +
  "Rules:\n" +
  "- One accessibility element per meaningful control. Collapse a cell/row into ONE element (label = title, value = subtitle/detail).\n" +
  "- Interactive layers (buttons, cells, tabs, links) set the button/link bit.\n" +
  "- Headings and section titles set the header bit (2).\n" +
  "- Adjustable controls (segmented, stepper, slider) set bit 4 with the choices in options and isEnumerated true. A switch/toggle uses the switch-button trait (9007199254740992).\n" +
  "- Hide decorative layers (icons, avatars, chevrons, backgrounds) — do NOT emit them.\n" +
  "- Skip the status bar.";

function buildAIPrompt(frameName, frameData) {
  return (
    AI_SKILL +
    '\n\nAnalyze the Figma frame "' + frameName + '" and produce VoiceOver annotations.\n' +
    "Layer tree (JSON; coordinates are relative to the frame):\n" +
    JSON.stringify(frameData) +
    "\n\nReturn ONLY a JSON object of exactly this shape, no prose:\n" +
    '{"elements":[{"nodeId":"<echo this layer\'s nodeId>","label":"","value":"","hint":"","trait":1,"options":[],"isEnumerated":false,"actions":[]}]}'
  );
}

// JSON Schema for structured output (guarantees parseable results).
const AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["elements"],
  properties: {
    elements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nodeId", "label", "value", "hint", "trait", "options", "isEnumerated", "actions"],
        properties: {
          nodeId: { type: "string" },
          label: { type: "string" },
          value: { type: "string" },
          hint: { type: "string" },
          trait: { type: "integer" },
          options: { type: "array", items: { type: "string" } },
          isEnumerated: { type: "boolean" },
          actions: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function fetchWithTimeout(url, options, ms) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), ms)),
  ]);
}

// One retry on rate-limit / overload, honouring Retry-After.
async function apiFetch(url, options) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(url, options, 120000);
    if (res.ok || attempt >= 1 || [429, 503, 529].indexOf(res.status) === -1) return res;
    const ra = parseInt(res.headers.get("retry-after") || "", 10);
    await new Promise((r) => setTimeout(r, (ra > 0 ? ra : 3) * 1000));
  }
}

// Calls the selected provider and returns the parsed elements array.
async function generateWithAI(provider, key, frameName, frameData) {
  const prompt = buildAIPrompt(frameName, frameData);
  let content;
  if (provider === "openai") {
    const res = await apiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.2,
        max_tokens: 16000,
        response_format: {
          type: "json_schema",
          json_schema: { name: "voiceover_annotations", strict: true, schema: AI_SCHEMA },
        },
        messages: [
          { role: "system", content: "You output only valid JSON matching the schema." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error((e.error && e.error.message) || "OpenAI HTTP " + res.status);
    }
    const data = await res.json();
    const choice = (data.choices || [])[0];
    if (choice && choice.finish_reason === "length") {
      throw new Error("The frame is too large for one request — try a smaller selection.");
    }
    content = choice && choice.message ? choice.message.content : "";
  } else {
    const res = await apiFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 16000,
        system: "You output only valid JSON matching the schema.",
        output_config: { format: { type: "json_schema", schema: AI_SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error((e.error && e.error.message) || "Anthropic HTTP " + res.status);
    }
    const data = await res.json();
    if (data.stop_reason === "max_tokens") {
      throw new Error("The frame is too large for one request — try a smaller selection.");
    }
    content = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  }
  content = (content || "").trim();
  if (content.indexOf("```") === 0) {
    content = content.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
  }
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : parsed.elements || parsed.controls || [];
}

// Writes AI/heuristic results into pluginData, skipping already-annotated nodes.
async function applyGenerated(elements) {
  let created = 0;
  let skipped = 0;
  let unmatched = 0; // results whose nodeId didn't resolve to an annotatable layer
  for (const el of elements) {
    if (!el || !el.nodeId) { unmatched++; continue; }
    const node = await figma.getNodeByIdAsync(el.nodeId);
    if (!node || node.removed || !("setPluginData" in node)) { unmatched++; continue; }
    if (readAnnotation(node)) { skipped++; continue; } // keep existing manual work
    const m = bitmaskToAnn(el.trait || 0);
    const options = Array.isArray(el.options) ? el.options : [];
    try {
      writeAnnotation(node, {
        kind: "element",
        label: (el.label || "").trim(),
        value: (el.value || "").trim(),
        hint: (el.hint || "").trim(),
        adjustable: m.adjustable,
        enumerated: m.adjustable && !!el.isEnumerated,
        values: m.adjustable ? options : [],
        selectedIndex: 0,
        traits: m.traits,
        textTraits: m.textTraits,
        customActions: Array.isArray(el.actions) ? el.actions.filter(Boolean) : [],
        customDescriptions: [],
      });
      created++;
    } catch (e) {}
  }
  return { created, skipped, unmatched };
}

// ---------------------------------------------------------------------------
// Messages from the UI
// ---------------------------------------------------------------------------

// Rapid pointer movement can leave several getNodeByIdAsync calls in flight.
// Only the most recent hovered row is allowed to update Figma's selection.
let hoverSelectionSeq = 0;

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
        // live-accumulate: keep an existing panel in sync, but debounced so it
        // doesn't rebuild every text node on every keystroke.
        schedulePanelRegen(topLevelFrameOf(node));
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
      hoverSelectionSeq++; // a deliberate click supersedes any pending hover
      const node = await figma.getNodeByIdAsync(msg.id);
      if (node && node.type !== "PAGE" && node.type !== "DOCUMENT") {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
      break;
    }

    case "hover-select": {
      const seq = ++hoverSelectionSeq;
      const node = await figma.getNodeByIdAsync(msg.id);
      if (seq !== hoverSelectionSeq) break;
      if (node && node.type !== "PAGE" && node.type !== "DOCUMENT") {
        const selected = figma.currentPage.selection;
        // Avoid another selectionchange/render cycle when the rebuilt row under
        // the stationary pointer reports the same hover again.
        if (selected.length !== 1 || selected[0].id !== node.id) {
          figma.currentPage.selection = [node];
        }
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
      const existing = await getExistingPanel(frame);
      if (existing) {
        existing.remove();
        frame.setPluginData(PANEL_KEY, "");
        figma.notify("Removed the description panel.");
      } else {
        const ok = await regeneratePanel(frame, true);
        if (ok) figma.notify("Built the VoiceOver description next to “" + frame.name + "”.");
      }
      await pushFrameState(frame);
      break;
    }

    case "native-annotate": {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.notify("Select a frame to annotate.");
        break;
      }
      const frame = topLevelFrameOf(selection[0]);
      const state = await frameAnnotationState(frame);
      if (state.native) {
        const removed = removeNativeAnnotations(frame);
        figma.notify("Removed Figma annotations from " + removed + " element" + (removed === 1 ? "" : "s") + ".");
      } else {
        let n;
        try {
          n = await syncNativeAnnotations(frame);
        } catch (e) {
          figma.notify("Couldn't add Figma annotations here.", { error: true });
          break;
        }
        figma.notify(
          n ? "Added " + n + " Figma annotation" + (n === 1 ? "" : "s") + " — open Dev Mode to see them."
            : "No annotated elements to mark."
        );
      }
      await pushFrameState(frame);
      break;
    }

    case "clear-highlight":
      clearHighlights();
      figma.notify("Highlights removed.");
      break;

    case "export-vodesign": {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.notify("Select a frame to export.");
        break;
      }
      const frame = topLevelFrameOf(selection[0]);
      if (!("exportAsync" in frame)) {
        figma.notify("This selection can't be exported to .vodesign.", { error: true });
        break;
      }
      const controls = buildControls(frame);
      if (controls.length === 0) {
        figma.notify("No annotated elements in this frame to export.");
        break;
      }
      let pngData;
      try {
        pngData = await frame.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: EXPORT_SCALE } });
      } catch (e) {
        figma.notify("Couldn't render the frame PNG.", { error: true });
        break;
      }
      // imageScale must equal the PNG export scale for VoiceOver Designer to
      // align the overlays with the image — keep them tied to one constant.
      const info = { id: newUUID(), imageScale: EXPORT_SCALE };
      const safeName =
        (frame.name || "screen").replace(/[^a-zA-Z0-9а-яА-ЯёЁ\s-]/g, "").trim() || "screen";
      figma.ui.postMessage({
        type: "save-markup",
        pngData: pngData, // Uint8Array — structured-cloned directly (no number-array copy)
        controlsJson: stringifyControls(controls),
        infoJson: JSON.stringify(info, null, 2),
        folderName: safeName + ".vodesign",
      });
      break;
    }

    case "saved":
      figma.notify("Downloaded the preview (.vodesign).");
      break;

    case "save-failed":
      figma.notify("Couldn't save the preview.", { error: true });
      break;

    case "open-url":
      if (msg.url) figma.openExternal(msg.url);
      break;

    case "get-settings": {
      const provider = (await figma.clientStorage.getAsync(AI_PROVIDER_KEY)) || "anthropic";
      figma.ui.postMessage({
        type: "settings",
        provider,
        hasAnthropic: !!(await figma.clientStorage.getAsync(ANTHROPIC_KEY)),
        hasOpenAI: !!(await figma.clientStorage.getAsync(OPENAI_KEY)),
      });
      break;
    }

    case "save-settings": {
      if (msg.provider) await figma.clientStorage.setAsync(AI_PROVIDER_KEY, msg.provider);
      if (typeof msg.anthropicKey === "string" && msg.anthropicKey)
        await figma.clientStorage.setAsync(ANTHROPIC_KEY, msg.anthropicKey);
      if (typeof msg.openaiKey === "string" && msg.openaiKey)
        await figma.clientStorage.setAsync(OPENAI_KEY, msg.openaiKey);
      if (msg.clearAnthropic) await figma.clientStorage.deleteAsync(ANTHROPIC_KEY);
      if (msg.clearOpenAI) await figma.clientStorage.deleteAsync(OPENAI_KEY);
      figma.notify("Settings saved.");
      figma.ui.postMessage({
        type: "settings",
        provider: (await figma.clientStorage.getAsync(AI_PROVIDER_KEY)) || "anthropic",
        hasAnthropic: !!(await figma.clientStorage.getAsync(ANTHROPIC_KEY)),
        hasOpenAI: !!(await figma.clientStorage.getAsync(OPENAI_KEY)),
      });
      break;
    }

    case "heuristic-annotate": {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.notify("Select a frame to annotate.");
        figma.ui.postMessage({ type: "annotate-done" });
        break;
      }
      const frame = topLevelFrameOf(selection[0]);
      const found = heuristicAnnotations(frame);
      let created = 0;
      let skipped = 0;
      for (const { node, ann } of found) {
        if (readAnnotation(node)) { skipped++; continue; }
        try { writeAnnotation(node, ann); created++; } catch (e) {}
      }
      await pushSelection();
      await regeneratePanel(frame, false);
      figma.ui.postMessage({ type: "annotate-done" });
      figma.notify(
        created
          ? "Suggested " + created + " annotation" + (created === 1 ? "" : "s") +
              (skipped ? ", kept " + skipped + " existing" : "") + ". Review them in the inspector."
          : "Couldn't infer any new elements."
      );
      break;
    }

    case "ai-annotate": {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.notify("Select a frame to annotate.");
        figma.ui.postMessage({ type: "annotate-done" });
        break;
      }
      const frame = topLevelFrameOf(selection[0]);
      const provider = (await figma.clientStorage.getAsync(AI_PROVIDER_KEY)) || "anthropic";
      const key = await figma.clientStorage.getAsync(provider === "openai" ? OPENAI_KEY : ANTHROPIC_KEY);
      if (!key) {
        figma.notify("Add your " + (provider === "openai" ? "OpenAI" : "Anthropic") + " API key in Settings first.", { error: true });
        figma.ui.postMessage({ type: "annotate-done", openSettings: true });
        break;
      }
      figma.notify("Generating annotations with AI…");
      try {
        const elements = await generateWithAI(provider, key, frame.name, collectFrameData(frame));
        const { created, skipped, unmatched } = await applyGenerated(elements);
        await pushSelection();
        await regeneratePanel(frame, false);
        let m = created
          ? "AI added " + created + " annotation" + (created === 1 ? "" : "s")
          : "AI returned no new elements";
        if (skipped) m += ", kept " + skipped + " existing";
        if (unmatched) m += ", " + unmatched + " didn’t match a layer";
        figma.notify(m + ".");
      } catch (e) {
        figma.notify("AI generation failed: " + (e && e.message ? e.message : "unknown error"), { error: true });
      }
      figma.ui.postMessage({ type: "annotate-done" });
      break;
    }
  }
};

figma.on("selectionchange", () => {
  pushSelection();
});
