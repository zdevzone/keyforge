import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationEllipsis,
} from "@/components/ui/pagination";
export function PageNavigation({
  page,
  pageCount,
  onPageChange,
  label = "List pages",
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  label?: string;
}) {
  const pages = Array.from({ length: Math.max(1, pageCount) }, (_, i) => i + 1).filter(
    (p) => p === 1 || p === pageCount || Math.abs(p - page) <= 1,
  );
  return (
    <Pagination aria-label={label} className="mx-0 w-auto">
      <PaginationContent>
        <PaginationItem>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => {
              if (page > 1) onPageChange(page - 1);
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
        </PaginationItem>
        {pages.flatMap((p, i) => [
          i > 0 && p - pages[i - 1] > 1 ? (
            <PaginationItem key={"gap-" + p}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : null,
          <PaginationItem key={p}>
            <Button
              variant={p === page ? "outline" : "ghost"}
              size="icon"
              aria-current={p === page ? "page" : undefined}
              aria-label={"Page " + p}
              onClick={() => {
                onPageChange(p);
              }}
            >
              {p}
            </Button>
          </PaginationItem>,
        ])}
        <PaginationItem>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => {
              if (page < pageCount) onPageChange(page + 1);
            }}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
