package vibron.maven;

import java.io.File;
import javax.inject.Named;
import javax.inject.Singleton;
import org.apache.maven.AbstractMavenLifecycleParticipant;
import org.apache.maven.execution.MavenSession;
import org.apache.maven.model.Plugin;
import org.apache.maven.model.PluginExecution;
import org.apache.maven.project.MavenProject;
import org.codehaus.plexus.util.xml.Xpp3Dom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Maven core extension that the vibron.java extension loads with {@code -Dmaven.ext.class.path}
 * when Vibron runs {@code mvn test}. It acts only when {@code -Dvibron.reportsDirectory} names the
 * run's report directory. Surefire has no command-line property for its reportsDirectory, so this
 * points the plugin and its executions there; when the session ends it reports the test classes
 * whose setup failed and the builds that failed before Surefire ran, in the JUnit XML shape Vibron
 * reads as a suite failure (see {@link SuiteFailures}).
 */
@Named("vibron-surefire-reports")
@Singleton
public class SurefireReportsDirectory extends AbstractMavenLifecycleParticipant {
    static final String PROPERTY = "vibron.reportsDirectory";
    private static final String SUREFIRE = "org.apache.maven.plugins:maven-surefire-plugin";
    private static final Logger LOG = LoggerFactory.getLogger(SurefireReportsDirectory.class);

    @Override
    public void afterSessionStart(MavenSession session) {
        SurefireTestGoals.reset();
    }

    @Override
    public void afterProjectsRead(MavenSession session) {
        String dir = reportsDirectory(session);
        if (dir == null) {
            return;
        }
        for (MavenProject project : session.getProjects()) {
            Plugin surefire = project.getPlugin(SUREFIRE);
            if (surefire == null) {
                continue;
            }
            surefire.setConfiguration(withReportsDirectory(surefire.getConfiguration(), dir));
            for (PluginExecution execution : surefire.getExecutions()) {
                execution.setConfiguration(withReportsDirectory(execution.getConfiguration(), dir));
            }
        }
    }

    @Override
    public void afterSessionEnd(MavenSession session) {
        String dir = reportsDirectory(session);
        if (dir == null) {
            return;
        }
        try {
            SuiteFailures.report(new File(dir), session.getResult().getExceptions());
        } catch (Exception e) {
            // Never change the build's outcome: Vibron still reads what Surefire wrote.
            LOG.warn("vibron: could not report suite failures in {}: {}", dir, e.toString());
        }
    }

    private static String reportsDirectory(MavenSession session) {
        String dir = session.getUserProperties().getProperty(PROPERTY);
        return dir == null || dir.isEmpty() ? null : dir;
    }

    private static Xpp3Dom withReportsDirectory(Object configuration, String dir) {
        Xpp3Dom dom = configuration instanceof Xpp3Dom ? (Xpp3Dom) configuration : new Xpp3Dom("configuration");
        Xpp3Dom child = dom.getChild("reportsDirectory");
        if (child == null) {
            child = new Xpp3Dom("reportsDirectory");
            dom.addChild(child);
        }
        child.setValue(dir);
        return dom;
    }
}
