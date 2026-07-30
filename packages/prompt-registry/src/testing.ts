import type { PromptStatus, PromptStore, PromptVersion } from './registry';

/** An in-memory prompt store, for tests and development. */
export class InMemoryPromptStore implements PromptStore {
  readonly versions = new Map<string, PromptVersion>();

  async create(version: PromptVersion): Promise<PromptVersion> {
    this.versions.set(version.id, version);
    return version;
  }

  async findById(id: string, organizationId: string | null): Promise<PromptVersion | null> {
    const version = this.versions.get(id);
    if (!version || version.organizationId !== organizationId) return null;
    return version;
  }

  async findVersion(
    promptKey: string,
    version: number,
    organizationId: string | null,
  ): Promise<PromptVersion | null> {
    return (
      [...this.versions.values()].find(
        (entry) =>
          entry.promptKey === promptKey &&
          entry.version === version &&
          entry.organizationId === organizationId,
      ) ?? null
    );
  }

  async findPublished(
    promptKey: string,
    organizationId: string | null,
  ): Promise<PromptVersion | null> {
    return (
      [...this.versions.values()].find(
        (entry) =>
          entry.promptKey === promptKey &&
          entry.organizationId === organizationId &&
          entry.status === 'published',
      ) ?? null
    );
  }

  async listVersions(promptKey: string, organizationId: string | null): Promise<PromptVersion[]> {
    return [...this.versions.values()]
      .filter((entry) => entry.promptKey === promptKey && entry.organizationId === organizationId)
      .sort((a, b) => a.version - b.version);
  }

  async listKeys(organizationId: string | null): Promise<string[]> {
    return [
      ...new Set(
        [...this.versions.values()]
          .filter((entry) => entry.organizationId === organizationId)
          .map((entry) => entry.promptKey),
      ),
    ].sort();
  }

  async update(id: string, patch: Partial<PromptVersion>): Promise<PromptVersion | null> {
    const version = this.versions.get(id);
    if (!version) return null;

    const updated = { ...version, ...patch };
    this.versions.set(id, updated);
    return updated;
  }

  /**
   * Conditional transition.
   *
   * The `from` check is what makes publication race-safe: two publishes of one version must not
   * both retire the previous one and both claim to have published. In SQL this is an
   * `UPDATE ... WHERE status IN (...)` returning a row count.
   */
  async transition(
    id: string,
    from: PromptStatus[],
    patch: Partial<PromptVersion> & { status: PromptStatus },
  ): Promise<boolean> {
    const version = this.versions.get(id);
    if (!version || !from.includes(version.status)) return false;

    this.versions.set(id, { ...version, ...patch });
    return true;
  }
}
