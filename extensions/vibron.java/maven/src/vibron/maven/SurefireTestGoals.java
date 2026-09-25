package vibron.maven;

import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import javax.inject.Named;
import javax.inject.Singleton;
import org.apache.maven.execution.MojoExecutionEvent;
import org.apache.maven.execution.MojoExecutionListener;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.project.MavenProject;

/**
 * Remembers the projects whose Surefire test goal started, so that a build failure before it (a
 * test that does not compile, a dependency that does not resolve) is told apart from a failure
 * Surefire reported itself. Reset when a session starts.
 */
@Named("vibron-surefire-test-goals")
@Singleton
public class SurefireTestGoals implements MojoExecutionListener {
    private static final Set<String> STARTED = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    static void reset() {
        STARTED.clear();
    }

    static boolean started(MavenProject project) {
        return STARTED.contains(project.getId());
    }

    @Override
    public void beforeMojoExecution(MojoExecutionEvent event) {
        MojoExecution execution = event.getExecution();
        if ("org.apache.maven.plugins".equals(execution.getGroupId())
                && "maven-surefire-plugin".equals(execution.getArtifactId())
                && "test".equals(execution.getGoal())) {
            STARTED.add(event.getProject().getId());
        }
    }

    @Override
    public void afterMojoExecutionSuccess(MojoExecutionEvent event) {
    }

    @Override
    public void afterExecutionFailure(MojoExecutionEvent event) {
    }
}
