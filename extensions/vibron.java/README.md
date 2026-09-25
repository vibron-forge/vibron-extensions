# Maven and Gradle tests for Vibron, with the Java installed on this machine

Language extension for [Vibron](https://github.com/vibron-forge/vibron)
([ADR 0005](https://github.com/vibron-forge/vibron/blob/staging/docs/adr/0005-linguagens-como-extensoes-opcionais.md)):
it declares how to detect a Maven or Gradle project and how to run its tests.
It downloads nothing; Vibron runs the `mvn` or `gradle` found on your `PATH` and
reads the JUnit XML reports with the core's `junit-xml` reader. The manifest
format is described in Vibron's
[`docs/extensions/language-contributions.md`](https://github.com/vibron-forge/vibron/blob/staging/docs/extensions/language-contributions.md).

One language, `java`, detected by any of the marker files below, with one test
runner per build tool:

| Test runner | Chosen when the run's folder has |
| --- | --- |
| `maven` | `pom.xml` |
| `gradle` | `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts` |

A run uses the runner its caller names (`"runner": "gradle"`) or else the first
one, in this order, whose marker file is in the run's folder; with neither,
Vibron refuses the run and lists the markers it looked for.

## Requirements

- A JDK and Maven 3.9 (for `maven`) or Gradle 8 (for `gradle`) on
  `PATH`. The wrappers (`./mvnw`, `./gradlew`) are paths, which a contributed
  command cannot be. Without the command, a run ends `crashed` and points to
  <https://adoptium.net/>: the Eclipse Foundation's vendor-neutral OpenJDK
  download, with TCK-certified Temurin builds of every LTS for every major OS
  (java.com serves Oracle's end-user Java 8 runtime, not a development kit).
- A Vibron build with language contributions (M5.5.19). The extension must be
  installed from a trusted catalog (the official one is trusted by default;
  another is trusted in Settings › Extensions, never a plain `http://` one),
  enabled, and approved in Settings › Extensions, which shows the catalog, the
  artifact's sha256 and the exact commands before anything runs.

## What the test runners run

```
mvn test --batch-mode -Dmaven.ext.class.path=<extension>/dist/maven/vibron-surefire-reports.jar [your args] [-Dtest=<filter>] -Dvibron.reportsDirectory=<run directory>
gradle test --init-script <extension>/dist/gradle/vibron.init.gradle [your args] [--tests <filter>] -Pvibron.reportsDirectory=<run directory>
```

| Part | Why |
| --- | --- |
| `vibron-surefire-reports.jar` | A Maven core extension. Surefire has no command-line property for its `reportsDirectory`, so it points the plugin and each of its executions at `vibron.reportsDirectory`. When the session ends it writes what kept tests from running in the shape JUnit XML gives a suite that failed outside any test (a `<failure>`/`<error>` directly under `<testsuite>`). Without `vibron.reportsDirectory` it does nothing, and it never changes the build's outcome. |
| `vibron.init.gradle` | Points the JUnit XML of each `Test` task at its own folder under `vibron.reportsDirectory` (`test`, `integrationTest`, `app.test`…): Gradle deletes the `TEST*.xml` of its output folder before writing, so in a shared folder one task erased the others' reports. Writes a rerun (the `test-retry` plugin) into the same case (`mergeReruns`), which Vibron counts as an attempt. Makes the task never up to date and never restored from the build cache, so every run is a new verdict (with `--build-cache` or `org.gradle.caching=true`, a run replayed `:test FROM-CACHE` without running the tests). |
| `<run directory>` | Created empty by Vibron for each run, so a run reads only its own reports. |
| `--batch-mode` | No prompts and no colour codes in the log. |

The filter is Surefire's `-Dtest` (`Class`, `Class#method`) or Gradle's
`--tests` (`demo.CalculatorTest`).

## How runs end

| Situation | Vibron shows |
| --- | --- |
| A test fails | `failed`, at the test's own line |
| A test class's setup fails (a throwing `@BeforeAll`/`@BeforeClass`) under Maven | `setup-failed`: Surefire reports it as the class's only case, `initializationError` (or, before Surefire 3.6, a case with an empty name for JUnit 4), which the Maven core extension turns into a suite failure |
| A test class's setup fails under Gradle | `setup-failed`: Gradle writes the class as a case named `initializationError` (JUnit Platform) or `classMethod` (JUnit 4), which Vibron's JUnit XML reader reads as the class |
| Maven fails before Surefire runs (test sources that do not compile, a dependency that does not resolve) | `setup-failed`, with Maven's message, written as `TEST-vibron-setup-<n>.xml` |
| The Gradle test worker dies (`System.exit`, a JVM crash) | `crashed` with unknown counts: Gradle writes no XML |
| No report at all (no tests, or the filter matched nothing) | `crashed`, never `passed` |

## Build

`npm run build` (run by the catalog's `./build.sh`) needs a JDK 17+ (`javac`,
`jar`) and Maven 3.9 on `PATH` (or `MAVEN_HOME`). It compiles `maven/src` with
`--release 8` (Maven 3.9 runs on Java 8) against the Maven API of that
installation, adds the Sisu index from `maven/resources`, and copies the init
script; `dist/` is what ships. For a given `javac` the jar is byte-for-byte
reproducible (sorted entries, no manifest, fixed entry dates). No binary is
committed.

## Not included yet

- Autocompletion, errors and go to definition from a Java language server
  (Vibron M5.5.21). On Windows, Eclipse JDT LS (`jdtls`) starts from
  `jdtls.bat` or a Python script, and the language server of a contribution is
  a bare executable started without a shell. A server comes in a later version,
  verified against the M5.5.21 that is integrated, with a new approval.
- Runs on remote workspaces (WSL/SSH): the runner executes on the local host.
- A multi-module Maven build writes every module's reports into one directory,
  so two modules with a test class of the same name overwrite each other's
  report.
- A Surefire fork that dies after some classes finished leaves their reports,
  so that run ends `failed` rather than `crashed`.
- The contract carries one official site per language, so a missing `mvn` or
  `gradle` also points to the Java download rather than to maven.apache.org or
  gradle.org.
