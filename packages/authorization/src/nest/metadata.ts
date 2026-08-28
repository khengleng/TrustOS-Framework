/** Route metadata for policy authorization. */
export const AUTHORIZATION_METADATA = {
  /** Action the route performs. Set by `@Authorize(...)`. */
  ACTION: 'trustos:authorize-action',
  /** Resource type the route acts on. */
  RESOURCE_TYPE: 'trustos:authorize-resource-type',
} as const;
