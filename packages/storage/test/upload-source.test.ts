import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { loadStorageConfig, S3StorageService, uploadSourceKey } from '../src/index.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const UP = '00000000-0000-4000-8000-000000000002';
const config = loadStorageConfig({
  STORAGE_BUCKET: 'b',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY_ID: 'a',
  STORAGE_SECRET_ACCESS_KEY: 's',
});

describe('upload source reads (worker scan step)', () => {
  it('builds the key from validated ids only', () => {
    expect(uploadSourceKey(ORG, UP)).toBe(`organizations/${ORG}/uploads/${UP}/source`);
    expect(() => uploadSourceKey(ORG, '../x')).toThrow();
    expect(() => uploadSourceKey('a/b', UP)).toThrow();
  });

  it('HEADs and GETs exactly that key', async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = new S3Client({ region: 'us-east-1' });
    client.send = async (cmd: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return cmd.constructor.name === 'GetObjectCommand'
        ? { Body: Readable.from([Buffer.from('x')]), ContentLength: 1 }
        : { ContentLength: 1 };
    };
    const s = new S3StorageService({ config, client, authorize: () => undefined });
    expect((await s.headUploadSource(ORG, UP))?.sizeBytes).toBe(1);
    await s.getUploadSource(ORG, UP);
    expect(sent.map((x) => [x.name, x.input.Key])).toEqual([
      ['HeadObjectCommand', `organizations/${ORG}/uploads/${UP}/source`],
      ['GetObjectCommand', `organizations/${ORG}/uploads/${UP}/source`],
    ]);
  });
});
