"""pytest plugin of the vibron.python extension.

Vibron's test runner loads it with ``-p vibron_pytest`` from the extension
folder that ``PYTHONPATH`` names (see manifest.json). It adds a ``file``
attribute to every ``<testcase>`` of the ``--junitxml`` report: the file the
test was collected from, relative to the folder pytest started in.
``junit_family=xunit2`` writes no file, and ``xunit1`` counts lines from zero,
so without this a case would lose its file.
"""

import os
import sys
import xml.etree.ElementTree as ET

import pytest

FILE_PROPERTY = "vibron.file"


def collected_file(item):
    path = str(item.path)
    try:
        path = os.path.relpath(path, item.config.invocation_params.dir)
    except ValueError:  # another drive than the folder pytest started in
        pass
    return path.replace(os.sep, "/")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    outcome.get_result().user_properties.append((FILE_PROPERTY, collected_file(item)))


@pytest.hookimpl(hookwrapper=True)
def pytest_sessionfinish(session):
    # junitxml writes the report in its own pytest_sessionfinish; it is on disk
    # once every non-wrapper implementation has run.
    yield
    config = session.config
    report = config.getoption("xmlpath", None)
    if not report or hasattr(config, "workerinput"):
        return
    report = os.path.join(config.invocation_params.dir, os.path.expanduser(os.path.expandvars(report)))
    try:
        tree = ET.parse(report)
    except (OSError, ET.ParseError) as error:
        sys.stderr.write(f"vibron_pytest: left {report} without file attributes: {error}\n")
        return
    for case in tree.iter("testcase"):
        properties = case.find("properties")
        if properties is None:
            continue
        for prop in properties.findall("property"):
            if prop.get("name") == FILE_PROPERTY:
                case.set("file", prop.get("value", ""))
                properties.remove(prop)
        if len(properties) == 0:
            case.remove(properties)
    tree.write(report, encoding="utf-8", xml_declaration=True)
