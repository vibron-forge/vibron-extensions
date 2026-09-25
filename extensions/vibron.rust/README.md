Rust for Vibron: runs cargo test with the Rust installed on your machine and shows each test as passed, failed or ignored, with a crate that does not compile reported apart from failing tests.

# Rust (vibron.rust)

A language-only extension: no panel, no server, nothing downloaded. Its
`manifest.json` declares, under `contributes.languages`, how Vibron recognises a
Rust project and runs its tests. Vibron's core has no Rust code of its own
([ADR 0005](https://github.com/vibron-forge/vibron/blob/staging/docs/adr/0005-linguagens-como-extensoes-opcionais.md));
the manifest fields are described in the core's guide,
[`docs/extensions/language-contributions.md`](https://github.com/vibron-forge/vibron/blob/staging/docs/extensions/language-contributions.md).

## What it declares

- **Detection:** `.rs` files and the `Cargo.toml` marker, which is also when
  Vibron may recommend the extension (`file-open`, `project-open`).
- **Toolchain:** `cargo --version`. When Cargo is missing, Vibron points to
  <https://www.rust-lang.org/tools/install>; the extension installs nothing.
- **Test runner:** Cargo's own test command, with libtest writing JSON events
  to stdout for the core's `libtest-json` reader:

  ```
  RUSTC_BOOTSTRAP=1 cargo test --no-fail-fast [your arguments] [filter] -- -Z unstable-options --format json --report-time
  ```

  `--no-fail-fast` keeps Cargo going after the first failing test binary.

## What a run reports

- Each test is `passed`, `failed` (with the panic message and its `file:line`)
  or `skipped` for `#[ignore]`.
- A crate that does not compile writes no report: the run ends `crashed`, with
  unknown counts, Cargo's exit code (101) and the compiler errors in its log.
  It is never shown as a run with zero failures.

## Before approving

A contribution only runs after you approve its exact commands in
Settings › Extensions, and a new version asks again. Things to know:

- libtest's `--format json` is unstable, so on the stable toolchain it needs
  `RUSTC_BOOTSTRAP=1`. The variable reaches the compiler during that run too:
  a crate using `#![feature(...)]` compiles there even though a plain
  `cargo test` on stable refuses it.
- Rust is installed with rustup; `cargo` must be on your `PATH`. On Windows the
  MSVC toolchain also needs the Visual Studio C++ build tools (the linker).

## Limits

- `cargo test` does not name the test binary in its JSON stream, so two tests
  with the same name in different targets are told apart by suite order
  (`rust/suite-3/<test>`), not by target.
- Everything after `--` belongs to the report: do not pass `--` in your own
  arguments. The filter is libtest's substring match.
- Doc-tests run as a suite of their own. A target with `harness = false` that
  does not write libtest JSON is not reported.
- No language server is declared yet.
