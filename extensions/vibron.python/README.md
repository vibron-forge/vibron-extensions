# Python tests for Vibron, with the Python installed on this machine

Language extension for [Vibron](https://github.com/vibron-forge/vibron)
([ADR 0005](https://github.com/vibron-forge/vibron/blob/staging/docs/adr/0005-linguagens-como-extensoes-opcionais.md)):
it declares how to detect a Python project and how to run its tests with
pytest. It downloads nothing; Vibron runs the `pytest` found on your `PATH` and
reads the JUnit XML report pytest writes with the core's `junit-xml` reader.
The only code it ships is a small pytest plugin, `python/vibron_pytest.py`. The
manifest format is described in Vibron's
[`docs/extensions/language-contributions.md`](https://github.com/vibron-forge/vibron/blob/staging/docs/extensions/language-contributions.md).

## Requirements

- Python 3 with pytest 7 or newer, and `pytest` on `PATH` (for example
  `python -m pip install pytest` in the environment you test with). The tests
  run with the Python that `pytest` belongs to. Without `pytest`, a run ends
  `crashed` and points to <https://www.python.org/downloads/>.
- A Vibron build with language contributions (M5.5.19). The extension must come
  from a trusted catalog (the official one, or a source marked trusted in
  Settings › Extensions), be installed, enabled, and approved in Settings ›
  Extensions, which shows the catalog, the artifact's sha256 and the exact
  command before anything runs.

## What the test runner runs

```
PYTHONPATH=<extension>/python PYTEST_ADDOPTS="" PYTHONDONTWRITEBYTECODE=1 PY_COLORS=0 pytest -p vibron_pytest -p no:cacheprovider -o junit_family=xunit2 [your args] [-k <filter>] --junitxml=<run report>
```

| Part | Why |
| --- | --- |
| `--junitxml`, `-o junit_family=xunit2` | The report Vibron reads, in a file the run owns. `legacy`/`xunit1` count lines from zero. |
| `-p vibron_pytest` | Adds each test's file to the report (`xunit2` leaves it out), so a case keeps its file in its id and opens in the editor, and lets `-k` select one exact test (below). |
| `-p no:cacheprovider` | No `.pytest_cache` is written into your project. |
| `PYTHONDONTWRITEBYTECODE=1` | No `__pycache__` in your project or in the installed extension. |
| `PY_COLORS=0` | Plain text even when `FORCE_COLOR` or `PY_COLORS=1` is set: pytest otherwise writes color codes into the report's failure text, which hides the failing line. |
| `PYTEST_ADDOPTS=` (empty) | Your `PYTEST_ADDOPTS` cannot change the report or the selection behind the run's back. Keep options in `pytest.ini`/`pyproject.toml` or pass them as arguments. |

Pass paths or node ids as arguments (`tests`, `tests/test_calc.py::test_add`).
The filter is a pytest `-k` expression (`test_add`, `TestCalc and not slow`),
the tool's own syntax as Vibron's contract defines it. When the filter is
exactly one test's node id (`tests/test_calc.py::TestAdd::test_same[a&b]`) or
its name as Vibron shows it (`tests.test_calc.TestAdd.test_same[a&b]`), the
plugin runs that test alone: pytest's own `-k` would match nothing for such a
value, or reject it for its `&`, spaces or brackets.

## How runs end

| Situation | Vibron shows |
| --- | --- |
| Every selected test passes | `passed` |
| A test fails, or errors in a fixture | `failed`, with the failing line |
| Every selected test is skipped | `skipped`, never `passed` |
| The filter or the arguments select no test (pytest exits 5) | `failed`, 0 tests |
| The interpreter dies mid-run (`os._exit`, a crash) and writes no report | `crashed`, counts unknown |
| You cancel | `cancelled` |

## Not included yet

- Autocompletion, errors and go to definition from a Python language server
  (Vibron M5.5.21).
- Runs on remote workspaces (WSL/SSH): the runner executes on the local host.
- A "Rerun this test" button: the Test runs panel does not offer it for
  extension runs yet; an agent can pass the case's name as the filter.
- A run replaces `PYTHONPATH` with the plugin folder, because the contract
  replaces whole variables. Set import paths with pytest's `pythonpath` option
  in `pytest.ini`/`pyproject.toml` instead.
