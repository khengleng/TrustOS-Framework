/**
 * @trustsystem/data-access-policy
 *
 * Who may reach governed data, for what purpose, and the review that proves it.
 *
 * **Access is granted for a purpose**, against data whose catalog entry states its own — which
 * is what stops a product-analytics grant from quietly covering the fraud investigation table
 * because both words contain "analysis".
 *
 * **Grants expire, and a review renews them.** Doing nothing ends a grant. An access review where
 * doing nothing preserves the status quo is a review that gets skipped, and the skipping is
 * invisible.
 */
export * from './access';
