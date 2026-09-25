# A private Redis for each project, run with the Redis installed on your computer.

Declares a `contributes.services` entry (Vibron M5.5.16). The extension ships no
code and no binaries: Vibron runs the Redis you installed.

## What you need

Redis 6 or newer (verified with 8.10.1) whose `redis-server` and `redis-cli` are
on your `PATH`. Get it from <https://redis.io/downloads/> or your package
manager (`brew install redis`, `apt install redis-server`). Redis publishes no
Windows build: on Windows this extension runs whatever compatible
`redis-server`/`redis-cli` your `PATH` finds (it was verified with the msys2
community build of Redis 8.10.1). Without Redis, Vibron says so and points
here — it never downloads anything.

## What Vibron does with it

- One instance per project, with its data (append-only file) in Vibron's user
  data folder, not in the project.
- A random password Vibron generates and keeps encrypted (Electron
  `safeStorage`) reaches Redis as `requirepass` in a private configuration file
  that exists only until the server is ready; `redis-cli` authenticates through
  `REDISCLI_AUTH` in its environment. The password never appears on a command
  line.
- `redis-server` listens only on `127.0.0.1`, with `protected-mode` on, on a free
  port Vibron chooses and keeps for the next start. A server that listens
  anywhere else is stopped and refused.
- Ready means Vibron's own `redis-server` holds that port and an authenticated
  `PING` answers. Stop sends `SHUTDOWN`, which flushes the append-only file; the
  data stays.
- A process started with `services: ["redis"]` receives `REDIS_URL`,
  `REDIS_HOST`, `REDIS_PORT` and `REDISCLI_AUTH` (so `redis-cli -p $REDIS_PORT`
  authenticates on its own); everywhere else the password shows as
  `[redacted]`.

Every command above is shown in Settings › Extensions and runs only after you
approve this exact version.
