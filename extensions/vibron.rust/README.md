Runs Rust tests in Vibron with the Rust installed on this machine: a crate that does not compile, failing tests and ignored tests stay distinct. It never downloads a Rust toolchain.

# Rust tests for Vibron, with the Rust installed on this machine

Language extension for [Vibron](https://github.com/vibron-forge/vibron)
([ADR 0005](https://github.com/vibron-forge/vibron/blob/staging/docs/adr/0005-linguagens-como-extensoes-opcionais.md)):
it declares how to detect a Rust project and how to run its tests. It ships no
code and never downloads a Rust toolchain; Vibron runs the `cargo` found on your
`PATH` and reads libtest's JSON stream with the core's `libtest-json` reader.
Like `cargo test` in your terminal, Cargo may still fetch crates missing from
its cache; pass `--offline` as an argument, or vendor them, to forbid that. The
manifest format is described in Vibron's
[`docs/extensions/language-contributions.md`](https://github.com/vibron-forge/vibron/blob/staging/docs/extensions/language-contributions.md).

## Requirements

- Rust installed with rustup 1.28 or newer, with `cargo` on `PATH`. Without it,
  a run ends `crashed` and points to <https://www.rust-lang.org/tools/install>.
  Older rustup ignores `RUSTUP_AUTO_INSTALL` and installs a toolchain that the
  project pins (`rustup self update` updates it). On Windows, the MSVC
  toolchain also needs the Visual Studio C++ build tools.
- A Vibron build with language contributions (M5.5.19). The extension must be
  installed from the catalog, enabled, and approved in Settings › Extensions,
  which shows the exact command before anything runs.

## What the test runner runs

```
RUSTC_BOOTSTRAP=0 RUSTUP_AUTO_INSTALL=0 RUST_TEST_NOCAPTURE=0 cargo test --no-fail-fast [your args] [<filter>] -- -Z unstable-options --format json --report-time
```

| Part | Why |
| --- | --- |
| `--no-fail-fast` | Cargo keeps running the other test binaries after one fails. |
| `--format json` | libtest writes one JSON event per line; `stdout` is the report. |
| `-Z unstable-options`, `RUSTC_BOOTSTRAP=0` | `--format json` is unstable. libtest takes it when `RUSTC_BOOTSTRAP` is set, whatever its value; rustc and Cargo unlock unstable features only with `1` (rustc also with a crate's name). With `0`, your crates compile as in a plain `cargo test` (see below). |
| `RUSTUP_AUTO_INSTALL=0` | A `rust-toolchain.toml` that pins a toolchain you have not installed fails the run with rustup's `toolchain '…' is not installed`, instead of rustup downloading it. |
| `RUST_TEST_NOCAPTURE=0` | Output stays captured even if your environment sets `RUST_TEST_NOCAPTURE=1`, which would leave a failure without its message and `file:line`. |
| `--report-time` | Each test carries its duration. |

Pass Cargo's own selection as arguments (`--workspace`, `--package <name>`,
`--lib`, `--test <name>`, `--doc`), never `--`: everything after `--` belongs to
the report.

The filter is libtest's substring match on the test name, in every test binary,
so a test's full name does not select that test alone:

- it also runs every test whose name contains it (`tests::adds` runs
  `tests::adds_twice` too) and the tests with the same name in other targets;
- it never selects a doctest: with a name filter, Cargo runs no doctest, so
  the run runs no test and Vibron reports it `skipped`. To repeat a doctest,
  pass `--doc` with its name as the filter.

That is why Vibron's Runs panel offers no "Rerun this test" for these runs;
"Run again" repeats the whole run.

### `RUSTC_BOOTSTRAP` and your build

`proc-macro2`, `anyhow` and `thiserror`, which most projects depend on, read
`RUSTC_BOOTSTRAP` in their build scripts. Measured with Cargo 1.98.1, with a
path dependency whose build script has the same logic:

- With `1`, that build script turned its nightly code on, and a test that passes
  in the terminal failed in the run; `#![feature(...)]`, `cargo-features` and
  Cargo's `-Z` flags were also accepted. With `0`, the run compiled the same
  code as the terminal and refused all three, as stable does.
- Such build scripts ask Cargo to rebuild them when `RUSTC_BOOTSTRAP` changes.
  In the same `target/`, every switch between a Vibron run and a terminal
  `cargo test`, or rust-analyzer's `cargo check`, reruns them and recompiles
  those crates and everything that depends on them (`proc-macro2` →
  `quote`/`syn` → each derive). Passing `--target-dir target/vibron` keeps the
  run's build apart, at the cost of a second build.
- libtest checks only that the variable is set (Rust 1.98 and its main branch
  today). If a later libtest checks the value, it refuses `-Z` and runs end
  `crashed` with "the option `Z` is only accepted on the nightly compiler" in
  the log.
- On a nightly toolchain, `0` changes nothing: nightly takes `--format json`
  and features on its own.

## How runs end

| Situation | Vibron shows |
| --- | --- |
| A test fails | `failed`, with the panic message and its `file:line` |
| A test is `#[ignore]`d | `skipped`, never `passed` |
| The crate does not compile | `crashed`, with no test listed, unknown counts, Cargo's exit code (101) and the compiler errors in the log |
| The project pins a toolchain that is not installed | `crashed`, with rustup's `is not installed` in the log; nothing is downloaded |

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
