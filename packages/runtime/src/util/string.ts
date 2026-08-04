// Slugifies a string for use as an identifier: lowercase, non-alphanumeric
// runs collapsed to single hyphens, leading/trailing hyphens stripped.
function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

// Matches a filename against a plugin extractor glob. Only two shapes are
// supported: exact filenames and "*.<ext>" suffix globs.
function matchesGlob(filename: string, glob: string): boolean {
  if (glob.startsWith("*.")) {
    const ext = glob.slice(1);
    return filename.endsWith(ext);
  }
  return filename === glob;
}

export { matchesGlob, toSlug };
