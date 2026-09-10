import {
  Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, Typography,
} from "@mui/material";
import { ReactNode, useMemo, useState } from "react";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string | number;
  emptyMessage: string;
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({ columns, rows, getRowKey, emptyMessage, onRowClick }: Props<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sortKey);
    if (!column?.sortValue) return rows;
    const sortValue = column.sortValue;
    // Compared by the column's own sortValue rather than by rendered text, so
    // a numeric column sorts 2 before 10 instead of lexically.
    return [...rows].sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return asc ? cmp : -cmp;
    });
  }, [rows, columns, sortKey, asc]);

  if (rows.length === 0) {
    return (
      <Paper sx={{ p: 3 }}>
        <Typography color="text.secondary">{emptyMessage}</Typography>
      </Paper>
    );
  }

  return (
    <TableContainer component={Paper}>
      <Table size="small">
        <TableHead>
          <TableRow>
            {columns.map((c) => (
              <TableCell key={c.key}>
                {c.sortValue ? (
                  <TableSortLabel
                    active={sortKey === c.key}
                    direction={sortKey === c.key && !asc ? "desc" : "asc"}
                    onClick={() => {
                      if (sortKey === c.key) setAsc(!asc);
                      else {
                        setSortKey(c.key);
                        setAsc(true);
                      }
                    }}
                  >
                    {c.header}
                  </TableSortLabel>
                ) : (
                  c.header
                )}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((row) => (
            <TableRow
              key={getRowKey(row)}
              hover={Boolean(onRowClick)}
              sx={onRowClick ? { cursor: "pointer" } : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <TableCell key={c.key}>{c.render(row)}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
