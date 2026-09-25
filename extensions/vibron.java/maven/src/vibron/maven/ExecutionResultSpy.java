package vibron.maven;

import java.io.File;
import javax.inject.Named;
import javax.inject.Singleton;
import org.apache.maven.eventspy.AbstractEventSpy;
import org.apache.maven.execution.MavenExecutionRequest;
import org.apache.maven.execution.MavenExecutionResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Reports what kept tests from running once Maven has its result (see {@link SuiteFailures}). An
 * event spy rather than a lifecycle participant's afterSessionEnd: Maven hands its result to the
 * spies also when it stops before the reactor exists (a POM that does not parse, a parent that
 * does not resolve, a {@code -pl} that names no module), and afterSessionEnd is not called then.
 */
@Named("vibron-execution-result")
@Singleton
public class ExecutionResultSpy extends AbstractEventSpy {
    private static final Logger LOG = LoggerFactory.getLogger(ExecutionResultSpy.class);
    private String dir;

    @Override
    public void onEvent(Object event) {
        if (event instanceof MavenExecutionRequest) {
            dir = SurefireReportsDirectory.reportsDirectory(((MavenExecutionRequest) event).getUserProperties());
        } else if (event instanceof MavenExecutionResult && dir != null) {
            try {
                SuiteFailures.report(new File(dir), (MavenExecutionResult) event);
            } catch (Exception e) {
                // Never change the build's outcome: Vibron still reads what Surefire wrote.
                LOG.warn("vibron: could not report suite failures in {}: {}", dir, e.toString());
            }
        }
    }
}
