// Builds what this extension ships next to manifest.json (build.sh packs
// manifest.json + dist/): the Maven core extension jar, compiled from maven/
// against the Maven API of the installed Maven, and the Gradle init script.
// Needs a JDK 17+ (javac, jar) and Maven 3.9 on PATH (or MAVEN_HOME).
// For a given javac the jar is byte-for-byte reproducible: sorted entries, no
// manifest, fixed entry dates, resources with LF line endings whatever the
// checkout.
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'dist')
const ENTRY_DATE = '1980-01-01T00:00:02Z'

function mavenLib() {
  let home = process.env.MAVEN_HOME
  if (!home) {
    const version = execSync('mvn --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    home = /^Maven home: (.+)$/m.exec(version)?.[1]?.trim()
  }
  const lib = home && join(home, 'lib')
  if (!lib || !existsSync(lib)) {
    throw new Error('vibron.java: no Maven installation found; put mvn on PATH or set MAVEN_HOME')
  }
  return lib
}

function files(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory()
      ? files(root, join(dir, entry.name))
      : [relative(root, join(dir, entry.name)).split(sep).join('/')]))
    .sort()
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(join(dist, 'maven'), { recursive: true })
mkdirSync(join(dist, 'gradle'), { recursive: true })

const lib = mavenLib()
const work = mkdtempSync(join(tmpdir(), 'vibron-java-'))
try {
  const classes = join(work, 'classes')
  const sources = files(join(here, 'maven', 'src')).map((file) => join(here, 'maven', 'src', file))
  // --release 8: Maven 3.9 itself runs on Java 8.
  execFileSync('javac', ['--release', '8', '-Xlint:-options', '-proc:none', '-encoding', 'UTF-8',
    '-cp', join(lib, '*'), '-d', classes, ...sources], { stdio: 'inherit' })
  for (const file of files(join(here, 'maven', 'resources'))) {
    const target = join(classes, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(here, 'maven', 'resources', file), 'utf8').replace(/\r\n/g, '\n'))
  }
  execFileSync('jar', ['--create', '--file', join(dist, 'maven', 'vibron-surefire-reports.jar'),
    '--no-manifest', `--date=${ENTRY_DATE}`, ...files(classes).flatMap((entry) => ['-C', classes, entry])],
  { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
copyFileSync(join(here, 'gradle', 'vibron.init.gradle'), join(dist, 'gradle', 'vibron.init.gradle'))
console.log('vibron.java: built dist/maven/vibron-surefire-reports.jar and dist/gradle/vibron.init.gradle')
