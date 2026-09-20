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
// Pure, no React: the resolution is a data question, testable on its own.

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

/**
 * The emoji face for one publish, from its `icon` (word) and/or its `favicon` (legacy emoji),
 * or null when neither says anything usable — callers then show their own generic fallback.
 *
 * An emoji on either field is taken verbatim: a picture the CLI chose beats one we derive.
 * A word is normalised to letters (so `bar-chart`, `Bar Chart` and `barchart` agree) and looked
 * up whole, then by its longest matching stem.
 */
export function artifactFace(
  icon: string | null | undefined,
  favicon: string | null | undefined,
): string | null {
  for (const raw of [favicon, icon]) {
    const v = raw?.trim();
    if (v && isPictograph(v)) return v;
  }
  const word = (icon ?? favicon ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return null;
  const exact = FACES[word];
  if (exact) return exact;
  for (const stem of STEMS) if (word.includes(stem)) return FACES[stem];
  return null;
}
