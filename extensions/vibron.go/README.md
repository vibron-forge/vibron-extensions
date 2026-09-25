# Go tests for Vibron, with the Go installed on this machine

Language extension for [Vibron](https://github.com/vibron-forge/vibron)
([ADR 0005](https://github.com/vibron-forge/vibron/blob/staging/docs/adr/0005-linguagens-como-extensoes-opcionais.md)):
it declares how to detect a Go project and how to run its tests. It ships no
code and never downloads a Go toolchain; Vibron runs the `go` found on your
`PATH` and reads its `go test -json` stream with the core's `test2json`
reader. Like `go test` in your terminal, it may still fetch module
dependencies missing from your module cache; set `GOPROXY=off` in your
environment, or vendor them, to forbid that. The manifest
format is described in Vibron's
[`docs/extensions/language-contributions.md`](https://github.com/vibron-forge/vibron/blob/staging/docs/extensions/language-contributions.md).

## Requirements

- Go 1.21 or newer on `PATH` (`-fullpath` and `GOTOOLCHAIN` need it). Without
  Go, a run ends `crashed` and points to <https://go.dev/dl/>.
- A Vibron build with language contributions (M5.5.19). The extension must be
  installed from the catalog, enabled, and approved in Settings › Extensions,
  which shows the exact command before anything runs.

## What the test runner runs

```
GOFLAGS= GOTOOLCHAIN=local go test -json -count=1 -fullpath [your args] [-run <filter>]
```

| Part | Why |
| --- | --- |
| `-json` | The stream Vibron reads; `stdout` is the report. |
| `-count=1` | Always runs the tests; a cached result is not a new verdict. |
| `-fullpath` | Failures carry the whole path, so two packages with a `calc_test.go` are not confused. |
| `GOTOOLCHAIN=local` | Never downloads a newer Go: a `go.mod` that asks for one fails the run and says so. |
| `GOFLAGS=` (empty) | Your `GOFLAGS` cannot add `-run`, `-list` or `-json=false` behind the run's back. Pass build flags such as `-tags` as arguments instead. |

Pass the packages as arguments (`./...` for the whole module). The filter is
Go's `-run` regular expression.

## How runs end

| Situation | Vibron shows |
| --- | --- |
| A test fails | `failed`, with the failing line |
| A test panics | `failed`, pointing at the test's own frame |
| The package does not compile (or `go vet` fails) | `setup-failed`, with the compiler's line |
| The test binary dies mid-run (`-timeout`, `os.Exit`) | `crashed`, with what the test printed |
| You cancel | `cancelled`; the test binary is stopped too |
| No test ran (no test files, or the filter matched nothing) | `skipped`, never `passed` |

## Not included yet

- Autocompletion, errors and go to definition from `gopls`: a later version
  declares it once Vibron's language services (M5.5.21) land, and needs a new
  approval. Until then Go files show language services as unavailable. `gopls`
  is installed separately, with `go install golang.org/x/tools/gopls@latest`.
- Runs on remote workspaces (WSL/SSH): the runner executes on the local host.
