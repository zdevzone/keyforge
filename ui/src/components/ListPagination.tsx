import { useState } from "react";

import { PageNavigation as Pagination } from "./PageNavigation";

export function useListPage<T>(rows: T[], resetKey = "", size = 20) {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const page = state.key === resetKey ? Math.min(state.page, pageCount) : 1;
  const onPageChange = (next: number) => setState({ key: resetKey, page: next });
  return {
    rows: rows.slice((page - 1) * size, page * size),
    page,
    pageCount,
    onPageChange,
    total: rows.length,
    size,
  };
}

export function ListPagination({
  page,
  pageCount,
  onPageChange,
  total,
  size = 20,
  label = "List pages",
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  total: number;
  size?: number;
  label?: string;
}) {
  if (total <= size) return null;
  return (
    <div className="table-pagination flex-wrap gap-3">
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {(page - 1) * size + 1}–{Math.min(page * size, total)} of {total}
      </p>
      <Pagination page={page} pageCount={pageCount} onPageChange={onPageChange} label={label} />
    </div>
  );
}
