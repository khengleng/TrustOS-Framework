# Provider adapters

Every external system this platform talks to implements one five-method contract. **The framework
ships none of them**, and that is the phase boundary rather than an omission.

- [The contract](#the-contract)
- [Writing one](#writing-one)
- [Registering](#registering)
- [Calling through the registry](#calling-through-the-registry)
- [Health and configuration](#health-and-configuration)
- [Why no implementations](#why-no-implementations)

---

## The contract

```ts
interface Provider<TConfig> {
  readonly key: string; // `mail.smtp`, `storage.s3` — category.implementation
  readonly description: string;
  readonly configSchema: z.ZodType<TConfig>;

  initialize(config: TConfig, context: ProviderContext): Promise<void>;
  health(): Promise<ProviderHealth>;
  capabilities(): ProviderCapabilities;
  configuration(): ProviderConfigurationView;
  shutdown(): Promise<void>;
}
```

Five methods, fixed, so operations can ask the same questions of every integration:

| Method          | Answers                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `initialize`    | Does this configuration work? Asked at start-up, when somebody is watching.                               |
| `health`        | Is it working _now_? Cheap enough to call every thirty seconds.                                           |
| `capabilities`  | What does this implementation actually support? Two providers behind one interface are rarely equivalent. |
| `configuration` | What is it configured with? Secrets redacted.                                                             |
| `shutdown`      | Release connections. Without it a restart is not graceful.                                                |

## Writing one

`BaseProvider` handles the parts that are easy to get wrong and tedious to repeat:

```ts
class SmtpMailProvider extends BaseProvider<SmtpConfig> {
  readonly key = 'mail.smtp';
  readonly description = 'Sends mail over SMTP.';
  readonly configSchema = z.object({
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    password: z.string(),
  });

  private client?: SmtpClient;

  protected async onInitialize(config: SmtpConfig, context: ProviderContext) {
    this.client = new SmtpClient(config);
    // Fail here if the configuration cannot work. A provider that initializes happily and fails
    // on first use moves the error from deployment time to the worst possible moment.
    await this.client.verify();
  }

  protected async checkHealth() {
    await this.client!.noop();
    return { status: 'healthy' as const, detail: `Connected to ${this.requireConfig().host}` };
  }

  capabilities() {
    return {
      category: 'mail',
      features: { attachments: true, templates: false, batchSize: 100 },
      notes: ['Rate limited to 200 messages per minute by the provider.'],
    };
  }

  protected async onShutdown() {
    await this.client?.close();
  }
}
```

What the base class gives you:

- **`health()` never throws.** A throwing check becomes `critical` with the reason attached, which
  tells an operator strictly more than `unknown`.
- **`shutdown()` is idempotent** and swallows its own errors. A provider that threw there would
  stop the others shutting down, turning one bad adapter into a process that will not exit.
- **`configuration()` redacts** by field name, and reports an unset secret as `null` rather than
  `[REDACTED]` — an operator debugging a missing credential needs to tell those apart.
- **`requireConfig()`** gives a clear error rather than a null dereference when something is used
  before initialization.

## Registering

```ts
const registry = new ProviderRegistry({ serviceName: 'merchant-api', environment: 'production' });

const { ready, error } = await registry.register(new SmtpMailProvider(), config.mail);
```

Configuration is validated **before** `initialize` is called, so an implementation may assume
validity — which removes a class of defensive checks from every adapter.

**A provider that fails to initialize does not stop start-up.** It is registered as failed, reports
`critical`, and the application boots. Refusing to start because the SMS gateway is misconfigured
takes down every request, including the ones that do not use it.

A configuration that does not _parse_, however, does throw. That is a deployment mistake somebody
can fix in seconds, and failing loudly at registration is the fastest way to tell them.

## Calling through the registry

```ts
await registry.call('mail.smtp', 'send', (provider) =>
  (provider as SmtpMailProvider).send(message),
);
```

Rather than calling the provider directly, because this adds a circuit breaker. A downstream that
is down should fail fast: without one, every request waits out the full retry schedule against a
service that is not coming back within the request's lifetime, and the application's own capacity
is consumed waiting.

## Health and configuration

```bash
GET /providers          # capabilities and redacted configuration
GET /providers/health   # every provider, checked concurrently
```

Concurrently matters: a health endpoint that checked six providers serially would take as long as
the sum of their timeouts, which is exactly when it is most likely to be scraped.

`trustos doctor integrations` prints the same information offline.

## Why no implementations

Not one provider ships with the framework. No SMTP, no S3, no SMS, and — explicitly — no payment
gateway.

A framework that shipped a payment adapter would be making a payment decision for every product
built on it, and the products that disagreed would carry the dependency anyway. Worse, the adapter
would accumulate the specifics of whoever wrote it first, and the second product would find them
in the framework rather than in a package it could replace.

The seam is the deliverable. Writing an adapter against this contract is an afternoon; unpicking
one that was imposed is a quarter.

---

**See also:** [integration-architecture.md](integration-architecture.md) ·
[synchronization.md](synchronization.md)
