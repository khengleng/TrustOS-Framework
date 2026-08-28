import type { Release } from './lifecycle';

/**
 * Release notes.
 *
 * Generated from the version history rather than written twice. A changelog maintained beside the
 * history is a changelog that disagrees with it within two releases, and the one people read is
 * whichever is on the website.
 *
 * The ordering is deliberate and is the opposite of most changelogs: **breaking changes first,
 * then security, then features.** A reader deciding whether to upgrade needs to know what will
 * break before they know what they gain. Putting features first optimises for the announcement
 * and against the reader.
 */

export interface NotesEntry {
  version: string;
  releasedAt: string;
  summary: string;
  breakingChanges: readonly string[];
  securityFixes: readonly string[];
  features: readonly string[];
  fixes: readonly string[];
  deprecations: ReadonlyArray<{ what: string; replacement: string; removedIn?: string }>;
}

export interface NotesOptions {
  /** Title above the notes. */
  title?: string;
  /** Include the "how to upgrade" preamble. Off for a changelog, on for a release announcement. */
  includeUpgradeGuidance?: boolean;
  /** Channel and support dates, when the release register has them. */
  release?: Release;
}

export function renderReleaseNotes(entry: NotesEntry, options: NotesOptions = {}): string {
  const lines: string[] = [];

  lines.push(`# ${options.title ?? `Release ${entry.version}`}`);
  lines.push('');
  lines.push(`Released ${entry.releasedAt.slice(0, 10)}.`);

  if (options.release) {
    const support = options.release.securitySupportUntil
      ? ` Security support until ${options.release.securitySupportUntil.slice(0, 10)}.`
      : '';
    lines.push(`Channel: **${options.release.channel}**.${support}`);
  }

  lines.push('');
  lines.push(entry.summary);
  lines.push('');

  if (entry.breakingChanges.length > 0) {
    lines.push('## Breaking changes');
    lines.push('');
    lines.push('Read these before upgrading. Each one needs a change on your side.');
    lines.push('');
    for (const change of entry.breakingChanges) lines.push(`- ${change}`);
    lines.push('');
  }

  if (entry.securityFixes.length > 0) {
    lines.push('## Security');
    lines.push('');
    for (const fix of entry.securityFixes) lines.push(`- ${fix}`);
    lines.push('');
  }

  if (entry.deprecations.length > 0) {
    lines.push('## Deprecated');
    lines.push('');
    lines.push('Still working. Replace them before the version noted.');
    lines.push('');
    for (const deprecation of entry.deprecations) {
      const removal = deprecation.removedIn ? ` — removed in ${deprecation.removedIn}` : '';
      lines.push(`- \`${deprecation.what}\` → \`${deprecation.replacement}\`${removal}`);
    }
    lines.push('');
  }

  if (entry.features.length > 0) {
    lines.push('## Added');
    lines.push('');
    for (const feature of entry.features) lines.push(`- ${feature}`);
    lines.push('');
  }

  if (entry.fixes.length > 0) {
    lines.push('## Fixed');
    lines.push('');
    for (const fix of entry.fixes) lines.push(`- ${fix}`);
    lines.push('');
  }

  if (options.includeUpgradeGuidance) {
    lines.push('## Upgrading');
    lines.push('');
    lines.push('```bash');
    lines.push('trustos upgrade --to ' + entry.version + ' --dry-run   # see what would change');
    lines.push('trustos upgrade --to ' + entry.version);
    lines.push('```');
    lines.push('');
    lines.push(
      entry.breakingChanges.length > 0
        ? 'This release is breaking. The dry run lists every migration it would execute; read it.'
        : 'No breaking changes in this release.',
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * A changelog over many releases, newest first.
 *
 * Newest first because a changelog is read to answer "what changed since I last looked", and the
 * answer is at the top.
 */
export function renderChangelog(entries: readonly NotesEntry[], title = 'Changelog'): string {
  const lines = [`# ${title}`, ''];

  lines.push('Generated from the version history. Do not edit — edit the history.');
  lines.push('');

  for (const entry of [...entries].reverse()) {
    lines.push(`## ${entry.version} — ${entry.releasedAt.slice(0, 10)}`);
    lines.push('');
    lines.push(entry.summary);
    lines.push('');

    const sections: Array<[string, readonly string[]]> = [
      ['Breaking', entry.breakingChanges],
      ['Security', entry.securityFixes],
      ['Added', entry.features],
      ['Fixed', entry.fixes],
    ];

    for (const [heading, items] of sections) {
      if (items.length === 0) continue;
      lines.push(`**${heading}**`);
      lines.push('');
      for (const item of items) lines.push(`- ${item}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
