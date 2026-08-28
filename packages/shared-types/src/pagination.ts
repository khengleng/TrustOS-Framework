export interface PageQuery {
  page: number;
  pageSize: number;
}

export interface PageMeta extends PageQuery {
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Builds page metadata without duplicating the arithmetic at every call site. */
export function buildPageMeta(query: PageQuery, totalItems: number): PageMeta {
  const totalPages = query.pageSize > 0 ? Math.ceil(totalItems / query.pageSize) : 0;
  return {
    page: query.page,
    pageSize: query.pageSize,
    totalItems,
    totalPages,
    hasNextPage: query.page < totalPages,
  };
}
