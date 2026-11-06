#!/usr/bin/env node
/* global process, console */
// Release versioning + changelog from Conventional Commits (release checklist §0). No dependencies.
//
//   node scripts/release-version.mjs                 # dry run: print next version + changelog section
//   node scripts/release-version.mjs --write         # also bump versions and prepend CHANGELOG.md
//   node scripts/release-version.mjs --from <ref>    # range start (default: latest v* tag, else root commit)
//   node scripts/release-version.mjs --as 1.2.3      # force a version (must be > current)
//
// Product version lives in the root package.json. --write syncs it to the shipped artefacts that carry a
// user-visible version: apps/extension/package.json (manifest), apps/desktop/package.json and
// apps/desktop/src-tauri/tauri.conf.json. It does NOT touch Cargo.toml (that would change Cargo.lock) or
// pnpm-lock.yaml. It never commits, tags or pushes: the release owner does that after review.
//
// Bump rules (docs/13-ops/release.md): BREAKING CHANGE footer or `type!:` -> major (minor while 0.x);
// feat -> minor; fix/perf/revert -> patch; nothing listable -> exit 1 (no release). First release from 0.0.0 is 0.1.0.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const SYNCED_FILES = [
  'package.json',
  'apps/extension/package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
];
const SECTIONS = [
  ['breaking', 'Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Bug fixes'],
  ['perf', 'Performance'],
  ['revert', 'Reverts'],
];
const HEADER = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse `git log` records (hash \x1f subject \x1f body \x1e). Merge commits and non-conventional ones are dropped. */
export function parseCommits(raw) {
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .flatMap((r) => {
      const [hash, subject = '', body = ''] = r.split('\x1f');
      const m = HEADER.exec(subject.trim());
      if (!m) return [];
      const breaking = !!m[3] || /^BREAKING[ -]CHANGE:/m.test(body);
      return [{ hash: hash.slice(0, 8), type: m[1], scope: m[2] ?? '', subject: m[4], breaking }];
    });
}

export function bumpKind(commits) {
  if (commits.some((c) => c.breaking)) return 'major';
  if (commits.some((c) => c.type === 'feat')) return 'minor';
  if (commits.some((c) => ['fix', 'perf', 'revert'].includes(c.type))) return 'patch';
  return null;
}

export function nextVersion(current, kind) {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`current version "${current}" is not x.y.z`);
  let [maj, min, pat] = m.slice(1).map(Number);
  // 0.x: a breaking change bumps minor, not major (semver §4); first release from 0.0.0 is 0.1.0.
  if (kind === 'major' && maj === 0) kind = 'minor';
  if (maj === 0 && min === 0) return '0.1.0';
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function renderChangelog(version, date, commits) {
  const out = [`## ${version} (${date})`, ''];
  for (const [key, title] of SECTIONS) {
    const list = commits.filter((c) =>
      key === 'breaking' ? c.breaking : !c.breaking && c.type === key,
    );
    if (!list.length) continue;
    out.push(`### ${title}`, '');
    for (const c of list)
      out.push(`- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject} (${c.hash})`);
    out.push('');
  }
  return out.join('\n');
}

const git = (...a) =>
  execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function main(argv) {
  const arg = (n) => {
    const i = argv.indexOf(n);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${n} needs a value`);
    return v;
  };
  const known = new Set(['--write', '--from', '--as']);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i])) throw new Error(`unknown argument: ${argv[i]}`);
    if (argv[i] !== '--write') i++;
  }
  const write = argv.includes('--write');
  let from = arg('--from');
  if (!from) {
    try {
      from = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
    } catch {
      from = '';
    }
  }
  const range = from ? `${from}..HEAD` : 'HEAD';
  const raw = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const commits = parseCommits(raw);
  const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const forced = arg('--as');
  let version;
  if (forced) {
    if (!SEMVER.test(forced)) throw new Error('--as must be x.y.z');
    if (compareSemver(forced, current) <= 0)
      throw new Error(`--as ${forced} is not greater than ${current}`);
    version = forced;
  } else {
    const kind = bumpKind(commits);
    if (!kind) {
      console.error(
        `release-version: no feat/fix/perf/revert/breaking commits in ${range || 'history'}; nothing to release`,
      );
      process.exit(1);
    }
    version = nextVersion(current, kind);
  }
  const date = process.env.RELEASE_DATE ?? new Date().toISOString().slice(0, 10);
  const section = renderChangelog(version, date, commits);
  console.log(
    `release-version: ${current} -> ${version} (${commits.length} conventional commits since ${from || 'root'})\n`,
  );
  console.log(section);
  if (!write) return;
  for (const f of SYNCED_FILES) {
    const txt = readFileSync(f, 'utf8');
    const re = /("version"\s*:\s*")[^"]*(")/;
    if (!re.test(txt)) throw new Error(`${f} has no "version" field`);
    writeFileSync(f, txt.replace(re, `$1${version}$2`));
  }
  const prev = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : '# Changelog\n';
  const [head, ...rest] = prev.split(/\n(?=## )/);
  writeFileSync('CHANGELOG.md', [head.trimEnd() + '\n', section, ...rest].join('\n'));
  console.log(
    `release-version: wrote ${SYNCED_FILES.join(', ')} and CHANGELOG.md. Review, commit, tag v${version}.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-version: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
