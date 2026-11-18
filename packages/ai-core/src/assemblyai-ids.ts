/** AssemblyAI transcript / job ids used on create, delete, and enqueue. */
export const PROVIDER_TRANSCRIPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidProviderTranscriptId(id: string): boolean {
  return typeof id === 'string' && PROVIDER_TRANSCRIPT_ID_PATTERN.test(id);
}
