// Collision sweep for the radial map.
//
// Nothing in the app measures text: every clearance on the map is arithmetic on
// assumed metrics (STATUS item 41), so whether two labels touch is a question
// only a sweep can answer. This is that sweep, and it is the fourth time it has
// been written -- the first three lived in a session scratchpad as a *Python
// mirror* of the layout maths, which drifts from app.js the moment a constant
// moves (STATUS item 170). So this one does not mirror anything: it loads the
// real app.js, stubs just enough DOM for `renderMap()` to run, and measures the
// SVG that comes out. A constant can no longer move underneath it.
//
//   node scripts/map_sweep.js                        # against localhost:8001
//   node scripts/map_sweep.js --graph http://...     # another server
//   node scripts/map_sweep.js --file graph.json      # a saved payload
//   node scripts/map_sweep.js --widths 1000,1200     # narrower sweep
//   node scripts/map_sweep.js --json                 # machine-readable
//
// What it cannot tell you: what it looks like. Text width is approximated at
// 0.55em a character -- the same figure the earlier sweeps used, kept so their
// numbers stay comparable -- so a long name in a wide font can still touch
// without this noticing. An eyeball is still the last step.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// --- the metrics the CSS carries, which the SVG does not ---------------------
//
// Font size rides on a class in style.css, so the harness has to know the four
// that matter. This is the one place the sweep duplicates something, and it is
// duplicated from the stylesheet rather than from the layout code -- keep it in
// step with the `.map-*` rules around style.css:890-1013.
const FONT_PX = {
  "map-name": 12,
  "map-meta": 10,
  "level-1": 11,
  "level-2": 10,
  "level-3": 10,
  "level-4": 10,
  "map-hub": 12,
  "map-pip-text": 10,
  // The class names the two ring levels carried before the hierarchy nested.
  // Kept deliberately: running this against an older checkout is how a baseline
  // is taken, and without them every group label there would fall through to
  // DEFAULT_FONT_PX and the two runs would not be measuring the same picture.
  "map-track": 11,
  "map-subtrack": 10,
};
const DEFAULT_FONT_PX = 11;
const CHAR_EM = 0.55;
// Where a glyph sits inside its line box, as a fraction of the font size.
const ASCENT = 0.8;
const DESCENT = 0.2;

const DEFAULT_WIDTHS = [1000, 1100, 1200, 1300, 1400, 1530];

// --- a DOM, stubbed down to what renderMap actually touches ------------------

class StubNode {
  constructor(tag, namespace) {
    this.tagName = tag;
    this.namespace = namespace || null;
    this.attributes = {};
    this.children = [];
    this.dataset = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.textContent = "";
    this.parent = null;
    this.classList = {
      add: (...names) => this.setClasses([...this.classes(), ...names]),
      remove: (...names) => this.setClasses(
        this.classes().filter((name) => !names.includes(name))),
      contains: (name) => this.classes().includes(name),
    };
  }

  classes() {
    return String(this.attributes.class || this.className || "")
      .split(/\s+/).filter(Boolean);
  }

  setClasses(names) {
    this.attributes.class = [...new Set(names)].join(" ");
    this.className = this.attributes.class;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
    // The real thing exposes data-* twice; wireMapFocus reads the dataset side.
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name) { delete this.attributes[name]; }

  appendChild(child) {
    if (child) {
      child.parent = this;
      this.children.push(child);
    }
    return child;
  }

  append(...kids) { for (const kid of kids) this.appendChild(kid); }

  removeChild(child) {
    this.children = this.children.filter((node) => node !== child);
    return child;
  }

  get firstChild() { return this.children[0] || null; }

  set innerHTML(value) { if (!value) this.children = []; }

  get innerHTML() { return ""; }

  addEventListener() {}

  // Only the two selector shapes wireMapFocus uses. Anything else is a bug in
  // the harness rather than in the map, so it says so loudly.
  querySelectorAll(selector) {
    const wanted = selector.split(",").map((part) => part.trim());
    for (const part of wanted) {
      if (!part.startsWith(".") && !/^\[[\w-]+\]$/.test(part)) {
        throw new Error(`map_sweep: unsupported selector ${selector}`);
      }
    }
    const hits = [];
    const walk = (node) => {
      for (const part of wanted) {
        const matched = part.startsWith(".")
          ? node.classes().includes(part.slice(1))
          : node.attributes[part.slice(1, -1)] !== undefined;
        if (matched) { hits.push(node); break; }
      }
      for (const child of node.children) walk(child);
    };
    for (const child of this.children) walk(child);
    return hits;
  }

  scrollIntoView() {}
}

function stubDocument() {
  const byId = new Map();
  return {
    createElement: (tag) => new StubNode(tag, null),
    createElementNS: (ns, tag) => new StubNode(tag, ns),
    createTextNode: (text) => {
      const node = new StubNode("#text", null);
      node.textContent = text;
      return node;
    },
    getElementById: (id) => {
      if (!byId.has(id)) {
        const node = new StubNode("div", null);
        node.id = id;
        node.value = "";
        node.clientWidth = 0;
        byId.set(id, node);
      }
      return byId.get(id);
    },
    addEventListener: () => {},
    get activeElement() { return null; },
  };
}

// Load app.js with its two boot calls cut off: `bindEvents()` reaches for a
// whole page of elements this harness has no reason to fake, and
// `loadProjects()` would hit the network. Everything above them is declarations.
function loadApp(source) {
  const boot = source.lastIndexOf("bindEvents();");
  if (boot === -1) throw new Error("map_sweep: no bindEvents() call to cut at");
  // `state` is a `let` and `renderMap` a function declaration, so only the
  // second one lands on the context's global object. An epilogue hands both out
  // explicitly rather than relying on which keyword happened to be used.
  const body = `${source.slice(0, boot)}
;globalThis.__map_sweep = { state, renderMap, mapGroups, treeDepth, isFinished,
  trackPath, foldPath, canonicalTrack, trackTree, trackPalette,
  RING_FRACTIONS, MAX_DRAWN_DEPTH, LEVEL_TONES };`;

  const context = {
    document: stubDocument(),
    window: { addEventListener: () => {} },
    console,
    setTimeout,
    clearTimeout,
    fetch: () => { throw new Error("map_sweep: the harness makes no requests"); },
    alert: () => {},
    confirm: () => false,
    prompt: () => null,
    Event: class { constructor(type) { this.type = type; } },
    Blob: class {},
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(body, context, { filename: "app.js" });
  return { ...context, ...context.__map_sweep };
}

// --- measuring what came out -------------------------------------------------

const fontOf = (classes) => {
  for (const name of classes) {
    if (FONT_PX[name] !== undefined) return FONT_PX[name];
  }
  return DEFAULT_FONT_PX;
};

// A <text> and its tspans -> the box the browser would paint. `labelText` puts
// an absolute offset on the first tspan's dy and a line step on the rest, so
// the block's top is the text's y plus that first offset.
function textBox(node, inherited) {
  const spans = node.children.filter((child) => child.tagName === "tspan");
  const lines = spans.length ? spans : [node];
  const label = lines.map((span) => span.textContent || "");
  if (label.every((line) => !line)) return null;

  const own = [...node.classes(), ...inherited];
  const widest = Math.max(...lines.map((span, index) => {
    const size = fontOf([...span.classes(), ...own]);
    return (label[index] || "").length * size * CHAR_EM;
  }));

  const anchor = node.attributes["text-anchor"] || "start";
  const x = Number(node.attributes.x || 0);
  const y = Number(node.attributes.y || 0);
  const first = spans.length ? Number(spans[0].attributes.dy || 0) : 0;
  const step = spans.length > 1 ? Number(spans[1].attributes.dy || 0) : 0;
  const size = fontOf(own);

  const left = anchor === "start" ? x
    : anchor === "end" ? x - widest : x - widest / 2;
  const top = y + first - size * ASCENT;
  return {
    kind: "label",
    text: label.join(" / "),
    left,
    right: left + widest,
    top,
    bottom: y + first + step * (lines.length - 1) + size * DESCENT,
  };
}

// Circles, labels and the canvas the two have to stay inside.
function harvest(svg) {
  const labels = [];
  const circles = [];

  const walk = (node, inherited) => {
    const classes = [...inherited, ...node.classes()];
    if (node.tagName === "text") {
      // Two labels are *meant* to sit on a circle and are not collisions:
      // the tier-1 pip's numeral, which is drawn on its own node's shoulder,
      // and the hub's name, which is centred inside the hub. Counting either
      // would report a designed overlap as a defect and bury the real ones.
      // The hub *circle* stays in the list, so a label drifting onto the hub is
      // still caught.
      if (classes.includes("map-pip-text") || classes.includes("map-hub")) return;
      const box = textBox(node, inherited);
      if (box) labels.push(box);
      return;  // tspans are the text's own business
    }
    // The pip is a mark drawn on top of its node on purpose -- it is meant to
    // touch, so counting it as a collision would report the feature as a bug.
    if (node.tagName === "circle" && !classes.includes("map-pip")) {
      circles.push({
        kind: "circle",
        text: circleName(node),
        cx: Number(node.attributes.cx || 0),
        cy: Number(node.attributes.cy || 0),
        r: Number(node.attributes.r || 0),
      });
    }
    for (const child of node.children) walk(child, classes);
  };

  walk(svg, []);
  return { labels, circles };
}

// A circle has no text of its own; its name is whatever its group is labelled.
// The pip's numeral is skipped: it comes first in a tier-1 group, so taking the
// first <text> would name every tier-1 project "1".
function circleName(node) {
  const group = node.parent;
  if (!group) return "circle";
  const text = group.children.find((child) => child.tagName === "text"
    && !child.classes().includes("map-pip-text"));
  if (!text) return "circle";
  const spans = text.children.filter((child) => child.tagName === "tspan");
  return (spans[0] || text).textContent || "circle";
}

const boxesOverlap = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Nearest point on the box to the centre, then compare to the radius.
function boxHitsCircle(box, circle) {
  const x = Math.min(Math.max(circle.cx, box.left), box.right);
  const y = Math.min(Math.max(circle.cy, box.top), box.bottom);
  return Math.hypot(circle.cx - x, circle.cy - y) < circle.r;
}

const circlesOverlap = (a, b) =>
  Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r;

function collisions(svg, width, height) {
  const { labels, circles } = harvest(svg);
  const found = { label_label: [], label_circle: [], circle_circle: [], off_canvas: [] };

  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      if (boxesOverlap(labels[i], labels[j])) {
        found.label_label.push(`${labels[i].text}  ×  ${labels[j].text}`);
      }
    }
  }

  for (const box of labels) {
    for (const circle of circles) {
      if (boxHitsCircle(box, circle)) {
        found.label_circle.push(`${box.text}  on  ${circle.text}`);
      }
    }
  }

  for (let i = 0; i < circles.length; i += 1) {
    for (let j = i + 1; j < circles.length; j += 1) {
      if (circlesOverlap(circles[i], circles[j])) {
        found.circle_circle.push(`${circles[i].text}  ×  ${circles[j].text}`);
      }
    }
  }

  for (const box of labels) {
    if (box.left < 0 || box.right > width || box.top < 0 || box.bottom > height) {
      found.off_canvas.push(box.text);
    }
  }

  return { found, counted: { labels: labels.length, circles: circles.length } };
}

// --- driving it --------------------------------------------------------------

function argue(argv) {
  const options = {
    graph: "http://127.0.0.1:8001/api/graph",
    file: null,
    widths: DEFAULT_WIDTHS,
    json: false,
    done: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--graph") options.graph = argv[i += 1];
    else if (flag === "--file") options.file = argv[i += 1];
    else if (flag === "--widths") {
      options.widths = argv[i += 1].split(",").map(Number).filter(Boolean);
    } else if (flag === "--json") options.json = true;
    // The hierarchy the map will actually draw, which is the thing a nesting
    // change has to be checked against -- a collision count can stay identical
    // while the tree underneath it is wrong.
    else if (flag === "--tree") options.tree = true;
    // The map hides finished work by default, so the default sweep measures the
    // picture you actually get. This puts it back for a worst-case count.
    else if (flag === "--done") options.done = true;
    else throw new Error(`map_sweep: unknown option ${flag}`);
  }
  return options;
}

async function graphPayload(options) {
  if (options.file) {
    return JSON.parse(fs.readFileSync(options.file, "utf8"));
  }
  const answer = await fetch(options.graph);
  if (!answer.ok) throw new Error(`map_sweep: ${options.graph} said ${answer.status}`);
  return answer.json();
}

async function main() {
  const options = argue(process.argv.slice(2));
  const source = fs.readFileSync(
    path.join(__dirname, "..", "app", "static", "app.js"), "utf8");
  const app = loadApp(source);
  const graph = await graphPayload(options);

  app.state.graph = graph;
  app.state.mapDone = options.done;

  if (options.tree) {
    // The same filter renderMap applies before grouping, so this prints the
    // hierarchy that is actually drawn -- a track whose only projects are
    // finished leaves the map by default, and this has to say so too.
    const drawn = graph.projects.filter((project) =>
      app.state.mapTiers.has(project.tier ?? 0)
      && (app.state.mapDone || !app.isFinished(project)));
    const groups = app.mapGroups(drawn);
    const depth = app.treeDepth(groups);
    const rings = app.RING_FRACTIONS[Math.min(depth, app.MAX_DRAWN_DEPTH)];
    console.log(`depth ${depth}, rings at ${rings.join(", ")}`
      + ` (ceiling ${app.MAX_DRAWN_DEPTH})`);
    console.log("");
    const show = (node, level) => {
      if (node.name !== null) {
        const ring = rings[level - 1];
        console.log(`${"  ".repeat(level)}${node.name}`
          + `   ring ${ring === undefined ? "—" : ring}`
          + `, ${node.total} project${node.total === 1 ? "" : "s"}`
          + `${node.direct.length ? ` (${node.direct.length} here)` : ""}`
          + `${node.flattened ? `   FOLDED ← ${[...node.folded].join(" ; ")}` : ""}`);
      }
      for (const kid of node.kids) show(kid, level + 1);
    };
    for (const group of groups) show(group, 1);
    return;
  }

  const canvas = app.document.getElementById("map-canvas");
  const report = [];

  for (const width of options.widths) {
    canvas.clientWidth = width;
    canvas.children = [];
    app.renderMap();

    const svg = canvas.children.find((node) => node.tagName === "svg");
    if (!svg) throw new Error(`map_sweep: no svg drawn at ${width}px`);
    const height = Number(svg.attributes.height);
    const { found, counted } = collisions(svg, width, height);
    report.push({ width, height, ...counted, found });
  }

  if (options.json) {
    console.log(JSON.stringify({ projects: graph.projects.length, report }, null, 2));
    return;
  }

  console.log(`${graph.projects.length} projects, done ${options.done ? "shown" : "hidden"}`);
  console.log("");
  console.log("  width  height  labels  circles  lbl×lbl  lbl×circ  circ×circ  off-canvas");
  for (const row of report) {
    const cells = [
      String(row.width).padStart(7),
      String(row.height).padStart(8),
      String(row.labels).padStart(8),
      String(row.circles).padStart(9),
      String(row.found.label_label.length).padStart(9),
      String(row.found.label_circle.length).padStart(10),
      String(row.found.circle_circle.length).padStart(11),
      String(row.found.off_canvas.length).padStart(12),
    ];
    console.log(cells.join(""));
  }

  for (const row of report) {
    const named = Object.entries(row.found).filter(([, list]) => list.length);
    if (!named.length) continue;
    console.log("");
    console.log(`  ${row.width}px`);
    for (const [kind, list] of named) {
      for (const hit of list) console.log(`    ${kind.padEnd(14)} ${hit}`);
    }
  }

  const worst = report.reduce((total, row) =>
    total + Object.values(row.found).reduce((sum, list) => sum + list.length, 0), 0);
  console.log("");
  console.log(`total collisions across ${report.length} widths: ${worst}`);
}

main().catch((failure) => {
  console.error(failure.message);
  process.exit(1);
});
