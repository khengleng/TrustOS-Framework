# Plugin development

How to write a plugin, and — first — what the security model actually is.

---

## 1. What this is not

**Plugins are not sandboxed.**

Node has no usable in-process sandbox. `vm` is not a security boundary, worker threads share the
filesystem and the network, and a framework that claimed isolation it does not have would be the
most dangerous thing in the platform: it would make people install code they would otherwise
review.

So the model is stated plainly:

> A plugin is **third-party code running with the full privileges of the host process**. What the
> framework provides is a signature you can verify, a permission list you can read before
> installing, and a registry that refuses what your policy forbids. The rest is review.

Install a plugin the way you would add a dependency to a service that handles your customers'
data — because that is exactly what you are doing.

---

## 2. The manifest

```json
{
  "id": "acme-reporter",
  "name": "Acme Reporter",
  "description": "Adds a reporting command to the CLI.",
  "version": "1.0.0",
  "author": "Acme Engineering <platform@acme.example>",
  "license": "MIT",
  "frameworkRange": "^0.6.0",
  "extensionPoints": ["cli"],
  "permissions": ["cli:register", "registry:read"],
  "main": "dist/index.js",
  "outOfScope": ["writing to the database", "network access"]
}
```

### `frameworkRange` must be bounded

`>=0.1.0` is refused. It claims compatibility with versions that do not exist yet, which is a
claim its author cannot have tested. Use `^` or `~`, which bound the claim at the next breaking
boundary.

### `outOfScope`

Same reason modules and templates carry one: a stated exclusion is reviewable, and a plugin that
later grows the thing it said it would not is a visible change rather than a drift.

---

## 3. Extension points

A closed list. An open extension surface is one where the next release cannot change anything
without breaking a plugin nobody knew existed.

| Point           | A plugin may                                                 |
| --------------- | ------------------------------------------------------------ |
| `cli`           | Register commands                                            |
| `template`      | Contribute templates                                         |
| `agent`         | Register an agent or tool                                    |
| `module`        | Contribute a module                                          |
| `provider`      | Implement a provider port — a rate source, a storage backend |
| `ui`            | Contribute admin components                                  |
| `documentation` | Contribute documentation pages                               |

---

## 4. Permissions

Ten, coarse on purpose. A permission system with sixty entries is one nobody reads, and a reviewer
who does not read the permissions approves anything.

| Permission          | Grants                                |
| ------------------- | ------------------------------------- |
| `config:read`       | Read configuration, excluding secrets |
| `registry:read`     | Read the module and template catalogs |
| `filesystem:read`   | Read files in the project             |
| `cli:register`      | Add CLI commands                      |
| `template:register` | Add templates                         |
| `telemetry:emit`    | Record usage events through the host  |

### The four that make a plugin arbitrary code

| Permission         | Means                                  |
| ------------------ | -------------------------------------- |
| `filesystem:write` | Create and modify files in the project |
| `network`          | Open connections to anywhere           |
| `process:spawn`    | Run other programs on this machine     |
| `database`         | Query the application database         |

These need **explicit consent at install time**, and a deployment policy can forbid them outright.
Denied outranks consent — the person clicking is not the person who wrote the policy.

There is no runtime permission request. A prompt during execution is a prompt somebody clicks
through, and a permission granted mid-run cannot be reviewed before the run.

The installer shows what a plugin can _do to you_, not permission names:

> Create and modify files in this project. Open network connections to anywhere.

"Requests filesystem:write" is a string people scroll past.

---

## 5. Signing

```
digest  → SHA-256 over path + content hash, per file, sorted
sign    → over the digest, with your key
verify  → content first, then key, then signature
```

**Content is checked before the signature.** A valid signature over a _different_ digest would
otherwise pass, since the signature is over the digest.

**The path is part of the digest.** Hashing concatenated contents alone gives the same digest to
two different layouts — rename a file and the archive verifies unchanged, which is how a malicious
`postinstall` gets swapped in for a README.

**The key decides the algorithm.** A signature claiming a weaker algorithm than the key was issued
for is refused; otherwise an algorithm-confusion attack works.

**Verification is offline.** No key server, no OCSP. The trust store is configuration the
deployment controls, because otherwise whoever controls the network at install time controls what
gets installed.

### `--allow-unsigned`

Permits exactly one failure: no signature present. It never permits a bad signature, an unknown
key or a revoked one — those are not "unsigned", they are "signed by someone you do not trust".
The override is recorded on the installed record, so `trustos plugins --unsigned` answers the
question a security review asks first.

---

## 6. Writing one

```ts
import type { PluginManifest } from '@trustsystem/plugin-framework';

export const manifest: PluginManifest = {/* as above */};

/** Called once, after the host has verified and approved the plugin. */
export function register(host: PluginHost): void {
  host.cli.command('acme report').action(async () => {
    // Only what the manifest declared. Reaching further is a review failure, not a runtime one —
    // there is no sandbox to stop you.
  });
}
```

Rules:

1. **Do nothing at import time.** The registry never imports a plugin in order to inspect it,
   precisely so nothing runs before it is approved. Honour that: side effects belong in
   `register`.
2. **Declare everything you use.** An undeclared capability is a review failure.
3. **Never read secrets.** `config:read` excludes them; reaching around it is the line between a
   plugin and an incident.
4. **Fail loudly.** A plugin that swallows an error leaves the host believing it worked.

---

## 7. Publishing

1. Build, then compute the digest over the shipped files.
2. Sign the digest with your key.
3. Publish manifest, artefact and signature together.
4. Give consumers your public key **through a channel that is not the artefact**. A key shipped
   beside the thing it signs proves nothing.

---

## 8. For deployments installing one

```bash
trustos plugins                # what is installed and what it can do
trustos plugins --privileged   # those holding one of the dangerous four
trustos plugins --unsigned     # installed without a signature
```

Before installing:

- [ ] Read `permissions`. Does it need all of them?
- [ ] Read `outOfScope`. Does it match what the description claims?
- [ ] Is it signed, by a key you added deliberately?
- [ ] Do you have the source, or a reason to trust the author without it?
- [ ] Would you deploy this code if a colleague had written it? **There is no sandbox. That is the
      standard.**

Disable rather than remove when a plugin is suspected rather than proven bad —
`setEnabled(id, false)` leaves it in place for investigation while stopping it contributing.
