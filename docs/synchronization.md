# Synchronization

Keeping two systems agreeing about the same records. The framework provides the loop, the
bookkeeping and the conflict rules; **it integrates with no external provider.**

- [The connector](#the-connector)
- [Watermarks](#watermarks)
- [Conflicts](#conflicts)
- [Running a sync](#running-a-sync)
- [When it goes wrong](#when-it-goes-wrong)

---

## The connector

A deployment implements `SyncConnector`; the framework drives it.

```ts
const salesforceContacts: SyncConnector = {
  key: 'salesforce.contacts',
  description: 'Contacts from Salesforce.',

  async fetchRemoteChanges({ organizationId, watermark, limit }) {
    const response = await salesforce.query(organizationId, {
      since: watermark, // the remote's own value, echoed back
      limit,
    });

    return {
      records: response.records.map((record) => ({
        externalId: record.Id,
        data: record,
        // The remote's timestamp. Never `new Date()` — see below.
        updatedAt: new Date(record.SystemModstamp),
        deleted: record.IsDeleted,
      })),
      nextWatermark: response.lastModstamp,
      hasMore: response.hasMore,
    };
  },

  async findLocal({ organizationId, externalId }) {
    const contact = await contacts.findByExternalId(organizationId, externalId);
    return contact ? { data: contact, updatedAt: contact.updatedAt } : null;
  },

  async applyLocal({ organizationId, record }) {
    if (record.deleted) return contacts.softDelete(organizationId, record.externalId);
    return contacts.upsert(organizationId, record);
  },
};
```

Every method takes `organizationId`, and it is not decorative: a connector that ignored it would
pull one tenant's records into another's system.

A connection is refused at creation if the connector cannot do the direction it is configured for.
A push connection against a connector with no `applyRemote` would otherwise report successful syncs
that moved nothing — which looks exactly like "there is nothing to sync".

## Watermarks

Incremental sync asks only for what changed since a watermark. Two rules, both silent when broken:

**1. The watermark is the remote's own value.** Never a local timestamp. The two systems' clocks
differ, and a watermark taken from local time skips records whenever they do — with no error and
no way to notice.

**2. It advances only after a batch is processed.** Not as records are read. A run that fails
halfway keeps the watermark from the last _completed_ batch, so the next run reprocesses that batch
rather than skipping it. Reprocessing is safe if `applyLocal` is idempotent; skipping is data loss
either way.

A full sync starts from nothing:

```ts
await sync.run(connectionId, organizationId, { fullSync: true });
```

The connection's watermark is not cleared until the run succeeds — a failed full sync must not
leave the connection thinking it is up to date.

## Conflicts

A conflict is when the local copy changed **since the last successful sync**. Compared against
`lastSuccessAt` rather than against the remote's timestamp: the two clocks are not the same clock,
so "local is newer than remote" is not a fact about causality. "Local changed since we last
agreed" is.

| Policy                  | Behaviour                         | When                                                                                          |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `remote_wins` (default) | Apply the remote                  | A pull asserts the remote is authoritative. If it is not, a pull is the wrong direction.      |
| `local_wins`            | Keep the local copy               | The local system owns the record                                                              |
| `newest_wins`           | Most recent `updatedAt`           | Sounds sensible; depends on two clocks agreeing, which they do not. Rarely right.             |
| `manual`                | Change nothing, record both sides | When the answer is a judgement. The only policy that never silently discards somebody's edit. |

Every conflict is recorded with **both sides**, so whoever resolves it can see what they are
choosing between:

```bash
GET  /sync/conflicts?unresolvedOnly=true
POST /sync/conflicts/sconf_01HZ.../resolve
```

## Running a sync

```ts
await sync.run(connectionId, organizationId);
```

In practice this runs as a background job on a schedule — it is long, it fails, and it needs
history:

```ts
await scheduler.define({
  key: 'salesforce-contacts-hourly',
  kind: 'cron',
  expression: '0 * * * *',
  timezone: 'UTC',
  jobType: 'sync.run',
  jobPayload: { connectionId },
});
```

Two runs of one connection at once are refused: they would process the same records twice and race
on the watermark.

**One bad record does not fail the run.** A single malformed field would otherwise stop the whole
sync, and the next run would hit it again — a permanently stuck connection caused by one row. It is
counted, and a run with failures is reported as `partial` rather than `completed`.

## When it goes wrong

A connection that fails five runs in a row **pauses itself**, and a paused connection refuses to
run until somebody resumes it. Resuming clears the failure count — otherwise it is one failure from
pausing again with no indication why.

```bash
GET /sync/connections           # status, last error, last success
GET /sync/connections/:id/runs  # every run, with the watermarks it moved between
```

The run history records both `fromWatermark` and `toWatermark`, which is what makes a run
reproducible: you can see exactly what window it covered.

---

**See also:** [provider-adapters.md](provider-adapters.md) ·
[integration-architecture.md](integration-architecture.md) · [automation.md](automation.md)
