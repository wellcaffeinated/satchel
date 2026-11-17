/**
 * The rule a memory states: its first paragraph. Embeddings, the similar-memory check and
 * the core use only this, so code examples do not make unrelated rules look alike.
 */
export function leadParagraph(text: string): string {
  return text.trim().split(/\n[ \t]*\n/, 1)[0] ?? ''
}
