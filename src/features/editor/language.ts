// Pure helpers mapping a file path to its Monaco language id and basic kind.
// No React, no IPC — just string logic, so it's trivially testable and reusable.

/** File extension → Monaco built-in language id. Unknown → "plaintext" (still
 *  perfectly editable, just no token colours). We only need basic highlighting
 *  (Monaco's Monarch tokenizer, main-thread), so this list stays pragmatic. */
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  rs: "rust",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  xml: "xml",
  svg: "xml",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  lua: "lua",
  r: "r",
  pl: "perl",
  dart: "dart",
  // Not a Monaco built-in: registered by monacoEnv (`setupMonaco`) for the Source mode.
  diff: "diff",
  patch: "diff",
};

/** Filenames (no useful extension) with a known language. */
const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
};

/** The basename of a path (its last segment). */
export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** The Monaco language id for a path. */
export function languageForPath(path: string): string {
  const name = baseName(path).toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return EXT_LANG[ext] ?? "plaintext";
}

/** Whether a path is Markdown (gets the rendered-preview toggle). */
export function isMarkdownPath(path: string): boolean {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

/** Whether a path is a unified diff (`.diff` / `.patch`), rendered by the diff Preview. */
export function isDiffPath(path: string): boolean {
  return languageForPath(path) === "diff";
}

/** Whether a path opens with the Preview / Source toggle (rendered by default). */
export function hasRenderedPreview(path: string): boolean {
  return isMarkdownPath(path) || isDiffPath(path);
}

/** Image extension → MIME type for a `data:` URL. We cover every raster/vector
 *  format the OS webview renders natively from a data URL: the universally
 *  web-supported set (PNG/JPEG/GIF/WebP/AVIF/SVG/BMP/ICO) plus formats macOS
 *  WebKit handles (TIFF, HEIC/HEIF) — our primary platform. An unknown image-ish
 *  extension simply isn't routed here and falls back to the text/binary path. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  pjpeg: "image/jpeg",
  pjp: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
};

/** The image extension of a path (lowercased), or "" — also used for a badge. */
function imageExt(path: string): string {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return ext in IMAGE_MIME ? ext : "";
}

/** Whether a path is an image we can render in the viewer (vs Monaco/text). */
export function isImagePath(path: string): boolean {
  return imageExt(path) !== "";
}

/** Whether a path is a PDF (rendered with pdf.js, never Monaco/text). */
export function isPdfPath(path: string): boolean {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.slice(dot + 1) === "pdf";
}

/** The MIME type for an image path, or null if it isn't a known image. */
export function imageMimeForPath(path: string): string | null {
  const ext = imageExt(path);
  return ext ? IMAGE_MIME[ext] : null;
}

/** The parent directory of a path (its everything-but-last segment). */
export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** Brand-ish colour per Monaco language id, for the open-tab language badge. */
const LANG_COLOR: Record<string, string> = {
  typescript: "#3178c6",
  javascript: "#e8d44d",
  json: "#cbcb41",
  rust: "#dea584",
  python: "#3776ab",
  go: "#00add8",
  ruby: "#cc342d",
  java: "#e76f00",
  c: "#599ad4",
  cpp: "#f34b7d",
  csharp: "#9b4f96",
  php: "#8a92cf",
  swift: "#f05138",
  kotlin: "#a97bff",
  scala: "#de3423",
  shell: "#89e051",
  yaml: "#cb6d51",
  ini: "#8a9aa6",
  xml: "#e37933",
  html: "#e34c26",
  css: "#9a7bd4",
  scss: "#cc6699",
  less: "#6c8bbf",
  markdown: "#6ba6c9",
  sql: "#e3a04e",
  graphql: "#e10098",
  lua: "#5b8bf0",
  r: "#198ce7",
  perl: "#9b9b6b",
  dart: "#00b4ab",
  dockerfile: "#2496ed",
  makefile: "#8a9aa6",
  cmake: "#8a9aa6",
};

/** A small language badge for an open tab: a short uppercase label + a colour. */
export function fileBadge(path: string): { label: string; color: string } {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const lang = languageForPath(path);
  const color = LANG_COLOR[lang] ?? "var(--wf-tx-lo)";
  // Prefer the real extension (TS/RS/JSON…); fall back to the first letters of an
  // extensionless name (Dockerfile → DO, Makefile → MA).
  const label = (ext || baseName(path).slice(0, 2)).toUpperCase().slice(0, 4);
  return { label, color };
}
