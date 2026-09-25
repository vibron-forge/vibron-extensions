package vibron.maven;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.Transformer;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.apache.maven.execution.BuildFailure;
import org.apache.maven.execution.BuildSummary;
import org.apache.maven.execution.MavenExecutionResult;
import org.apache.maven.project.MavenProject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * Puts what kept tests from running into the shape JUnit XML gives a suite that failed outside any
 * test: a {@code <failure>} or {@code <error>} directly under {@code <testsuite>}, which Vibron
 * reads as a suite failure ({@code setup-failed}) rather than as a failed test.
 */
final class SuiteFailures {
    /** Surefire's case for a test class that failed before any of its tests ran, such as a
     *  throwing {@code @BeforeAll}/{@code @BeforeClass} (the JUnit 4 name, kept for the JUnit
     *  Platform). Surefire 3.5 and older write the JUnit 4 one with an empty name instead. */
    private static final String CLASS_SETUP = "initializationError";
    private static final int MAX_CAUSES = 16;

    private SuiteFailures() {
    }

    static void report(File dir, MavenExecutionResult result) throws Exception {
        File[] reports = dir.listFiles();
        if (reports != null) {
            Arrays.sort(reports);
            for (File report : reports) {
                if (report.isFile() && report.getName().endsWith(".xml")) {
                    liftClassSetupFailure(report);
                }
            }
        }
        // The module of each failure, as the reactor summary records it: a plugin that does not
        // resolve fails its module without a LifecycleExecutionException naming that module.
        Map<Throwable, MavenProject> modules = new IdentityHashMap<Throwable, MavenProject>();
        for (MavenProject project : result.getTopologicallySortedProjects()) {
            BuildSummary summary = result.getBuildSummary(project);
            if (summary instanceof BuildFailure) {
                modules.put(((BuildFailure) summary).getCause(), project);
            }
        }
        // Vibron refuses a report that names the same suite twice.
        Set<String> suites = new HashSet<String>();
        int written = 0;
        for (Throwable exception : result.getExceptions()) {
            MavenProject project = modules.get(exception);
            if (project != null && SurefireTestGoals.started(project)) {
                continue;
            }
            // No module: Maven stopped before its reactor existed.
            String name = project == null ? "maven" : project.getGroupId() + ":" + project.getArtifactId();
            String suite = name;
            for (int n = 2; !suites.add(suite); n++) {
                suite = name + "-" + n;
            }
            written++;
            writeBuildFailure(new File(dir, "TEST-vibron-setup-" + written + ".xml"), suite, exception);
        }
    }

    /** A report whose only case is the class-setup case becomes that class's suite failure. */
    private static void liftClassSetupFailure(File report) throws Exception {
        Document document = parse(report);
        Element suite = document.getDocumentElement();
        if (!"testsuite".equals(suite.getTagName())) {
            return;
        }
        List<Element> cases = children(suite, "testcase");
        String name = cases.size() == 1 ? cases.get(0).getAttribute("name") : null;
        if (name == null || !(CLASS_SETUP.equals(name) || name.isEmpty())) {
            return;
        }
        Element testCase = cases.get(0);
        List<Element> parts = children(testCase, null);
        boolean failed = false;
        for (Element part : parts) {
            String tag = part.getTagName();
            if (tag.equals("failure") || tag.equals("error")) {
                failed = true;
            } else if (!tag.equals("system-out") && !tag.equals("system-err")) {
                return;
            }
        }
        if (!failed) {
            return;
        }
        for (Element part : parts) {
            suite.insertBefore(part, testCase);
        }
        suite.removeChild(testCase);
        write(document, report);
    }

    private static void writeBuildFailure(File target, String name, Throwable exception) throws Exception {
        Document document = DocumentBuilderFactory.newInstance().newDocumentBuilder().newDocument();
        Element suite = document.createElement("testsuite");
        suite.setAttribute("name", name);
        suite.setAttribute("tests", "1");
        suite.setAttribute("errors", "1");
        suite.setAttribute("failures", "0");
        suite.setAttribute("skipped", "0");
        String text = describe(exception);
        Element error = document.createElement("error");
        error.setAttribute("message", text.split("\r?\n", 2)[0].trim());
        error.setAttribute("type", rootCause(exception).getClass().getName());
        error.appendChild(document.createTextNode(text));
        suite.appendChild(error);
        document.appendChild(suite);
        write(document, target);
    }

    /** The exception's message followed by those of its causes it does not already carry, joined
     *  with ": " as Maven prints them. */
    private static String describe(Throwable exception) {
        StringBuilder text = new StringBuilder(message(exception));
        Throwable cause = exception.getCause();
        for (int depth = 0; cause != null && depth < MAX_CAUSES; depth++, cause = cause.getCause()) {
            String message = message(cause);
            if (text.indexOf(message) < 0) {
                text.append(": ").append(message);
            }
        }
        return xmlText(text.toString().replace("\r\n", "\n"));
    }

    private static String message(Throwable exception) {
        return exception.getMessage() == null ? exception.getClass().getName() : exception.getMessage();
    }

    private static Throwable rootCause(Throwable exception) {
        Throwable root = exception;
        for (int depth = 0; root.getCause() != null && depth < MAX_CAUSES; depth++) {
            root = root.getCause();
        }
        return root;
    }

    /** XML 1.0 cannot carry every character a message may hold; the rest become '?'. */
    private static String xmlText(String text) {
        StringBuilder out = new StringBuilder(text.length());
        for (int at = 0; at < text.length(); ) {
            int point = text.codePointAt(at);
            boolean allowed = point == 0x9 || point == 0xA || point == 0xD
                    || (point >= 0x20 && point <= 0xD7FF) || (point >= 0xE000 && point <= 0xFFFD)
                    || (point >= 0x10000 && point <= 0x10FFFF);
            out.appendCodePoint(allowed ? point : '?');
            at += Character.charCount(point);
        }
        return out.toString();
    }

    private static List<Element> children(Element parent, String tag) {
        List<Element> found = new ArrayList<Element>();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element && (tag == null || tag.equals(((Element) node).getTagName()))) {
                found.add((Element) node);
            }
        }
        return found;
    }

    private static Document parse(File file) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        return factory.newDocumentBuilder().parse(file);
    }

    /** Written next to the target and moved over it, so a failed write never leaves half a report. */
    private static void write(Document document, File target) throws Exception {
        Transformer transformer = TransformerFactory.newInstance().newTransformer();
        transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
        File partial = new File(target.getParentFile(), target.getName() + ".partial");
        OutputStream out = new FileOutputStream(partial);
        try {
            transformer.transform(new DOMSource(document), new StreamResult(out));
        } finally {
            out.close();
        }
        Files.move(partial.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }
}
