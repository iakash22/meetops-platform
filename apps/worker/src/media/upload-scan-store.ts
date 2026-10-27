import { withOrganizationContext, type MediaRepositoryOptions } from '@meetops/database';
import type { GetObjectResult, StoredObjectInfo } from '@meetops/storage';
import { uploadSourceKey } from '@meetops/storage';
import type { UploadScanDeps } from './upload-scan-job.js';

/**
 * Prisma-backed findUpload / setScanStatus for processUploadScan. Both run under withOrganizationContext (forced
 * RLS); setScanStatus only moves a row that is still `pending`, so retries and duplicates can't flip a verdict.
 */
export function createUploadScanStore(
  opts: MediaRepositoryOptions = {},
): Pick<UploadScanDeps, 'findUpload' | 'setScanStatus'> {
  const o = {
    ...(opts.client ? { client: opts.client } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  return {
    findUpload: (organizationId, id) =>
      withOrganizationContext(
        organizationId,
        (tx) =>
          tx.fileObject.findFirst({
            where: { id, organizationId, deletedAt: null },
            select: { id: true, key: true, mimeType: true, scanStatus: true },
          }),
        o,
      ),
    setScanStatus: async (organizationId, id, status) => {
      await withOrganizationContext(
        organizationId,
        (tx) =>
          tx.fileObject.updateMany({
            where: { id, organizationId, scanStatus: 'pending' },
            data: { scanStatus: status },
          }),
        o,
      );
    },
  };
}

export type UploadSourceStorage = {
  headUploadSource(organizationId: string, uploadId: string): Promise<StoredObjectInfo | null>;
  getUploadSource(organizationId: string, uploadId: string): Promise<GetObjectResult>;
};

/** deps.source backed by S3StorageService; refuses a row whose key is not the canonical upload source key. */
export function uploadSourceFromStorage(storage: UploadSourceStorage): UploadScanDeps['source'] {
  return (key, { organizationId, uploadId }) => {
    if (key !== uploadSourceKey(organizationId, uploadId)) throw new Error('Unexpected upload key');
    return {
      size: async () =>
        (await storage.headUploadSource(organizationId, uploadId))?.sizeBytes ?? null,
      body: async () => (await storage.getUploadSource(organizationId, uploadId)).body,
    };
  };
}
