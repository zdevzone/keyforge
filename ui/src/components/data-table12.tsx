/** Adapted from @shadcnblocks/data-table12. Demo orders are replaced by typed KeyForge records. */
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { PageNavigation } from "./PageNavigation";
export type DataColumn<T> = {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (value: unknown, row: T) => ReactNode;
  align?: "left" | "right";
  numeric?: boolean;
  width?: number | string;
};
export function SortableDataTable<T extends Record<string, unknown>>({
  rows,
  columns,
  rowKey,
  caption = "Records",
  defaultSort,
  emptyMessage = "No records found.",
  pageSize = 20,
  toolbar,
}: {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: keyof T | ((row: T) => string);
  caption?: string;
  defaultSort?: { key: string; direction: "asc" | "desc" };
  emptyMessage?: string;
  pageSize?: number;
  itemName?: { one: string; other: string };
  toolbar?: ReactNode;
}) {
  "use no memo";
  const [sorting, setSorting] = useState<SortingState>(
    defaultSort ? [{ id: defaultSort.key, desc: defaultSort.direction === "desc" }] : [],
  );
  const defs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((column) => ({
        id: column.key,
        accessorFn: (row) => row[column.key],
        header: column.label,
        enableSorting: column.sortable !== false,
        enableHiding: column.key !== "actions",
        cell: ({ row, getValue }) =>
          column.render ? column.render(getValue(), row.original) : String(getValue() ?? ""),
        sortingFn: "alphanumeric",
        sortUndefined: "last",
      })),
    [columns],
  );
  // oxlint-disable-next-line react/incompatible-library -- TanStack v8 is intentionally opted out of compiler memoization above.
  const table = useReactTable({
    data: rows,
    columns: defs,
    getRowId: (row) => (typeof rowKey === "function" ? rowKey(row) : String(row[rowKey])),
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });
  const state = table.getState().pagination;
  const count = table.getRowCount();
  return (
    <div className="data-grid">
      <div className="data-grid-tools">
        {toolbar}
        <span className="text-xs text-muted-foreground">
          {count} {caption.toLowerCase()}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <SlidersHorizontal data-icon="inline-start" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {table
                .getAllLeafColumns()
                .filter((c) => c.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(Boolean(value))}
                  >
                    {columns.find((c) => c.key === column.id)?.label ?? column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const config = columns.find((c) => c.key === header.column.id);
                const sorted = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    scope="col"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                    className={cn((config?.align === "right" || config?.numeric) && "text-right")}
                    style={{ width: config?.width }}
                  >
                    {header.column.getCanSort() ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={"Sort by " + config?.label}
                        className={cn("px-0", config?.align === "right" && "ml-auto")}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === "asc" ? (
                          <ArrowUp aria-hidden="true" />
                        ) : sorted === "desc" ? (
                          <ArrowDown aria-hidden="true" />
                        ) : (
                          <ChevronsUpDown aria-hidden="true" />
                        )}
                      </Button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => {
                const config = columns.find((c) => c.key === cell.column.id);
                return (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      "whitespace-normal",
                      (config?.align === "right" || config?.numeric) && "text-right",
                    )}
                  >
                    {config?.render
                      ? config.render(cell.getValue(), row.original)
                      : String(cell.getValue() ?? "")}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
          {!count && (
            <TableRow>
              <TableCell colSpan={columns.length}>
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No matching records</EmptyTitle>
                    <EmptyDescription>{emptyMessage}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {count > pageSize && (
        <div className="table-pagination">
          <p aria-live="polite">
            {state.pageIndex * pageSize + 1}–{Math.min((state.pageIndex + 1) * pageSize, count)} of{" "}
            {count}
          </p>
          <PageNavigation
            label={caption + " pages"}
            page={state.pageIndex + 1}
            pageCount={table.getPageCount()}
            onPageChange={(page) => table.setPageIndex(page - 1)}
          />
        </div>
      )}
    </div>
  );
}
