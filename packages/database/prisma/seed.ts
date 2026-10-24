/* Demo seed for local development: two organizations (multi-tenant, ADR-010). Idempotent: re-running
 * upserts the same fixtures. Tenant rows are written inside runWithOrganizationContext so they pass
 * forced RLS, keyed by organizationId (column org_id). One user belongs to both organizations so
 * cross-organization membership and isolation can be exercised locally. */
import { PrismaClient, MembershipRole } from '@prisma/client';
import { runWithOrganizationContext } from '../src/tenant.js';

const prisma = new PrismaClient();

/** Lowercase hex SHA-256 (file_objects_checksum_sha256_check). Placeholder digest of the empty string. */
const DEMO_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Deterministic ids: 00000000-0000-4000-8000-0000000{n}{kind}{seq}; n = organization number. */
function idsFor(n: number) {
  const id = (suffix: string) => `00000000-0000-4000-8000-${String(n).padStart(9, '0')}${suffix}`;
  // Organization 1 keeps the original pre-ADR-010 ids so existing local databases stay idempotent.
  if (n === 1) {
    return {
      organization: '00000000-0000-4000-8000-000000000001',
      project: '00000000-0000-4000-8000-000000000201',
      meeting: '00000000-0000-4000-8000-000000000301',
      file: '00000000-0000-4000-8000-000000000401',
      transcript: '00000000-0000-4000-8000-000000000501',
      recording: '00000000-0000-4000-8000-000000000701',
      mediaNorm: '00000000-0000-4000-8000-000000000702',
    };
  }
  return {
    organization: id('001'),
    project: id('201'),
    meeting: id('301'),
    file: id('401'),
    transcript: id('501'),
    recording: id('701'),
    mediaNorm: id('702'),
  };
}

type SeedUser = { id: string; email: string; name: string };
type SeedMember = SeedUser & { role: MembershipRole; employeeId: string };
type SeedOrganization = {
  n: number;
  name: string;
  slug: string;
  project: { name: string; key: string };
  meetingTitle: string;
  members: SeedMember[];
  transcript: { speaker0: string; speaker1: string };
};

const USERS = {
  olivia: { id: '00000000-0000-4000-8000-000000000101', email: 'owner@demo.meetops.local', name: 'Olivia Owner' },
  max: { id: '00000000-0000-4000-8000-000000000102', email: 'member@demo.meetops.local', name: 'Max Member' },
  ada: { id: '00000000-0000-4000-8000-000000002101', email: 'owner@acme.meetops.local', name: 'Ada Acme' },
  ben: { id: '00000000-0000-4000-8000-000000002102', email: 'member@acme.meetops.local', name: 'Ben Builder' },
} satisfies Record<string, SeedUser>;

const ORGANIZATIONS: SeedOrganization[] = [
  {
    n: 1,
    name: 'Demo Org',
    slug: 'demo',
    project: { name: 'Website Relaunch', key: 'WEB' },
    meetingTitle: 'Weekly sync',
    members: [
      { ...USERS.olivia, role: MembershipRole.owner, employeeId: '00000000-0000-4000-8000-000000000601' },
      { ...USERS.max, role: MembershipRole.member, employeeId: '00000000-0000-4000-8000-000000000602' },
    ],
    transcript: { speaker0: 'Let us ship the landing page by Friday.', speaker1: 'I will draft the copy.' },
  },
  {
    n: 2,
    name: 'Acme Corp',
    slug: 'acme',
    project: { name: 'Mobile App', key: 'APP' },
    meetingTitle: 'Sprint planning',
    members: [
      { ...USERS.ada, role: MembershipRole.owner, employeeId: '00000000-0000-4000-8000-000000002601' },
      { ...USERS.ben, role: MembershipRole.member, employeeId: '00000000-0000-4000-8000-000000002602' },
      // Olivia also belongs to Acme (as viewer): one user, two organizations.
      { ...USERS.olivia, role: MembershipRole.viewer, employeeId: '00000000-0000-4000-8000-000000002603' },
    ],
    transcript: { speaker0: 'Release 1.2 goes out on Tuesday.', speaker1: 'I will update the changelog.' },
  },
];

async function seedOrganization(spec: SeedOrganization): Promise<void> {
  const IDS = idsFor(spec.n);
  const [host, second] = spec.members as [SeedMember, SeedMember, ...SeedMember[]];
  const org = await prisma.organization.upsert({
    where: { id: IDS.organization },
    update: {},
    create: { id: IDS.organization, name: spec.name, slug: spec.slug },
  });

  for (const u of spec.members) {
    await prisma.user.upsert({ where: { id: u.id }, update: {}, create: { id: u.id, email: u.email, name: u.name } });
  }

  await runWithOrganizationContext(prisma, org.id, async (tx) => {
    for (const u of spec.members) {
      await tx.membership.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: u.id } },
        update: { role: u.role },
        create: { organizationId: org.id, userId: u.id, role: u.role },
      });
      await tx.employee.upsert({
        where: { id: u.employeeId },
        update: {},
        create: { id: u.employeeId, organizationId: org.id, userId: u.id, fullName: u.name, email: u.email },
      });
    }

    await tx.project.upsert({
      where: { id: IDS.project },
      update: {},
      create: { id: IDS.project, organizationId: org.id, name: spec.project.name, key: spec.project.key },
    });

    await tx.meeting.upsert({
      where: { id: IDS.meeting },
      update: {},
      create: {
        id: IDS.meeting,
        organizationId: org.id,
        projectId: IDS.project,
        createdById: host.id,
        title: spec.meetingTitle,
        status: 'completed',
        scheduledAt: new Date('2026-10-20T10:00:00Z'),
        durationSec: 1800,
        participants: {
          create: [
            { userId: host.id, displayName: host.name, speakerLabel: 'SPEAKER_0', role: 'host' },
            { userId: second.id, displayName: second.name, speakerLabel: 'SPEAKER_1' },
          ],
        },
      },
    });

    const base = `organizations/${org.id}/meetings/${IDS.meeting}`;
    await tx.fileObject.upsert({
      where: { id: IDS.file },
      update: { checksumSha256: DEMO_SHA256 },
      create: {
        id: IDS.file,
        organizationId: org.id,
        meetingId: IDS.meeting,
        uploadedById: host.id,
        kind: 'raw',
        status: 'ready',
        bucket: 'meetops-dev',
        key: `${base}/raw/recording.webm`,
        mimeType: 'audio/webm',
        sizeBytes: BigInt(1_048_576),
        checksumSha256: DEMO_SHA256,
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
          fullText: `${host.name.split(' ')[0]}: ${spec.transcript.speaker0} ${second.name.split(' ')[0]}: ${spec.transcript.speaker1}`,
          segments: {
            create: [
              { revision: 1, sequence: 0, speakerLabel: 'SPEAKER_0', startMs: 0, endMs: 4000, text: spec.transcript.speaker0 },
              { revision: 1, sequence: 1, speakerLabel: 'SPEAKER_1', startMs: 4000, endMs: 7000, text: spec.transcript.speaker1 },
            ],
          },
        },
      });
    }
  }, { timeoutMs: 30_000 });

  console.warn('Seed complete for organization', org.slug);
}

async function main(): Promise<void> {
  for (const spec of ORGANIZATIONS) await seedOrganization(spec);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
