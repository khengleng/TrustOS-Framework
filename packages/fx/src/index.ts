/**
 * @trustsystem/fx
 *
 * Exchange rates, conversion with spread, rate sources and historical lookup.
 *
 * **No live integration**, and that is not only the framework's usual rule about providers: which
 * rate to use is a commercial decision. Mid-market, a provider's rate, and a treasury team's daily
 * fix are three different numbers, and a framework that picked one would be pricing somebody's
 * product.
 */
export * from './rates';
export * from './testing';
