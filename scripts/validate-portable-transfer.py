#!/usr/bin/env python3
"""Validate the PT01 manifest RDF fixture; it makes no transfer, restore, or byte-verification claim."""
import hashlib
import json
import pathlib
import sys
from datetime import datetime

from pyshacl import validate
from rdflib import Graph, Literal, Namespace, RDF, URIRef

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "research" / "portable-transfer"
ENVELOPE = BASE / "envelope.json"
GRAPH = BASE / "graph.jsonld"
SHAPES = ROOT / "schemas" / "portable-transfer" / "manifest.shacl.ttl"
PT = Namespace("urn:usl:portable-transfer:")
PROV = Namespace("http://www.w3.org/ns/prov#")
MAX_INPUT_BYTES = 2 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read_json(path):
    raw = path.read_bytes()
    require(len(raw) <= MAX_INPUT_BYTES, f"input exceeds byte budget: {path.name}")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AssertionError(f"invalid UTF-8 JSON: {path.name}") from error
    require(isinstance(value, dict), f"JSON object required: {path.name}")
    return value


def clone(graph):
    result = Graph()
    for triple in graph:
        result.add(triple)
    return result


def conforms(data, shapes):
    result, _, report = validate(data, shacl_graph=shapes, advanced=True)
    return result, report


def js_json(value):
    # The PT01 resource IRI contract uses SHA-256 of UTF-8 JSON.stringify([ownerNamespace,nativeId]).
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def resource_iri(identity):
    require(isinstance(identity, dict) and set(identity) == {"ownerNamespace", "nativeId"}, "invalid resource identity object")
    owner, native = identity["ownerNamespace"], identity["nativeId"]
    require(isinstance(owner, str) and isinstance(native, str) and owner and native, "invalid resource identity values")
    digest = hashlib.sha256(js_json([owner, native])).hexdigest()
    return f"urn:usl:portable-resource:{digest}"


def rows(graph, query):
    return list(graph.query(query))


def utc_time(value):
    require(isinstance(value, str), "UTC timestamp must be a string")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise AssertionError("invalid UTC timestamp") from error


def strict_envelope(envelope):
    require(set(envelope) == {"schema", "bodyDigestAlgorithm", "manifestDigest", "manifest"}, "unexpected portable transfer envelope fields")
    require(envelope["schema"] == "usl-portable-transfer-envelope/v1", "unexpected envelope schema")
    require(envelope["bodyDigestAlgorithm"] == "USL_CONTRACT_SHA256_V1", "unexpected envelope digest algorithm")
    manifest = envelope["manifest"]
    require(isinstance(manifest, dict), "manifest object required")
    needed = {"schema", "ownerNamespace", "issuer", "observedAt", "resources", "revisions", "representations", "historyBoundary"}
    require(set(manifest) == needed, "unexpected manifest fields")
    require(manifest["schema"] == "usl-portable-transfer/v1", "unexpected manifest schema")
    for name in ("resources", "revisions", "representations"):
        require(isinstance(manifest[name], list), f"manifest {name} must be an array")
    return manifest


def require_query(graph, query, message):
    rows = list(graph.query(query))
    require(rows, message)
    return rows


def main():
    for path in (ENVELOPE, GRAPH, SHAPES):
        require(path.is_file(), f"missing PT01 manifest fixture input: {path.relative_to(ROOT)}")
    envelope = read_json(ENVELOPE)
    manifest = strict_envelope(envelope)
    data = Graph().parse(GRAPH, format="json-ld")
    shapes = Graph().parse(SHAPES, format="turtle")
    ok, report = conforms(data, shapes)
    require(ok, str(report))

    manifest_iri = "urn:usl:portable-transfer:fixture:manifest"
    require((URIRef(manifest_iri), RDF.type, PT.Manifest) in data, "fixture manifest node missing")
    require((URIRef(manifest_iri), RDF.type, PROV.Entity) in data, "fixture manifest must be a provenance entity")

    # CQ1: each revision endpoint is tied to exactly the envelope's resource/kind/issuer chain.
    expected_revision_tuples = {
        (item["id"], resource_iri(item["resource"]), item["kind"], item["issuer"])
        for item in manifest["revisions"]
    }
    revision_rows = rows(data, """
      PREFIX pt: <urn:usl:portable-transfer:>
      PREFIX prov: <http://www.w3.org/ns/prov#>
      SELECT ?revision ?resource ?kind ?issuer WHERE {
        <urn:usl:portable-transfer:fixture:manifest> pt:revision ?revision .
        ?revision a pt:Revision ; pt:revisionOf ?resource ; pt:kind ?kind ; prov:wasAttributedTo ?issuer .
      }
    """)
    revision_tuples = {(str(row.revision), str(row.resource), str(row.kind), str(row.issuer)) for row in revision_rows}
    require(revision_tuples == expected_revision_tuples, "manifest revision endpoint/resource/kind/issuer set differs from envelope")

    # CQ2: every representation is bound to its exact revision, portable location, and byte claim.
    expected_representation_tuples = {
        (item["id"], item["revision"], item["payloadPath"], item["byteDigestAlgorithm"], item["byteDigest"], str(item["byteLength"]))
        for item in manifest["representations"]
    }
    representation_rows = rows(data, """
      PREFIX pt: <urn:usl:portable-transfer:>
      SELECT ?representation ?revision ?path ?algorithm ?digest ?length WHERE {
        <urn:usl:portable-transfer:fixture:manifest> pt:representation ?representation .
        ?representation a pt:Representation ; pt:representsRevision ?revision ; pt:payloadPath ?path ;
          pt:byteDigestAlgorithm ?algorithm ; pt:byteDigest ?digest ; pt:byteLength ?length .
      }
    """)
    representation_tuples = {(str(row.representation), str(row.revision), str(row.path), str(row.algorithm), str(row.digest), str(row.length)) for row in representation_rows}
    require(representation_tuples == expected_representation_tuples, "manifest representation endpoint/revision/payload claim set differs from envelope")

    # CQ3: revision parent pairs are exact as well; a valid-but-wrong revision target cannot pass.
    expected_parent_pairs = {(item["id"], parent) for item in manifest["revisions"] for parent in item["parents"]}
    parent_rows = rows(data, """
      PREFIX pt: <urn:usl:portable-transfer:>
      SELECT ?revision ?parent WHERE { ?revision a pt:Revision ; pt:parentRevision ?parent }
    """)
    parent_pairs = {(str(row.revision), str(row.parent)) for row in parent_rows}
    require(parent_pairs == expected_parent_pairs, "revision parent edge set differs from envelope")

    # CQ4: same raw bytes are evidence values, never resource identity adoption.
    same_byte_rows = require_query(data, """
      PREFIX pt: <urn:usl:portable-transfer:>
      SELECT ?digest (COUNT(DISTINCT ?resource) AS ?resources) WHERE {
        ?representation a pt:Representation ; pt:byteDigest ?digest ; pt:representsRevision/pt:revisionOf ?resource .
      } GROUP BY ?digest HAVING (COUNT(DISTINCT ?resource) > 1)
    """, "fixture must contain equal raw-byte digests for distinct resources")
    require(any(str(row.resources) == "2" for row in same_byte_rows), "same-byte fixture must retain exactly two distinct resources")

    # CQ5: every resource's IRI is fixed by its owner-namespace/native-ID tuple.
    resource_rows = rows(data, """
      PREFIX pt: <urn:usl:portable-transfer:>
      SELECT ?resource ?owner ?native WHERE { ?resource a pt:Resource ; pt:ownerNamespace ?owner ; pt:nativeId ?native . }
    """)
    expected_resources = {resource_iri(item) for item in manifest["resources"]}
    actual_resources = {str(row.resource) for row in resource_rows}
    require(actual_resources == expected_resources, "resource IRI set differs from owner/native identities")
    for row in resource_rows:
        require(str(row.resource) == resource_iri({"ownerNamespace": str(row.owner), "nativeId": str(row.native)}), "resource IRI does not bind its owner/native tuple")

    # CQ6: tombstones are historical revisions and never have payload representations.
    tombstones = {row.tombstone for row in rows(data, """
      PREFIX pt: <urn:usl:portable-transfer:>
      SELECT ?tombstone WHERE {
        ?tombstone a pt:Tombstone ; pt:kind "TOMBSTONE" .
        FILTER NOT EXISTS { ?representation a pt:Representation ; pt:representsRevision ?tombstone }
      }
    """)}
    require(len(tombstones) == 1, "fixture must contain one tombstone descendant")
    require(all(not list(data.objects(tombstone, PT.revision)) for tombstone in tombstones), "tombstone must not be a manifest")
    for tombstone in tombstones:
        require(not list(data.subjects(PT.representsRevision, tombstone)), "tombstone has a representation")
        require((tombstone, PT.kind, Literal("TOMBSTONE")) in data, "tombstone kind mismatch")

    # CQ7: observation time and issuer are claims in the envelope, never inferred from file time.
    observation_rows = rows(data, """
      PREFIX pt: <urn:usl:portable-transfer:>
      PREFIX prov: <http://www.w3.org/ns/prov#>
      SELECT ?observedAt ?issuer WHERE {
        <urn:usl:portable-transfer:fixture:manifest> pt:observedAt ?observedAt ; prov:wasAttributedTo ?issuer
      }
    """)
    require({(utc_time(str(row.observedAt)), str(row.issuer)) for row in observation_rows} == {(utc_time(manifest["observedAt"]), manifest["issuer"])}, "manifest observation time or issuer differs from envelope")

    # CQ8: state is intentionally historical/limited.  It cannot be promoted by a graph consumer.
    state_rows = rows(data, """
      PREFIX pt: <urn:usl:portable-transfer:>
      SELECT ?authority ?freshness ?payload WHERE {
        <urn:usl:portable-transfer:fixture:manifest> pt:authority ?authority ; pt:freshness ?freshness ; pt:payload ?payload
      }
    """)
    require({(str(row.authority), str(row.freshness), str(row.payload)) for row in state_rows} == {("NOT_GRANTED", "UNKNOWN", "NOT_CHECKED")}, "manifest state was promoted")

    # Negative examples exercise SHACL endpoint/type/state constraints and an independent cycle check.
    revision = next(iter(data.subjects(RDF.type, PT.Revision)))
    bad = clone(data); bad.remove((revision, PT.revisionOf, None)); require(not conforms(bad, shapes)[0], "missing revision resource target accepted")
    representation = next(iter(data.subjects(RDF.type, PT.Representation)))
    bad = clone(data); bad.set((representation, PT.representsRevision, URIRef(manifest_iri))); require(not conforms(bad, shapes)[0], "representation wrong target type accepted")
    bad = clone(data); bad.set((URIRef(manifest_iri), PT.authority, Literal("GRANTED"))); require(not conforms(bad, shapes)[0], "authority promotion accepted")
    bad = clone(data); bad.set((URIRef(manifest_iri), PT.freshness, Literal("FRESH"))); require(not conforms(bad, shapes)[0], "freshness promotion accepted")
    bad = clone(data); bad.set((URIRef(manifest_iri), PT.payload, Literal("VERIFIED"))); require(not conforms(bad, shapes)[0], "payload verification promotion accepted")
    tombstone = next(iter(tombstones))
    bad = clone(data); bad.add((representation, PT.representsRevision, tombstone)); require(not conforms(bad, shapes)[0], "tombstone representation accepted")
    tombstone_resource = next(data.objects(tombstone, PT.revisionOf))
    cross_resource_parent = next(item for item in data.subjects(RDF.type, PT.Revision) if item != tombstone and next(data.objects(item, PT.revisionOf)) != tombstone_resource)
    bad = clone(data); bad.set((tombstone, PT.parentRevision, cross_resource_parent)); require(not conforms(bad, shapes)[0], "tombstone cross-resource parent accepted")
    live = next(item for item in data.subjects(RDF.type, PT.Revision) if item != tombstone)
    alternate_resource = next(item for item in data.subjects(RDF.type, PT.Resource) if item != next(data.objects(live, PT.revisionOf)))
    bad = clone(data); bad.set((live, PT.revisionOf, alternate_resource))
    bad_tuples = {(str(row.revision), str(row.resource), str(row.kind), str(row.issuer)) for row in rows(bad, """
      PREFIX pt: <urn:usl:portable-transfer:>
      PREFIX prov: <http://www.w3.org/ns/prov#>
      SELECT ?revision ?resource ?kind ?issuer WHERE { <urn:usl:portable-transfer:fixture:manifest> pt:revision ?revision . ?revision a pt:Revision ; pt:revisionOf ?resource ; pt:kind ?kind ; prov:wasAttributedTo ?issuer }
    """)}
    require(bad_tuples != expected_revision_tuples, "wrong valid resource rewiring escaped exact tuple check")
    original_representation_revision = next(data.objects(representation, PT.representsRevision))
    alternate_revision = next(item for item in data.subjects(RDF.type, PT.Revision) if item != tombstone and item != original_representation_revision)
    bad = clone(data); bad.set((representation, PT.representsRevision, alternate_revision))
    bad_tuples = {(str(row.representation), str(row.revision), str(row.path), str(row.algorithm), str(row.digest), str(row.length)) for row in rows(bad, """
      PREFIX pt: <urn:usl:portable-transfer:>
      SELECT ?representation ?revision ?path ?algorithm ?digest ?length WHERE { <urn:usl:portable-transfer:fixture:manifest> pt:representation ?representation . ?representation a pt:Representation ; pt:representsRevision ?revision ; pt:payloadPath ?path ; pt:byteDigestAlgorithm ?algorithm ; pt:byteDigest ?digest ; pt:byteLength ?length }
    """)}
    require(bad_tuples != expected_representation_tuples, "wrong valid revision rewiring escaped exact tuple check")

    parent_edges = {(str(child), str(parent)) for child, parent in data.subject_objects(PT.parentRevision)}
    def acyclic(edges):
        children = {}
        for child, parent in edges:
            children.setdefault(child, set()).add(parent)
        done, active = set(), set()
        def visit(node):
            if node in active:
                return False
            if node in done:
                return True
            active.add(node)
            result = all(visit(parent) for parent in children.get(node, ()))
            active.remove(node)
            if result:
                done.add(node)
            return result
        return all(visit(node) for node in children)
    require(acyclic(parent_edges), "fixture revision parent graph has a cycle")
    cycle = set(parent_edges)
    edge = next(iter(cycle))
    first = edge[0]
    cycle.add((edge[1], first))
    require(not acyclic(cycle), "revision parent cycle counterexample accepted")
    bad = clone(data); bad.add((URIRef(edge[1]), PT.parentRevision, URIRef(first))); require(not conforms(bad, shapes)[0], "revision parent cycle accepted by SHACL")
    print(json.dumps({"rdf": "PARSED", "shacl": "CONFORMS", "competencyQueries": 8,
                      "negativeCases": 11,
                      "scope": "PT01_MANIFEST_RDF_FIXTURE_ONLY_NO_TRANSFER_RESTORE_OR_BYTE_VERIFICATION_CLAIM"}))


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, ValueError) as error:
        print(f"portable-transfer validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
