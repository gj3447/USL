#!/usr/bin/env python3
"""Validate the native-development RDF projection, SHACL constraints, and coverage queries."""
import json
import pathlib
import sys
from rdflib import Graph, Literal, Namespace, RDF
from pyshacl import validate

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "research" / "native-development"
TRACE = BASE / "trace.jsonld"
SHAPES = BASE / "shapes.ttl"
ND = Namespace("urn:usl:native-development:")


def fail(message: str) -> None:
    raise AssertionError(message)


def load(path: pathlib.Path, fmt: str) -> Graph:
    if not path.is_file():
        hint = "NOT_HYDRATED (regenerated, not committed; run python3 -B scripts/build-native-development.py)" if path.suffix == ".jsonld" else "missing input"
        fail(f"{hint}: {path.relative_to(ROOT)}")
    return Graph().parse(path, format=fmt)


def conforms(data: Graph, shapes: Graph) -> bool:
    result, _, report = validate(data, shacl_graph=shapes, inference="none", advanced=True)
    if not result:
        fail(f"SHACL violation:\n{report}")
    return result


def clone(data: Graph) -> Graph:
    copied = Graph()
    for triple in data:
        copied.add(triple)
    return copied


def rejected(data: Graph, shapes: Graph, label: str) -> None:
    result, _, _ = validate(data, shacl_graph=shapes, inference="none", advanced=True)
    if result:
        fail(f"negative mutation accepted: {label}")


def count(data: Graph, query: str) -> int:
    return int(next(iter(data.query(query, initNs={"nd": ND})))[0])


def main() -> int:
    if len(sys.argv) != 1:
        fail("this validator accepts no arguments")
    data, shapes = load(TRACE, "json-ld"), load(SHAPES, "turtle")
    conforms(data, shapes)

    work = count(data, "SELECT (COUNT(DISTINCT ?item) AS ?count) WHERE { ?item a nd:WorkItem }")
    requirement = count(data, "SELECT (COUNT(DISTINCT ?item) AS ?count) WHERE { ?item a nd:Requirement }")
    source = count(data, "SELECT (COUNT(DISTINCT ?item) AS ?count) WHERE { ?item a nd:UserSource }")
    artifact = count(data, "SELECT (COUNT(DISTINCT ?item) AS ?count) WHERE { ?item a nd:Artifact }")
    positive = count(data, "SELECT (COUNT(DISTINCT ?item) AS ?count) WHERE { ?item a nd:AcceptanceTest ; nd:kind 'POSITIVE' }")
    adversarial = count(data, "SELECT (COUNT(DISTINCT ?item) AS ?count) WHERE { ?item a nd:AcceptanceTest ; nd:kind 'ADVERSARIAL' }")
    if not all((work, requirement, source, artifact, positive, adversarial)):
        fail("projection lacks work, requirements, user source, or both test kinds")

    # Each planned item must retain one bounded provenance path and all specified evidence roles.
    uncovered = count(data, """
      SELECT (COUNT(DISTINCT ?work) AS ?count) WHERE {
        { ?work a nd:WorkItem .
          FILTER NOT EXISTS { ?work nd:realizes ?requirement . ?requirement a nd:Requirement ; nd:derivedFrom ?source . ?source a nd:UserSource } }
        UNION
        { ?work a nd:WorkItem . FILTER NOT EXISTS { ?work nd:verifiedBy ?test . ?test a nd:AcceptanceTest } }
        UNION
        { ?work a nd:WorkItem . FILTER NOT EXISTS { ?work nd:groundedIn ?artifact . ?artifact a nd:Artifact } }
        UNION
        { ?work a nd:WorkItem . FILTER NOT EXISTS { ?work nd:constrainedBy ?constraint . ?constraint a nd:Constraint } }
      }
    """)
    if uncovered:
        fail(f"work items missing required provenance/evidence path: {uncovered}")

    executed = count(data, """
      SELECT (COUNT(DISTINCT ?test) AS ?count) WHERE {
        ?test a nd:AcceptanceTest ; nd:status ?status .
        FILTER(?status != 'SPECIFIED_NOT_RUN')
      }
    """)
    if executed:
        fail(f"acceptance status claims execution: {executed}")

    # Conditional dependencies are intentionally not ordinary dependsOn edges.
    direct_conditional = {
        (work, prerequisite)
        for work, prerequisite in data.query("SELECT ?work ?prerequisite WHERE { ?work nd:conditionallyDependsOn ?prerequisite }", initNs={"nd": ND})
    }
    reified_conditional = {
        (work, prerequisite)
        for work, prerequisite in data.query("""
          SELECT ?work ?prerequisite WHERE {
            ?link a nd:ConditionalDependency ; nd:work ?work ; nd:prerequisite ?prerequisite ; nd:condition ?condition .
          }
        """, initNs={"nd": ND})
    }
    unconditional = {
        (work, prerequisite)
        for work, prerequisite in data.query("SELECT ?work ?prerequisite WHERE { ?work nd:dependsOn ?prerequisite }", initNs={"nd": ND})
    }
    if direct_conditional != reified_conditional:
        fail("conditional direct edges differ from ConditionalDependency reification")
    if direct_conditional & unconditional:
        fail("conditional dependency also represented as unconditional dependsOn")

    first_work = next(data.subjects(RDF.type, ND.WorkItem), None)
    first_source = next(data.subjects(RDF.type, ND.UserSource), None)
    first_test = next(data.subjects(RDF.type, ND.AcceptanceTest), None)
    first_requirement = next(data.subjects(RDF.type, ND.Requirement), None)
    first_artifact = next(data.subjects(RDF.type, ND.Artifact), None)
    first_prior_work = next(data.subjects(RDF.type, ND.PriorWork), None)
    if None in (first_work, first_source, first_test, first_requirement, first_artifact, first_prior_work):
        fail("cannot construct negative mutations")

    broken = clone(data)
    broken.set((first_work, ND.status, Literal("IMPLEMENTED")))
    rejected(broken, shapes, "planned work promoted to implemented")
    broken = clone(data)
    broken.remove((first_source, ND.authorityClass, None))
    broken.add((first_source, ND.authorityClass, Literal("SECONDARY_AI")))
    rejected(broken, shapes, "user source authority replaced")
    broken = clone(data)
    broken.remove((first_test, ND.kind, None))
    broken.add((first_test, ND.kind, Literal("EXECUTED")))
    rejected(broken, shapes, "unsupported acceptance kind")
    broken = clone(data)
    broken.remove((first_work, ND.realizes, None))
    broken.add((first_work, ND.realizes, first_source))
    rejected(broken, shapes, "work realizes source instead of requirement")
    broken = clone(data)
    broken.remove((first_requirement, ND.derivedFrom, None))
    rejected(broken, shapes, "requirement source provenance removed")
    broken = clone(data)
    broken.set((first_artifact, ND.runtimeTestedThisResearch, Literal(True)))
    rejected(broken, shapes, "artifact runtime evidence promoted")
    broken = clone(data)
    broken.remove((first_prior_work, ND.originallyDeclaredIn, None))
    rejected(broken, shapes, "prior work original artifact link removed")
    untracked_artifact = next(
        data.subjects(ND.evidenceScope, Literal("LOCAL_UNTRACKED_SNAPSHOT")), None
    )
    if untracked_artifact is None:
        fail("cannot construct local-untracked revision mutation")
    broken = clone(data)
    broken.add((untracked_artifact, ND.contentRevision, Literal("0" * 40)))
    rejected(broken, shapes, "local-untracked artifact claims content revision")

    print(json.dumps({
        "rdf": "PARSED", "shacl": "CONFORMS", "workItems": work,
        "requirements": requirement, "userSources": source, "artifacts": artifact,
        "positiveAcceptance": positive, "adversarialAcceptance": adversarial,
        "competencyQueries": 4, "negativeCases": 8,
        "conditionalDependencies": len(direct_conditional),
        "scope": "DECLARED_NATIVE_DEVELOPMENT_PLAN_NOT_EXECUTION_EVIDENCE",
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, ValueError) as error:
        print(f"native-development validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
