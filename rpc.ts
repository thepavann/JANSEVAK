/**
 * Retries a server-function call once when the browser's fetch itself fails
 * ("Failed to fetch": preview proxy hiccup, sleeping tab, network blip).
 * Real server errors are rethrown immediately.
 */
export async function withRetry<T>(call: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call();
    } catch (error) {
      const networkFailure =
        error instanceof TypeError && /failed to fetch|network|load failed/i.test(error.message);
      if (!networkFailure) throw error;
      lastError = error;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastError instanceof Error
    ? new Error("Could not reach CivicLens. Check your connection and try again.")
    : lastError;
}
