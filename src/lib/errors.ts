/**
 * Extract a human-readable error message from any thrown value.
 * Handles: Error instances, Supabase PostgrestError objects, and unknown shapes.
 */
export function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: string }).message)
  }
  return 'Something went wrong. Please try again.'
}
