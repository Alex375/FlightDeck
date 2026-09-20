// The FACE of an artifact — the pictograph shown on its tile, everywhere an artifact is listed
// (inline card, composer popover, side panel, viewer header, prose link card).
//
// ⚠️ THE WIRE CHANGED UNDER US. The `Artifact` tool used to carry `favicon`: an emoji, ready to
// render. It now carries `icon`: "one short generic word for the artifact's browser-tab icon,
// such as chart, calendar, recipe, code or map" — a WORD, not a picture. Checked against the
// transcripts on disk: `favicon` alone up to 2026-09-14, BOTH during a short overlap
// (`icon:"plane"` + `favicon:"✈️"`), and `icon` alone from 2026-09-20 (`icon:"sparkle"`). Reading
// only `favicon` is why every recent artifact showed the empty fallback tile.
//
// So both are read, and a word is turned back into a picture here. Emoji (rather than a glyph
// from the app's own icon set) for two reasons: the vocabulary is OPEN — a 70-glyph UI set has
// nothing for "recipe", "calendar" or "map", so most artifacts would land on the generic
// fallback, which is the very bug being fixed — and a conversation mixing pre- and post-change
// publishes renders as ONE list instead of half emoji, half line art.
//
// ⚠️ A TYPED artifact (Claude Design…) names NEITHER field — verified over all 16 `Artifact`
// calls of a real Design conversation, and the tool's own contract says `icon` is "ignored on an
// Artifact created from an Artifact type". So the icon wire fix alone still left every Design
// canvas on the blank tile. Its third source is its TYPE's name ("Design" → 🎨), which is
// exactly what that artifact IS — run through the same table, so a future type needs no code.
//
// The resolution is pure and testable on its own; <ArtifactFace> is only the ONE rendering of
// it, so the fallback can no longer differ between the thread, the popover and the panel (it
// did: 🎨 in two of them — which collides with a real Design artifact's face — and the kit glyph
// in the third).

import { Ico } from "../../ui/kit";

/** Emoji for a word, keyed by a normalised stem (letters only, lowercase).
 *
 *  Matched EXACTLY first, then as a substring longest-first — so "barchart" finds `chart`,
 *  while "plane" keeps its own entry instead of being eaten by `plan`. Ordering the fallback
 *  scan by stem length is what makes adding a short stem safe. */
const FACES: Record<string, string> = {
  // Data & reporting
  chart: "📊",
  graph: "📈",
  analytics: "📈",
  dashboard: "📊",
  metrics: "📈",
  stats: "📊",
  data: "🗃️",
  table: "🗂️",
  spreadsheet: "📗",
  report: "📑",
  summary: "📑",
  audit: "🔍",
  // Documents & writing
  document: "📄",
  doc: "📄",
  page: "📄",
  paper: "📄",
  article: "📰",
  news: "📰",
  note: "📝",
  memo: "📝",
  letter: "✉️",
  mail: "✉️",
  form: "📝",
  survey: "📝",
  quiz: "❓",
  spec: "📋",
  contract: "📜",
  scroll: "📜",
  legal: "⚖️",
  invoice: "🧾",
  receipt: "🧾",
  book: "📖",
  guide: "📖",
  manual: "📖",
  glossary: "📖",
  library: "📚",
  // Planning
  checklist: "☑️",
  todo: "☑️",
  task: "☑️",
  list: "📋",
  board: "📋",
  kanban: "📋",
  plan: "🗺️",
  roadmap: "🗺️",
  map: "🗺️",
  timeline: "🕰️",
  history: "🕰️",
  calendar: "📅",
  schedule: "📅",
  agenda: "📅",
  clock: "⏱️",
  timer: "⏱️",
  // Engineering
  code: "💻",
  terminal: "🖥️",
  console: "🖥️",
  server: "🖥️",
  database: "🗄️",
  api: "🔌",
  plugin: "🔌",
  bug: "🐛",
  test: "🧪",
  experiment: "🧪",
  science: "🔬",
  lab: "🔬",
  build: "🏗️",
  deploy: "🚀",
  rocket: "🚀",
  launch: "🚀",
  tool: "🔧",
  wrench: "🔧",
  gear: "⚙️",
  settings: "⚙️",
  config: "⚙️",
  network: "🕸️",
  tree: "🌳",
  branch: "🌿",
  // Design & media
  design: "🎨",
  palette: "🎨",
  brand: "🎨",
  art: "🎨",
  paint: "🖌️",
  logo: "🏷️",
  tag: "🏷️",
  label: "🏷️",
  image: "🖼️",
  photo: "🖼️",
  picture: "🖼️",
  gallery: "🖼️",
  camera: "📸",
  screenshot: "📸",
  video: "🎬",
  film: "🎬",
  movie: "🎬",
  slide: "📽️",
  deck: "📽️",
  presentation: "📽️",
  music: "🎵",
  audio: "🔊",
  sound: "🔊",
  mic: "🎙️",
  podcast: "🎙️",
  // Signals
  sparkle: "✨",
  spark: "✨",
  magic: "✨",
  star: "⭐",
  idea: "💡",
  bulb: "💡",
  fire: "🔥",
  bolt: "⚡",
  energy: "⚡",
  alert: "⚠️",
  warning: "⚠️",
  check: "✅",
  target: "🎯",
  goal: "🎯",
  flag: "🚩",
  pin: "📌",
  bookmark: "🔖",
  trophy: "🏆",
  award: "🏆",
  medal: "🏅",
  // People & places
  user: "👤",
  profile: "👤",
  person: "👤",
  people: "👥",
  team: "👥",
  group: "👥",
  chat: "💬",
  message: "💬",
  quote: "💬",
  phone: "📱",
  mobile: "📱",
  globe: "🌍",
  world: "🌍",
  web: "🌐",
  site: "🌐",
  link: "🔗",
  home: "🏠",
  house: "🏠",
  building: "🏢",
  office: "🏢",
  shop: "🛒",
  store: "🛒",
  cart: "🛒",
  ticket: "🎫",
  // Money
  money: "💰",
  budget: "💰",
  finance: "💰",
  bank: "🏦",
  price: "🏷️",
  card: "💳",
  payment: "💳",
  // Security
  lock: "🔒",
  security: "🔒",
  privacy: "🔒",
  shield: "🛡️",
  key: "🔑",
  // Transport & travel
  plane: "✈️",
  flight: "✈️",
  travel: "✈️",
  train: "🚆",
  car: "🚗",
  ship: "🚢",
  boat: "⛵",
  bike: "🚲",
  compass: "🧭",
  // Life
  recipe: "🍳",
  kitchen: "🍳",
  food: "🍽️",
  restaurant: "🍽️",
  coffee: "☕",
  health: "🩺",
  medical: "🩺",
  fitness: "🏋️",
  sport: "⚽",
  game: "🎮",
  heart: "❤️",
  leaf: "🌿",
  nature: "🌿",
  weather: "🌤️",
  sun: "☀️",
  moon: "🌙",
  water: "💧",
  // Misc structure
  folder: "📁",
  file: "📄",
  archive: "📦",
  package: "📦",
  box: "📦",
  layers: "🗂️",
  grid: "🔲",
  search: "🔍",
  filter: "🔎",
  brain: "🧠",
  robot: "🤖",
  bot: "🤖",
  dna: "🧬",
  school: "🎓",
  education: "🎓",
  vote: "🗳️",
  poll: "🗳️",
};

/** Stems to scan when the whole word isn't a key, longest first (see {@link FACES}). */
const STEMS = Object.keys(FACES).sort((a, b) => b.length - a.length);

/** True when the value is ALREADY a picture (an emoji) rather than a word. Covers the legacy
 *  `favicon` and any `icon` that happens to arrive as one. */
function isPictograph(value: string): boolean {
  return /\p{Extended_Pictographic}/u.test(value);
}

/** The emoji a single word resolves to, or null. Normalised to letters first, so `bar-chart`,
 *  `Bar Chart` and `barchart` agree; looked up whole, then by its longest matching stem. */
function faceForWord(word: string | null | undefined): string | null {
  const w = (word ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return null;
  const exact = FACES[w];
  if (exact) return exact;
  for (const stem of STEMS) if (w.includes(stem)) return FACES[stem];
  return null;
}

/**
 * The emoji face for an artifact, from its `icon` (a word) and/or its `favicon` (a legacy
 * emoji), falling back to its TYPE's name for a typed artifact — which names neither. Null when
 * nothing says anything usable; {@link ArtifactFace} then draws the generic mark.
 *
 * An emoji on either field is taken verbatim: a picture the CLI chose beats one we derive.
 */
export function artifactFace(
  icon: string | null | undefined,
  favicon: string | null | undefined,
  typeName?: string | null,
): string | null {
  for (const raw of [favicon, icon]) {
    const v = raw?.trim();
    if (v && isPictograph(v)) return v;
  }
  return faceForWord(icon ?? favicon) ?? faceForWord(typeName);
}

/**
 * The ONE way an artifact's face is drawn: the emoji when there is one, else the kit's
 * `artifact` mark.
 *
 * ⚠️ The generic mark is deliberately NOT an emoji any more. It used to be 🎨 on three surfaces
 * — which is also the honest face of a real Claude Design artifact, so "we were told nothing"
 * and "this is a design" were indistinguishable.
 */
export function ArtifactFace({ face }: { face: string | null }) {
  if (face) return <>{face}</>;
  // ⚠️ No size class on purpose. Each tile sizes it from its OWN rule (`.cv-art-tile .wf-ico`
  // and friends), and `.wf-ico.sm` would tie those on specificity — leaving which one wins to
  // stylesheet order. Bare, the tile's rule outranks the base one outright.
  return <Ico name="artifact" />;
}
