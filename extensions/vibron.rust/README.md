Runs Rust tests in Vibron with the Rust installed on this machine: a crate that does not compile, failing tests and ignored tests stay distinct, and nothing is downloaded.

# Rust tests for Vibron, with the Rust installed on this machine

Language extension for [Vibron](https://github.com/vibron-forge/vibron)
([ADR 0005](https://github.com/vibron-forge/vibron/blob/staging/docs/adr/0005-linguagens-como-extensoes-opcionais.md)):
it declares how to detect a Rust project and how to run its tests. It ships no
code and downloads nothing; Vibron runs the `cargo` found on your `PATH` and
reads libtest's JSON stream with the core's `libtest-json` reader. The manifest
format is described in Vibron's
[`docs/extensions/language-contributions.md`](https://github.com/vibron-forge/vibron/blob/staging/docs/extensions/language-contributions.md).

## Requirements

- Rust installed with rustup, with `cargo` on `PATH`. Without it, a run ends
  `crashed` and points to <https://www.rust-lang.org/tools/install>. On
  Windows, the MSVC toolchain also needs the Visual Studio C++ build tools.
- A Vibron build with language contributions (M5.5.19). The extension must be
  installed from the catalog, enabled, and approved in Settings › Extensions,
  which shows the exact command before anything runs.

## What the test runner runs

```
RUSTC_BOOTSTRAP=1 cargo test --no-fail-fast [your args] [<filter>] -- -Z unstable-options --format json --report-time
```

| Part | Why |
| --- | --- |
| `--no-fail-fast` | Cargo keeps running the other test binaries after one fails. |
| `--format json` | libtest writes one JSON event per line; `stdout` is the report. |
| `-Z unstable-options`, `RUSTC_BOOTSTRAP=1` | `--format json` is unstable, so the stable toolchain needs both. |
| `--report-time` | Each test carries its duration. |

Pass Cargo's own selection as arguments (`--workspace`, `--package <name>`,
`--lib`, `--test <name>`), never `--`: everything after `--` belongs to the
report. The filter is libtest's substring match on the test name.

`RUSTC_BOOTSTRAP=1` also reaches the compiler during the run: a crate that uses
`#![feature(...)]` compiles there, although a plain `cargo test` on stable
refuses it.

## How runs end

| Situation | Vibron shows |
| --- | --- |
| A test fails | `failed`, with the panic message and its `file:line` |
| A test is `#[ignore]`d | `skipped`, never `passed` |
| The crate does not compile | `crashed`, with no test listed, unknown counts, Cargo's exit code (101) and the compiler errors in the log |

## Not included yet

- Autocompletion, errors and go to definition from rust-analyzer (Vibron M5.5.21).
- Runs on remote workspaces (WSL/SSH): the runner executes on the local host.
- The test binary's name: `cargo test` does not write it in the stream, so two
  tests with the same name in different targets are told apart by suite order
  (`rust/suite-3/<test>`). cargo-nextest's libtest JSON names the target, but
  nextest 0.9.146 reports an `#[ignore]`d test only as started and the core
  refuses that stream, so this extension runs `cargo test` (see the guide's
  Cargo section).
- Targets with `harness = false` that do not write libtest JSON are not listed.
