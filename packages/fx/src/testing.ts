import type { ExchangeRate, RateStore } from './rates';

/**
 * An in-memory rate store, for tests and development.
 *
 * `find` returns the most recent rate *at or before* the requested moment, which is the only
 * correct answer for a historical lookup: a conversion dated last Tuesday must use last Tuesday's
 * rate, not today's, or every restated report changes.
 */
export class InMemoryRateStore implements RateStore {
  readonly rates: ExchangeRate[] = [];

  async put(rate: ExchangeRate): Promise<ExchangeRate> {
    this.rates.push(rate);
    return rate;
  }

  async find(input: {
    organizationId: string | null;
    fromCurrency: string;
    toCurrency: string;
    source?: string;
    asOf?: Date;
  }): Promise<ExchangeRate | null> {
    const asOf = input.asOf ?? new Date(8.64e15);

    return (
      this.rates
        .filter((rate) => rate.organizationId === input.organizationId)
        .filter((rate) => rate.fromCurrency === input.fromCurrency)
        .filter((rate) => rate.toCurrency === input.toCurrency)
        .filter((rate) => !input.source || rate.source === input.source)
        .filter((rate) => rate.quotedAt <= asOf)
        .sort((a, b) => b.quotedAt.getTime() - a.quotedAt.getTime())[0] ?? null
    );
  }

  async history(input: {
    organizationId: string | null;
    fromCurrency: string;
    toCurrency: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<ExchangeRate[]> {
    return this.rates
      .filter((rate) => rate.organizationId === input.organizationId)
      .filter((rate) => rate.fromCurrency === input.fromCurrency)
      .filter((rate) => rate.toCurrency === input.toCurrency)
      .filter((rate) => !input.from || rate.quotedAt >= input.from)
      .filter((rate) => !input.to || rate.quotedAt <= input.to)
      .sort((a, b) => b.quotedAt.getTime() - a.quotedAt.getTime())
      .slice(0, input.limit ?? 200);
  }
}
