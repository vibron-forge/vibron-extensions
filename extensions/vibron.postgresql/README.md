# A private PostgreSQL for each project, run with the PostgreSQL installed on your computer.

Declares a `contributes.services` entry. The extension ships no code and no
binaries: Vibron runs the PostgreSQL you installed.

Needs a Vibron build that includes project services (M5.5.16,
vibron-forge/vibron#212), which is built on the extension contract of M5.5.19
(#231). A build with M5.5.19 alone does not know `contributes.services`: it
lists this extension as refused (invalid manifest) and runs nothing.

## What you need

A supported PostgreSQL (14 or newer; verified with 18.6) whose `postgres`,
`initdb`, `pg_isready` and `pg_ctl` are on your `PATH`. Get it from
<https://www.postgresql.org/download/>. The Windows installer does not add its
`bin` folder to `PATH` (for example `C:\Program Files\PostgreSQL\18\bin`); add
it yourself. Without PostgreSQL, Vibron says so and points here — it never
downloads anything.

## What Vibron does with it

- One instance per project folder, with its data in Vibron's user data folder,
  not in the project; every workspace that opens the folder uses the same one,
  and a server left running by an earlier session is found again, never started
  twice on the same data.
- The first start runs `initdb` with a random password Vibron generates and keeps
  encrypted (Electron `safeStorage`); the password reaches PostgreSQL through a
  private file that exists only while `initdb` runs, never through a command
  line.
- `postgres` listens only on `127.0.0.1`, on a free port Vibron chooses and keeps
  for the next start. A server that listens anywhere else is stopped and
  refused.
- Ready means Vibron's own `postgres` process holds that port and `pg_isready`
  answers. Stop runs `pg_ctl stop -m fast`, and so does quitting Vibron; the
  data stays.
- A process started with `services: ["postgresql"]` receives `DATABASE_URL`
  and the libpq variables `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and
  `PGDATABASE`, so `psql`, `pg_dump` and most drivers connect with no
  arguments; everywhere else the password shows as `[redacted]`.

Every command above is shown in Settings › Extensions and runs only after you
approve this exact version.
