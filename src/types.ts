// ─── Shared Interfaces ─────────────────────────────────────────
// Centralized type definitions used across multiple modules.
// Keeps things DRY — instead of each workflow defining its own types,
// they all import from here.

// Represents a single table's metadata from the database.
// Used by compareWorkflow and compareTableDataWorkflow to show table lists.
export interface TableInfo {
  name: string;
  rows: number;
  columns: number;
  size: string;
}

// Holds the structured diff results from a table data comparison.
// Used for both terminal display and CSV/JSON export.
export interface DiffResult {
  table: string;
  pkColumn: string;
  label1: string;
  label2: string;
  onlyInDb1: Record<string, any>[];
  onlyInDb2: Record<string, any>[];
  modified: { pk: string; column: string; db1Value: string; db2Value: string }[];
  columns: string[];
}
