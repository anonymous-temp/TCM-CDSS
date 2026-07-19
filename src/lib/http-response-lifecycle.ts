export async function cancelResponseBody(response: Response | null | undefined): Promise<void> {
  if (!response?.body) return;
  try {
    await response.body.cancel();
  } catch {
    // A provider may already have closed the body. Cleanup must never mask the original failure.
  }
}
