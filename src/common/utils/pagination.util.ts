export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** Normalisasi query ?page=&limit= menjadi { skip, take } untuk Prisma. */
export function paginate(page = 1, limit: number = DEFAULT_LIMIT): PaginationParams {
  const safePage = Math.max(1, Math.floor(Number(page)) || 1);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || DEFAULT_LIMIT));
  return {
    page: safePage,
    limit: safeLimit,
    skip: (safePage - 1) * safeLimit,
    take: safeLimit,
  };
}

/** Bangun objek meta untuk envelope paginasi { data, meta }. */
export function buildMeta(total: number, page: number, limit: number): PageMeta {
  return {
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}
