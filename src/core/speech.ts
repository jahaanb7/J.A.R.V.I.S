const MAX_SPOKEN_CHARS = 400;

/**
 * Turns a chat reply into plain text for text-to-speech: drops code, markdown symbols, and links,
 * and cuts long replies at a sentence boundary so the orb does not read an essay aloud.
 */
export function toSpeech(text: string): string {
  let plain = text
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= MAX_SPOKEN_CHARS) return plain;
  const window = plain.slice(0, MAX_SPOKEN_CHARS);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  plain = sentenceEnd > 0 ? window.slice(0, sentenceEnd + 1) : `${window.trimEnd()}...`;
  return plain;
}
