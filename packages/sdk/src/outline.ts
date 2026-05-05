// Section identifies a named span within a file that can be selectively loaded.
// Agents see an outline and choose which sections to open, trading precision for
// context budget.
interface Section {
  // Stable identifier within the file (e.g. header slug, XML id attribute).
  id: string;
  // 1-indexed line number where the section starts.
  line: number;
  // Semantic type (e.g. "h1", "h2", "function", "xml-element").
  type: string;
  // Human-readable label for display in the outline.
  label: string;
  // Approximate line count (used for sizing estimates).
  lines: number;
}

export type { Section };
