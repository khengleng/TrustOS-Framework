/**
 * The API base URL.
 *
 * Only `NEXT_PUBLIC_*` reaches the browser; nothing from @trustos/config is imported here,
 * because that package reads secrets and a bundler that can see it can inline them.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api';
