/** Prepare the shared Word renderer when a document card appears in the chat. */
export async function preloadWordEditor(): Promise<void> {
  try {
    await window.electron?.artifact?.wordPanel?.prepare();
  } catch (error) {
    // Opening the card retries a failed speculative launch.
    console.debug('[WordPreload] Could not prepare Word panel:', error);
  }
}
