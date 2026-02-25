# DB Manager (dbm)

Interactive PostgreSQL/Supabase database manager for comparing, exporting, and importing databases with an intuitive CLI interface.

## Features

- **📊 Compare Databases** - Side-by-side comparison of 2-3 databases with row counts and delta calculations
- **📦 Export Database** - Export full databases, schemas only, data only, or specific tables
- **📥 Import Database** - Import with safety features including automatic backups and verification
- **🔍 Inspect Dump Files** - Preview dump file contents without importing

## Installation

### Prerequisites

- Node.js 18+ (uses ES modules)
- PostgreSQL tools (pg_dump, pg_restore, psql)

**macOS:**
```bash
brew install postgresql@17
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install postgresql-client-17
```

**Windows:**
1. Download PostgreSQL from https://www.postgresql.org/download/windows/
2. Run the installer (includes command-line tools)
3. Add PostgreSQL `bin` directory to your PATH:
   - Default location: `C:\Program Files\PostgreSQL\17\bin`
   - Or the tool will auto-detect it

### Install dbm

**Clone and install locally:**
```bash
git clone https://github.com/leadsgen-tech/db-manager.git
cd db-manager
npm install
npm link  # Makes 'dbm' available globally
```

**Or run directly without installation:**
```bash
git clone https://github.com/leadsgen-tech/db-manager.git
cd db-manager
npm install
npm start
```

## Usage

Simply run:
```bash
dbm
```

You'll be presented with an interactive menu:

```
┌─────────────────────────────────────┐
│         DB Manager v1.0.0           │
│   PostgreSQL / Supabase Tool        │
└─────────────────────────────────────┘

? What would you like to do?
  📊  Compare Databases
  📦  Export Database
  📥  Import Database
  🔍  Inspect Dump File
  ───────────────────
  👋  Exit
```

## Features in Detail

### Compare Databases

Compare 2 or 3 databases side-by-side:
- Exact row counts for all tables
- Delta calculations (for 2-database comparison)
- Total database size
- Highlights tables with differences
- Shows which database has more/fewer rows

**Example output:**
```
┌──────────┬─────────────┬─────────────┬──────────┐
│ Table    │ Production  │ Staging     │ Delta    │
├──────────┼─────────────┼─────────────┼──────────┤
│ users    │      12,450 │      12,450 │ —        │
│ orders   │     156,789 │     156,823 │ +34      │
│ products │       1,234 │       1,230 │ -4       │
└──────────┴─────────────┴─────────────┴──────────┘
```

### Export Database

Export options:
- **Full** - Schema + data (complete backup)
- **Data only** - Just the data (keeps schema separate)
- **Schema only** - Structure without data
- **Specific tables** - Choose exactly which tables to export

**Formats:**
- `.dump` (custom format) - Recommended for `pg_restore`, compressed
- `.sql` (plain text) - Human-readable, can be edited

**Features:**
- Shows table preview before export
- Configurable output path
- Automatic SSL/TLS for Supabase connections
- Progress feedback

### Import Database

Import with safety features:
- **Automatic backup** - Creates backup before importing (optional)
- **Preview target** - See what's currently in the database
- **Verification** - Automatically verify row counts after import
- **Multiple modes:**
  - Full restore (clean + restore)
  - Data only (keeps schema, replaces data)
  - Append (add data without deleting)

**Supports:**
- `.dump` files (via pg_restore)
- `.sql` files (via psql)

### Inspect Dump Files

Preview dump file contents without importing:
- Shows schema objects count
- Lists tables with data
- File size and metadata
- No database connection required

## Configuration

### Database URLs

The tool accepts standard PostgreSQL connection strings:

```
postgresql://user:password@host:port/database
```

**Supabase examples:**

Direct connection:
```
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
```

Transaction pooler (recommended for serverless):
```
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

### Export Location

Default export directory: `~/db-exports/`

Files are automatically named with:
- Database identifier
- Export type
- Timestamp

Example: `myproject_full_2026-02-25T10-30-00.dump`

## Technical Details

### Dependencies

- **postgres** - Fast PostgreSQL client for Node.js
- **@inquirer/prompts** - Interactive CLI prompts
- **chalk** - Terminal styling
- **cli-table3** - ASCII tables
- **ora** - Elegant terminal spinners

### Connection Handling

- Automatic SSL/TLS for Supabase connections
- Connection pooling disabled (max: 1) for CLI safety
- 10-second connection timeout
- Automatic URL masking for security (passwords hidden in output)

### PostgreSQL Tool Detection

Automatically searches for PostgreSQL binaries in common locations:

**Windows:**
- `C:\Program Files\PostgreSQL\{17,16,15}\bin`
- `C:\Program Files (x86)\PostgreSQL\{17,16,15}\bin`
- System PATH

**macOS:**
- `/opt/homebrew/opt/postgresql@{17,16,15}/bin` (Apple Silicon)
- `/usr/local/opt/postgresql@{17,16,15}/bin` (Intel)
- System PATH

**Linux:**
- System PATH

Prefers newer versions (v17 > v16 > v15).

## Development

### Setup

```bash
git clone https://github.com/leadsgen-tech/db-manager.git
cd db-manager
npm install
```

### Run locally

```bash
npm run dev
```

Or with tsx directly:
```bash
npx tsx index.ts
```

### Build

```bash
npm run build
```

## Security

- Database passwords are automatically masked in terminal output
- SSL/TLS enabled by default for remote connections
- No credentials stored on disk
- Connection strings only kept in memory during operation

## Troubleshooting

### "pg_dump not found"

Install PostgreSQL client tools:
```bash
# macOS
brew install postgresql@17

# Ubuntu/Debian
sudo apt-get install postgresql-client-17
```

### Connection timeout

- Verify database URL is correct
- Check firewall settings
- For Supabase: ensure database is not paused
- Try using the pooler URL instead of direct connection

### Import warnings

`pg_restore` may show warnings during import - this is normal for clean restores where tables don't exist yet. The tool will verify the import succeeded by checking row counts.

### SSL/TLS errors

The tool automatically adds `sslmode=require` for dump operations and uses `{ rejectUnauthorized: false }` for connections to handle self-signed certificates.

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## Author

LeadsGen Tech

## Links

- GitHub: https://github.com/leadsgen-tech/db-manager
- Issues: https://github.com/leadsgen-tech/db-manager/issues

---

Built with ❤️ for database operators and DevOps teams
