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
};

async function main(): Promise<void> {
  const org = await prisma.organization.upsert({
    where: { id: IDS.org },
    update: {},
    create: { id: IDS.org, name: 'Demo Org', slug: 'demo' },
  });

  const users = [
    { id: IDS.owner, email: 'owner@demo.meetops.local', name: 'Olivia Owner', role: MembershipRole.OWNER, emp: IDS.empOwner },
    { id: IDS.member, email: 'member@demo.meetops.local', name: 'Max Member', role: MembershipRole.MEMBER, emp: IDS.empMember },
  ];
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, update: {}, create: { id: u.id, email: u.email, name: u.name } });
  }

  await runWithOrgContext(prisma, org.id, async (tx) => {
    for (const u of users) {
      await tx.membership.upsert({
        where: { orgId_userId: { orgId: org.id, userId: u.id } },
        update: { role: u.role },
        create: { orgId: org.id, userId: u.id, role: u.role },
      });
      await tx.employee.upsert({
        where: { id: u.emp },
        update: {},
        create: { id: u.emp, orgId: org.id, userId: u.id, fullName: u.name, email: u.email },
      });
    }

    await tx.project.upsert({
      where: { id: IDS.project },
      update: {},
      create: { id: IDS.project, orgId: org.id, name: 'Website Relaunch', key: 'WEB' },
    });

    await tx.fileObject.upsert({
      where: { id: IDS.file },
      update: {},
      create: {
        id: IDS.file,
        orgId: org.id,
        uploadedById: IDS.owner,
        bucket: 'meetops-dev',
        key: `orgs/${org.id}/meetings/${IDS.meeting}/recording.webm`,
        mimeType: 'audio/webm',
        sizeBytes: BigInt(1_048_576),
        checksumSha256: 'demo-checksum',
      },
    });

    await tx.meeting.upsert({
      where: { id: IDS.meeting },
      update: {},
      create: {
        id: IDS.meeting,
        orgId: org.id,
        projectId: IDS.project,
        createdById: IDS.owner,
        recordingId: IDS.file,
        title: 'Weekly sync',
        status: 'COMPLETED',
        scheduledAt: new Date('2026-10-20T10:00:00Z'),
        durationSec: 1800,
        participants: {
          create: [
            { orgId: org.id, employeeId: IDS.empOwner, displayName: 'Olivia Owner', speakerLabel: 'SPEAKER_0', role: 'HOST' },
            { orgId: org.id, employeeId: IDS.empMember, displayName: 'Max Member', speakerLabel: 'SPEAKER_1' },
          ],
        },
      },
    });

    const exists = await tx.transcript.findUnique({ where: { id: IDS.transcript } });
    if (!exists) {
      await tx.transcript.create({
        data: {
          id: IDS.transcript,
          orgId: org.id,
          meetingId: IDS.meeting,
          sourceFileId: IDS.file,
          revision: 1,
          status: 'READY',
          language: 'en',
          fullText: 'Olivia: Let us ship the landing page by Friday. Max: I will draft the copy.',
          segments: {
            create: [
              { orgId: org.id, revision: 1, sequence: 0, speakerLabel: 'SPEAKER_0', startMs: 0, endMs: 4000, text: 'Let us ship the landing page by Friday.' },
              { orgId: org.id, revision: 1, sequence: 1, speakerLabel: 'SPEAKER_1', startMs: 4000, endMs: 7000, text: 'I will draft the copy.' },
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
