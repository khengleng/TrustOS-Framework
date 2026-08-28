/**
 * @trustos/financial-product-policy
 *
 * Financial product separation of duties, as policies on the phase 4 authorization engine.
 *
 * Every policy here can only refuse — none returns `allow` — so the set inherits default-deny and
 * adding one can only make the system stricter. Build the resource with `productResource()`: a
 * policy that cannot find the field it needs abstains, and an abstaining separation-of-duty
 * policy is a control that silently does not run.
 */
export * from './policies';
