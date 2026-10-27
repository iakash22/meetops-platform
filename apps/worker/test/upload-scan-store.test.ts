import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { uploadSourceFromStorage } from '../src/media/upload-scan-store.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const UP = '00000000-0000-4000-8000-000000000002';

describe('uploadSourceFromStorage', () => {
  const storage = {
    headUploadSource: async () => ({ sizeBytes: 3 }),
    getUploadSource: async () => ({
      body: Readable.from([Buffer.from('abc')]),
      info: { sizeBytes: 3 },
    }),
  };
  it('reads the canonical upload source key', async () => {
    const src = uploadSourceFromStorage(storage)(`organizations/${ORG}/uploads/${UP}/source`, {
      organizationId: ORG,
      uploadId: UP,
    });
    expect(await src.size()).toBe(3);
  });
  it('refuses a row whose key is not the canonical one', () => {
    expect(() =>
      uploadSourceFromStorage(storage)(`organizations/${ORG}/meetings/x/recordings/y.webm`, {
        organizationId: ORG,
        uploadId: UP,
      }),
    ).toThrow(/Unexpected upload key/);
  });
});
