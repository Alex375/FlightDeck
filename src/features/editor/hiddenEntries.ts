// Which explorer entries are "hidden" in the Unix sense — the dot-names (.git,
// .claude, .DS_Store, .editorconfig…). They stay listed and fully usable in the
// tree; the explorer only DIMS them so the eye skips what you did not mean to
// open. Pure and dependency-free so it can be unit-tested on its own.

/**
 * Whether a file/folder NAME is a hidden one (it starts with a dot).
 *
 * Takes a BASENAME, never a path: `isHiddenName("/Users/x/.git")` is false on
 * purpose — the caller decides which part of a path it is asking about, which is
 * what keeps "children of a hidden folder are not themselves dimmed" true without
 * any extra rule here.
 *
 * `"."` and `".."` are the directory's own relative links, not hidden entries, and
 * an empty name is not a name at all — all three answer false.
 */
export function isHiddenName(name: string): boolean {
  if (name === "." || name === "..") return false;
  return name.startsWith(".");
}
