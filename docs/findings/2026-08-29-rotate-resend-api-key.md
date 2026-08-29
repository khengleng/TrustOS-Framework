# REMEDIATION ITEM — rotate the Resend API key

|              |                                                                                       |
| ------------ | ------------------------------------------------------------------------------------- |
| **Severity** | MEDIUM                                                                                |
| **Status**   | OPEN — requires the human operator                                                    |
| **Raised**   | 2026-08-29                                                                            |
| **Scope**    | Transactional email (password reset / forgotten password) from `contact@cambobia.com` |

## What happened

A Resend API key was pasted into a chat transcript during earlier configuration work. A
credential that has appeared in a transcript must be treated as exposed, regardless of
who could read it.

The key was not retrieved, reused, printed or stored during this task, and it does not
appear anywhere in this repository — confirmed by the branch secret scan, which found no
`re_`-prefixed value in any added line.

## Action required

1. Rotate the key in the Resend dashboard, which invalidates the exposed one.
2. Update the runtime secret store for each environment that sends email.
3. Do not place the new value in source control, documentation or a chat message.

## Why this did not block foundation validation

Machine-token authentication does not send email. The foundation controls under
validation — authentication, tenancy, RBAC, policy, workflow, maker-checker, audit — do
not depend on transactional email, so this is tracked rather than blocking.
