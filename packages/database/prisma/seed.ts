/* Demo seed for local development. Idempotent: re-running upserts the same fixtures.
 * Tenant rows are written inside runWithOrgContext so they pass forced RLS. */
import { PrismaClient, MembershipRole } from '@prisma/client';
import { runWithOrgContext } from '../src/tenant.js';

const prisma = new PrismaClient();

const IDS = {
  org: '00000000-0000-4000-8000-000000000001',
  owner: '00000000-0000-4000-8000-000000000101',
  member: '00000000-0000-4000-8000-000000000102',
  project: '00000000-0000-4000-8000-000000000201',
  meeting: '00000000-0000-4000-8000-000000000301',
  file: '00000000-0000-4000-8000-000000000401',
  transcript: '00000000-0000-4000-8000-000000000501',
  empOwner: '00000000-0000-4000-8000-000000000601',
  empMember: '00000000-0000-4000-8000-000000000602',
  recording: '00000000-0000-4000-8000-000000000701',
  mediaNorm: '00000000-0000-4000-8000-000000000702',
};

async function main(): Promise<void> {
  const org = await prisma.organization.upsert({
    where: { id: IDS.org },
    update: {},
    create: { id: IDS.org, name: 'Demo Org', slug: 'demo' },
  });

  const users = [
    { id: IDS.owner, email: 'owner@demo.meetops.local', name: 'Olivia Owner', role: MembershipRole.owner, emp: IDS.empOwner },
    { id: IDS.member, email: 'member@demo.meetops.local', name: 'Max Member', role: MembershipRole.member, emp: IDS.empMember },
  ];
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, update: {}, create: { id: u.id, email: u.email, name: u.name } });
  }

  await runWithOrgContext(prisma, org.id, async (tx) => {
    for (const u of users) {
      await tx.membership.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: u.id } },
        update: { role: u.role },
        create: { organizationId: org.id, userId: u.id, role: u.role },
      });
      await tx.employee.upsert({
        where: { id: u.emp },
        update: {},
        create: { id: u.emp, organizationId: org.id, userId: u.id, fullName: u.name, email: u.email },
      });
    }

    await tx.project.upsert({
      where: { id: IDS.project },
      update: {},
      create: { id: IDS.project, organizationId: org.id, name: 'Website Relaunch', key: 'WEB' },
    });

    await tx.meeting.upsert({
      where: { id: IDS.meeting },
      update: {},
      create: {
        id: IDS.meeting,
        organizationId: org.id,
        projectId: IDS.project,
        createdById: IDS.owner,
        title: 'Weekly sync',
        status: 'completed',
        scheduledAt: new Date('2026-10-20T10:00:00Z'),
        durationSec: 1800,
        participants: {
          create: [
            { userId: IDS.owner, displayName: 'Olivia Owner', speakerLabel: 'SPEAKER_0', role: 'host' },
            { userId: IDS.member, displayName: 'Max Member', speakerLabel: 'SPEAKER_1' },
          ],
        },
      },
    });

    const base = `organizations/${org.id}/meetings/${IDS.meeting}`;
    await tx.fileObject.upsert({
      where: { id: IDS.file },
      update: {},
      create: {
        id: IDS.file,
        organizationId: org.id,
        meetingId: IDS.meeting,
        uploadedById: IDS.owner,
        kind: 'raw',
        status: 'ready',
        bucket: 'meetops-dev',
        key: `${base}/raw/recording.webm`,
        mimeType: 'audio/webm',
        sizeBytes: BigInt(1_048_576),
        checksumSha256: 'demo-checksum',
        durationSeconds: 1800,
        format: 'webm',
      },
    });
    await tx.fileObject.upsert({
      where: { id: IDS.mediaNorm },
      update: {},
      create: {
        id: IDS.mediaNorm,
        organizationId: org.id,
        meetingId: IDS.meeting,
        parentObjectId: IDS.file,
        kind: 'normalized',
        status: 'ready',
        bucket: 'meetops-dev',
        key: `${base}/normalized/audio.wav`,
        mimeType: 'audio/wav',
        durationSeconds: 1800,
        format: 'wav',
        sampleRate: 16000,
        channels: 1,
      },
    });
    await tx.recording.upsert({
      where: { id: IDS.recording },
      update: {},
      create: { id: IDS.recording, organizationId: org.id, meetingId: IDS.meeting, fileObjectId: IDS.file, durationMs: 1_800_000, status: 'ready' },
    });

    const exists = await tx.transcript.findUnique({ where: { id: IDS.transcript } });
    if (!exists) {
      await tx.transcript.create({
        data: {
          id: IDS.transcript,
          organizationId: org.id,
          provider: 'faster-whisper',
          meetingId: IDS.meeting,
          recordingId: IDS.recording,
          revision: 1,
          status: 'ready',
          language: 'en',
          fullText: 'Olivia: Let us ship the landing page by Friday. Max: I will draft the copy.',
          segments: {
            create: [
              { revision: 1, sequence: 0, speakerLabel: 'SPEAKER_0', startMs: 0, endMs: 4000, text: 'Let us ship the landing page by Friday.' },
              { revision: 1, sequence: 1, speakerLabel: 'SPEAKER_1', startMs: 4000, endMs: 7000, text: 'I will draft the copy.' },
            ],
          },
        },
      });
    }
  }, { timeoutMs: 30_000 });

  console.warn('Seed complete for org', org.slug);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
