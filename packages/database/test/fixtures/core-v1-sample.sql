-- Sample data in the PR #6 (init_core_schema only) shape, used to prove the later migrations
-- preserve data. Apply after 20261021000000_init_core_schema, then `prisma migrate deploy`.
INSERT INTO organizations (id, name, slug, updated_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Acme', 'acme', now());
INSERT INTO users (id, email, updated_at) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'owner@acme.test', now());
INSERT INTO memberships (id, org_id, user_id, role, updated_at) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'OWNER', now());
INSERT INTO file_objects (id, org_id, bucket, key, mime_type, size_bytes, updated_at) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'rec', 'org/a0000000-0000-4000-8000-000000000001/m1.webm', 'video/webm', 10, now()),
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'rec', 'org/a0000000-0000-4000-8000-000000000001/m2.webm', 'video/webm', 20, now());
INSERT INTO meetings (id, org_id, title, status, recording_file_id, updated_at) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'M1', 'TRANSCRIBING', 'd0000000-0000-4000-8000-000000000001', now()),
  ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'M2', 'COMPLETED', NULL, now());
INSERT INTO transcripts (id, org_id, meeting_id, source_file_id, status, updated_at) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'READY', now()),
  ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'READY', now());
INSERT INTO internal_tasks (id, org_id, title, status, priority, updated_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'T1', 'BLOCKED', 'URGENT', now()),
  ('10000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'T2', 'DONE', 'LOW', now());
INSERT INTO external_issue_links (id, org_id, internal_task_id, provider, external_id, updated_at) VALUES
  ('20000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'LINEAR', 'ENG-1', now());
INSERT INTO audit_logs (id, org_id, action, entity_type) VALUES
  ('30000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'task.created', 'task');
INSERT INTO employees (id, org_id, user_id, full_name, updated_at) VALUES
  ('40000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Owner', now());
INSERT INTO meeting_participants (id, org_id, meeting_id, employee_id, display_name, role, updated_at) VALUES
  ('50000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Owner', 'HOST', now());
