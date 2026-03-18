/**
 * Deterministic image display logic for posts.
 *
 * A post qualifies for a random image when its body contains more than
 * 5 words that are 7+ letters long. The image URL is seeded by the
 * post ID so the same post always renders the same image.
 */

/** Minimum number of "long" words required to show an image. */
const LONG_WORD_THRESHOLD = 5

/** Minimum letter count for a word to be considered "long". */
const WORD_LENGTH_THRESHOLD = 7

/**
 * Whether a post body qualifies for a random image.
 *
 * Counts words whose alphabetic characters are >= `WORD_LENGTH_THRESHOLD`.
 * Returns `true` when that count exceeds `LONG_WORD_THRESHOLD`.
 */
export function shouldShowImage(body: string): boolean {
  const words = body.split(/\s+/)
  let longCount = 0

  for (const word of words) {
    const letters = word.replace(/[^a-zA-Z]/g, '')
    if (letters.length >= WORD_LENGTH_THRESHOLD) {
      longCount++
      if (longCount > LONG_WORD_THRESHOLD) return true
    }
  }

  return false
}

/**
 * Deterministic image URL seeded by post ID.
 * Uses picsum.photos which supports seed-based URLs for consistent results.
 */
export function getPostImageUrl(postId: number): string {
  return `https://picsum.photos/seed/${postId}/600/300`
}
