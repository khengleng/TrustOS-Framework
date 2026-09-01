/**
 * @trustsystem/governance-tool-sdk
 *
 * The SDK an internal application is built against. Headless, for the reason `@trustsystem/template-sdk`
 * is: one deployment renders React and another does not.
 *
 * It enforces one habit: **the frontend holds no business logic.** A fee recomputed in a browser
 * is a second implementation of the fee, and the one the customer sees is the browser's while the
 * one that settles is the server's. So the client has `list` and `submit`, and no `compute`.
 *
 * `shouldRender` is the only permission helper, and its name says what it is for. There is no
 * `can` — a helper called `can` is a helper somebody uses as the check, and the check is on the
 * server.
 */
export * from './client';
