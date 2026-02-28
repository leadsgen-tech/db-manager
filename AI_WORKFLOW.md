# AI Workflow Documentation

## Tools Used

- **Claude (via Cursor IDE)** — Primary AI coding assistant for implementation, code review, and debugging
- **Manual coding** — Architecture decisions, SQL query design, edge case handling

---

## Prompt History & Decision Log

### Phase 1: Understanding the Codebase

**Prompt 1:**

> "Explain what this project does and how it works with examples"

**Why AI:** Faster than reading 900 lines of unfamiliar code. Got a structural overview and a summary in seconds.

**What I learned:** The entire app is a single `index.ts` file using `postgres`, `inquirer`, `chalk`, and `cli-table3`. All workflows (compare, export, import, inspect) are standalone functions called from a `main()` switch.

**Prompt 2:**

> "i see this project violates srp, ocp, isp and dependency invcersionWhat other solid principles or SE principles does this project violate?"

**Why AI:** Wanted a second opinion on code quality before making changes. AI caught things I agreed with (SRP violation, no tests, forced SSL) and things I deprioritized (no config file — out of scope for this task).

**My corrections:** AI suggested refactoring into multiple files. I chose NOT to do that because:

1. The task is to add a feature, not restructure the project
2. Keeping it in one file means smaller diff = easier code review
3. Refactoring without tests is risky

---

### Phase 2: Bug Fix (SSL for Local Connections)

**Prompt 3:**

> "The connection fails with ECONNRESET on localhost — the createSql function forces SSL"

Add an `isLocalUrl()` helper that checks for `localhost`, `127.0.0.1`, `::1` and skip SSL for local connections.

**What I wrote myself:** The actual SQL connection options object — I know the `postgres` library API and didn't want AI hallucinating config options.

**What AI wrote:** The `isLocalUrl()` detection function. Simple enough to trust.

**Correction needed later:** Tests revealed `new URL()` returns `[::1]` with brackets for IPv6, not `::1`. AI's original implementation missed this. I caught it when the unit test failed and added `|| host === '[::1]'`. This is exactly why we write tests.

---

### Phase 3: Feature Design — Compare Table Data

**Prompt 4:**

> "I want to add row-level comparison. Before writing code, explain how the output would look"

**Why manual first:** I wanted to validate the UX before writing any code. Seeing the expected output helped me think through:

- What columns to show (capped at 6 for readability)
- How to handle tables with no primary key
- Pagination (show 10, offer "show all?")

**Prompt 5:**

> "How should we detect primary keys? What if a table has no PK?"

**AI suggestion:** Query `information_schema.table_constraints` + `key_column_usage` for PK, fall back to UNIQUE constraint.

**My decision:** I chose this over `pg_indexes` because `information_schema` is SQL standard and works across PostgreSQL versions. AI initially suggested a simpler query that didn't handle composite keys — I asked it to use `ordinal_position` ordering.

---

### Phase 4: Core Implementation

**Prompt 6:**

> "Implement compareTableDataWorkflow following this plan: [pasted my design notes]"

**What AI generated:** The skeleton — prompts, spinners, connection testing, table selection. This is boilerplate that follows the same pattern as the existing `compareWorkflow()`.

**What I wrote/heavily modified:**

1. **The diff algorithm** — AI initially suggested using SQL `EXCEPT` across databases. That doesn't work because `EXCEPT` is a single-connection operator — you can't EXCEPT across two different database connections. I caught this and redesigned it to:
   - Fetch PKs from both DBs separately
   - Use JavaScript `Set` for O(1) lookups
   - Find set differences in JS

2. **Parameterized queries** — AI's first version used string interpolation for PK values in WHERE clauses. I rewrote it to use `$1, $2, $3...` parameterized queries to prevent SQL injection. Column/table names still use interpolation (unavoidable with dynamic SQL), but VALUES are always parameterized.

3. **Display logic** — I refactored the duplicate table-rendering code into a `displayRowsTable()` helper. AI had copy-pasted the same 30 lines twice.

---

### Phase 5: Bonus Features

**Prompt 7:**

> "Add column-level diffs — detect rows that exist in both DBs but have different values"

**My design decision:** Compare ALL columns (not just display columns) to catch every difference, but only show 6 columns in the "missing rows" tables for readability. The modified-rows table uses a different format: `PK | Column | DB1 Value | DB2 Value` with red/green coloring.

**AI contribution:** The batched comparison loop structure. I specified the batch size (500) and the Map-based lookup pattern.

**Prompt 8:**

> "Add CSV/JSON export for the diff results"

**What I wrote myself:** The CSV escaping logic (handling commas and quotes in values). AI's first attempt didn't properly escape CSV fields containing commas.

**What AI wrote:** The JSON export structure — straightforward `JSON.stringify` with the DiffResult interface.

**Prompt 9:**

> "Optimize for large tables — batch the PK fetching"

**My design:** `LIMIT/OFFSET` pagination with 5K batch size. I chose this over cursor-based pagination because:

- Simpler to implement
- PKs are indexed, so OFFSET on an ordered PK column is efficient
- We're only fetching one column (the PK), so even 5K rows is lightweight

**AI helped with:** The progress percentage calculation and spinner updates.

---

### Phase 6: Unit Tests

**Prompt 10:**

> "Create unit tests for the pure utility functions using vitest"

**AI contribution:** Generated the test structure and most test cases.

**What I fixed:**

1. **Entry point guard** — When tests imported `index.ts`, the `main()` call at the bottom executed the CLI. I added a guard: `const isDirectRun = process.argv[1]?.endsWith('index.ts')` to prevent this. AI didn't anticipate this side-effect issue.

2. **IPv6 test failure** — The `isLocalUrl` test for `[::1]` failed because the actual `URL` API returns brackets. This was a real bug AI introduced in Phase 2, and the test correctly caught it.

3. **Export validation** — AI's `validateUrl` test for `postgresql://` edge case was ambiguous. I made it check the return type instead of a specific value, since it's a valid URL according to the URL parser.

---

## AI vs Manual Breakdown

| Component               | AI-Generated             | I Wrote/Modified              | Why                                                 |
| ----------------------- | ------------------------ | ----------------------------- | --------------------------------------------------- |
| `isLocalUrl()`          | ✅ Initial version       | Fixed IPv6 bug                | Simple detection logic, but AI missed URL API quirk |
| `getPrimaryKeyColumn()` | ✅ SQL query             | Reviewed & approved           | Standard information_schema query                   |
| `getTableColumns()`     | ✅                       | —                             | Trivial query                                       |
| `tableExistsInDb()`     | ✅                       | —                             | Trivial query                                       |
| PK diff algorithm       | ❌ AI version broken     | ✅ Redesigned with Sets       | AI tried cross-DB EXCEPT which doesn't work         |
| Parameterized queries   | ❌ AI used string interp | ✅ Rewrote with $1, $2        | Security — SQL injection prevention                 |
| `displayRowsTable()`    | ❌                       | ✅ Extracted from duplication | AI copy-pasted, I refactored                        |
| Column-level diffs      | Partial (loop structure) | ✅ Design + Map pattern       | Core algorithmic decision                           |
| CSV export              | Partial (structure)      | ✅ Escaping logic             | AI didn't handle commas in values                   |
| JSON export             | ✅                       | —                             | Straightforward serialization                       |
| `fetchPksBatched()`     | Partial                  | ✅ LIMIT/OFFSET design        | Performance architecture decision                   |
| Unit tests              | ✅ Most cases            | Fixed 3 issues                | Tests revealed real bugs                            |
| `main()` guard          | ❌                       | ✅                            | Side-effect AI didn't anticipate                    |
| Comments                | ✅ Generated             | ✅ Reviewed & edited          | Made them explain "why" not "what"                  |

---

## Key Corrections to AI Output

1. **Cross-DB EXCEPT doesn't work** — AI suggested `SELECT pk FROM table1 EXCEPT SELECT pk FROM table2` but these are on different connections. Redesigned to use JS Sets.

2. **SQL injection in WHERE clause** — AI interpolated PK values directly into SQL strings. Rewrote to use `$1, $2...` parameterized placeholders.

3. **IPv6 hostname brackets** — `new URL('postgresql://...@[::1]:5432/db').hostname` returns `[::1]` not `::1`. Found by unit test.

4. **Side effects on import** — `main()` ran when tests imported `index.ts`. Added entry-point guard.

5. **CSV escaping** — Values containing commas broke CSV output. Added proper quoting.

---

## My Approach to AI Collaboration

**When I use AI:**

- Boilerplate and repetitive patterns (CLI prompts, table formatting)
- Initial drafts of functions I'll review and modify
- Generating test cases (faster than typing them all manually)
- Understanding unfamiliar codebases quickly

**My workflow pattern:**

1. Think about the problem manually first
2. Design the approach (whiteboard-level)
3. Ask AI to implement my design
4. Review every line — especially SQL, security, and edge cases
5. Write tests to validate AI output
6. Fix what the tests catch

i believe that AI is a tool that can help you code faster, but it's not a replacement for thinking. I used it to go faster on the 80% that's straightforward, so I could spend my time on the 20% that actually matters — algorithm design, security, edge cases, and testing.

---

### Phase 7: SOLID Refactoring

After completing all bonus features, I went back and fixed the architectural violations I identified in Phase 1. Now that we had tests in place, refactoring was safe.

**Prompt 11:**

> "The index.ts is 1488 lines and violates SRP, OCP, and DIP. Split it into modules following SOLID principles."

**My architecture decision (not AI's):** I designed the module structure myself:

```
src/
  types.ts          — Shared interfaces (TableInfo, DiffResult)
  utils.ts          — Pure utility functions (no DB dependency)
  db.ts             — Database helpers (create connection, query)
  shell.ts          — Shell commands + PG binary resolution
  workflows/
    compare.ts      — Compare Databases
    compareData.ts  — Compare Table Data (column diffs, export, batching)
    export.ts       — Export Database
    import.ts       — Import Database
    inspect.ts      — Inspect Dump File
```

**Why I did the refactoring AFTER writing tests:** Phase 6 gave us 30 unit tests as a safety net. Without those tests, splitting 1488 lines into 9 files would be reckless — any import typo or missed function could break the CLI silently.

**What AI did:** Moved code blocks to the correct files and added import statements. This is mechanical work — perfect for AI.

**What I did:**

1. Decided the module boundaries (which functions belong together)
2. Chose the dependency direction (workflows → db → utils, never backwards)
3. Verified all 30 tests still pass after the split
4. Ensured `npm start` still works (entry point hasn't changed)

**SOLID violations fixed:**

- **SRP**: Each file has a single responsibility. `utils.ts` only formats, `db.ts` only queries, each workflow file handles one CLI flow.
- **OCP**: Adding a new workflow = create a new file in `workflows/` + add one import + one switch case. No existing code touched.
- **DIP**: Workflows import from `db.ts` and `utils.ts` — they depend on abstractions, not on a monolithic file that does everything.

**Result:** `index.ts` went from **1488 lines → ~90 lines** (just banner + menu). All 30 tests pass unchanged.
