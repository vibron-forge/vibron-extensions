"""pytest plugin of the vibron.python extension.

Vibron's test runner loads it with ``-p vibron_pytest`` from the extension
folder that ``PYTHONPATH`` names (see manifest.json). It adds what the JUnit XML
report Vibron reads does not carry on its own:

* A ``-k`` value that is exactly one test's node id, or its JUnit name
  (``classname.name``, the name Vibron shows), selects that test alone. pytest's
  own ``-k`` compares substrings with each name separately, so such a value
  would match nothing, or be rejected when the name has ``&``, spaces or
  brackets. Any other ``-k`` value is left to pytest.
* A ``file`` attribute on every ``<testcase>`` of the ``--junitxml`` report: the
  file the test was collected from, relative to the folder pytest started in.
  ``junit_family=xunit2`` writes no file, and ``xunit1`` counts lines from
  zero, so without this a case would lose its file.
"""

import os
import sys
import xml.etree.ElementTree as ET

import pytest

FILE_PROPERTY = "vibron.file"


def junit_name(nodeid, prefix):
    """The name pytest's junitxml writes for a test: its classname and name
    joined by a dot, built the way _pytest.junitxml.mangle_test_address does."""
    path, bracket, params = nodeid.partition("[")
    names = path.split("::")
    names[0] = names[0].replace("/", ".")
    if names[0].endswith(".py"):
        names[0] = names[0][: -len(".py")]
    names[-1] += bracket + params
    if prefix:
        names.insert(0, prefix)
    return ".".join(names)


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config, items):
    # Runs before pytest applies -k; an exact match takes -k's place.
    wanted = config.getoption("keyword", "").strip()
    if not wanted:
        return
    prefix = config.getoption("junitprefix", None)
    selected, deselected = [], []
    for item in items:
        if wanted in (item.nodeid, junit_name(item.nodeid, prefix)):
            selected.append(item)
        else:
            deselected.append(item)
    if not selected:
        return
    config.option.keyword = ""
    if deselected:
        config.hook.pytest_deselected(items=deselected)
        items[:] = selected


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
