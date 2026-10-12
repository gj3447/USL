#!/usr/bin/env python3
"""Build/check a bounded implementation projection without changing the historical plan."""
import argparse, hashlib, json, pathlib, re, subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]; BASE=ROOT/"research/native-development/implementation"; BASELINE="research/native-development/graph.json"; FIXED_COMMIT="be6e87f450169f8caa85cba9b18b26ae436e9657"
ITEMS={"P01":("R01","R02","R07","src/addons/native-profile.ts","test/native-profile.test.ts"),"P02":("R02",None,None,"src/addons/native-profile-store.ts","test/native-profile-store.test.ts"),"P03":("R01","R03",None,"src/addons/native-observation.ts","test/native-observation.test.ts"),"P05":("R02","R07",None,"src/addons/native-profile-runtime.ts","test/native-profile-runtime.test.ts"),"P06":("R05",None,None,"src/addons/native-http.ts","test/native-http.test.ts"),"P08":("R06",None,None,"src/addons/native-delivery.ts","test/native-delivery.test.ts"),"P09":("R07",None,None,"src/addons/native-dispatch.ts","src/cli-host.ts","test/native-dispatch.test.ts","test/cli-host.test.ts","test/native-dispatch-fixture.ts","test/native-dispatch-fault.test.ts")}; PENDING=("P04","P07","P10","P11","P12")
SCOPES={"P01":"PURE_CONTRACTS_NOT_AUTHORIZATION","P02":"SINGLE_OWNER_STORE_NOT_CROSS_HOST_AT_MOST_ONCE","P03":"LINUX_READ_ONLY_NON_ATOMIC","P05":"A_TO_B_SAME_GRAPH_NO_AUTOCOPY","P06":"URL_ALLOWLIST_NOT_GITHUB_OR_IP_PIN","P08":"REGISTERED_CALLBACK_FULL_DELIVERY_NOT_UNDERSTANDING_OR_DISPATCHER","P09":"OWNER_DISPATCH_GATE_INTENT_DEDUP_RECHECK_NOT_EFFECT_ATOMICITY"}
def dump(v): return json.dumps(v,ensure_ascii=False,indent=2)+"\n"
def sha(path): return "sha256:"+hashlib.sha256((ROOT/path).read_bytes()).hexdigest()
def blob(path): return subprocess.check_output(["git","rev-parse",f"{FIXED_COMMIT}:{path}"],cwd=ROOT,text=True).strip()
def blobsha(path): return "sha256:"+hashlib.sha256(subprocess.check_output(["git","show",f"{FIXED_COMMIT}:{path}"],cwd=ROOT)).hexdigest()
def load_checks():
 p=BASE/"checks.json"
 if not p.exists(): return {"schema":"usl-native-implementation-checks/v1","checks":[]}
 v=json.loads(p.read_text())
 if v.get("schema")!="usl-native-implementation-checks/v1" or not isinstance(v.get("checks"),list): raise ValueError("invalid check collection")
 return v
def current_pins(): return {path:sha(path) for v in ITEMS.values() for path in v[3:] if (ROOT/path).is_file()}
def validate_check(v,pins):
 if not isinstance(v,dict): raise ValueError("check report must be an object")
 if v.get("pins")!=pins: raise ValueError("check report pins are stale or incomplete")
 if v.get("schema")!="usl-native-implementation-check/v1" or v.get("status")!="PASS": raise ValueError("invalid check report schema/status")
 if not isinstance(v.get("command"),list) or not v["command"] or any(not isinstance(x,str) or not x for x in v["command"]): raise ValueError("check command must be nonempty strings")
 if type(v.get("count")) is not int or v["count"]<1: raise ValueError("check count must be a positive integer")
 if any(path not in v["command"] for item in ITEMS.values() for path in item[3:] if path.endswith(".test.ts")): raise ValueError("command does not cover all implementation tests")
 output=v.get("output",{})
 if output.get("path")!="research/native-development/implementation/test-output.tap": raise ValueError("missing local TAP record")
 raw=(ROOT/output["path"]).read_bytes()
 if len(raw)>1024*1024 or sha(output["path"])!=output.get("sha256"): raise ValueError("TAP record pin differs")
 expected={"tests":v["count"],"pass":v["count"],"fail":0,"cancelled":0,"skipped":0,"todo":0}
 if any(re.findall(rf"^# {key} (\d+)$",raw.decode("utf-8"),re.M)!=[str(number)] for key,number in expected.items()): raise ValueError("TAP record does not support successful count")
def model(checks):
 pins=current_pins(); valid=[]
 for c in checks["checks"]: validate_check(c,pins); valid.append(c)
 checked=bool(valid); resources=[]; links=[]
 original=json.loads(subprocess.check_output(["git","show",f"{FIXED_COMMIT}:{BASELINE}"],cwd=ROOT))
 original_ids={r["id"]:index for index,r in enumerate(original["resources"])}
 def requirements(item):
  result=[]
  for link in original["links"]:
   roles={p["role"]:p["resource"] for p in link["participants"]}
   if link["meaning"]=="realizes" and roles.get("work")=="urn:usl:dev:work:"+item: result.append(roles["requirement"])
  if not result: raise ValueError("original work has no requirements")
  return result
 baseline={"id":"urn:usl:native-implementation:baseline:plan","types":["urn:usl:native-implementation:HistoricalPlanSnapshot"],"locator":f"git://usl-root@{FIXED_COMMIT}:research/native-development/graph.json","metadata":{"path":BASELINE,"gitCommit":FIXED_COMMIT,"gitBlob":blob(BASELINE),"sha256":blobsha(BASELINE),"status":"HISTORICAL_PLANNED_SPECIFIED_NOT_RUN"}}; resources.append(baseline)
 for item,v in ITEMS.items():
  reqs=[r for r in v[:3] if r]; paths=v[3:]; exists=all((ROOT/path).is_file() for path in paths); status="IMPLEMENTED_BOUNDED" if exists and checked else "CODE_PRESENT_NOT_VERIFIED" if exists else "PARTIAL"; wid=f"urn:usl:native-implementation:work:{item}"
  resources.append({"id":wid,"types":["urn:usl:native-implementation:ImplementationWork"],"metadata":{"workItem":item,"status":status,"plannedStatus":"PLANNED","scope":SCOPES[item],"limitations":["NO_GENERAL_ACCEPTANCE_CLAIM","NO_AUTHORITY_GRANT","READ_ONLY_PROGRESS_PROJECTION"]}}); links += [{"source":wid,"predicate":"snapshotOf","target":"urn:usl:dev:work:"+item},{"source":wid,"predicate":"derivedFrom","target":baseline["id"]}]+[{"source":wid,"predicate":"addresses","target":"urn:usl:dev:req:"+r} for r in reqs]
  if exists:
   for number,path in enumerate(paths):
    role="TEST" if path.startswith("test/") else "CODE"; suffix=role.lower() if sum(1 for p in paths if (p.startswith("test/") if role=="TEST" else not p.startswith("test/")))==1 else f"{role.lower()}-{number+1}"
    aid=f"urn:usl:native-implementation:artifact:{item}:{suffix}"; resources.append({"id":aid,"types":["urn:usl:native-implementation:Artifact"],"locator":"file://usl-root/"+path,"metadata":{"role":role,"path":path,"sha256":pins[path]}}); links.append({"source":wid,"predicate":"implementedBy" if role=="CODE" else "checkedBy","target":aid})
 for item in PENDING:
  wid=f"urn:usl:native-implementation:work:{item}"; resources.append({"id":wid,"types":["urn:usl:native-implementation:ImplementationWork"],"metadata":{"workItem":item,"status":"PLANNED","plannedStatus":"PLANNED"}}); links.append({"source":wid,"predicate":"snapshotOf","target":"urn:usl:dev:work:"+item})
 for n,c in enumerate(valid):
  cid="urn:usl:native-implementation:check:"+hashlib.sha256(dump(c).encode()).hexdigest(); resources.append({"id":cid,"types":["urn:usl:native-implementation:ObservedCheck"],"locator":"file://usl-root/research/native-development/implementation/checks.json","metadata":{**c,"evidenceRole":"RECORDED_LOCAL_RUN_NOT_SIGNED_ATTESTATION"}}); links += [{"source":f"urn:usl:native-implementation:work:{item}","predicate":"observedBy","target":cid} for item in ITEMS]
 # Preserve the original requirement mapping for implemented AND pending work.
 links=[edge for edge in links if edge["predicate"]!="addresses"]
 links += [{"source":"urn:usl:native-implementation:work:"+item,"predicate":"addresses","target":rid} for item in [*ITEMS,*PENDING] for rid in requirements(item)]
 # The exchange graph is self-contained: historical IDs are references, not inferred facts.
 known={r["id"] for r in resources}
 for edge in links:
  if edge["target"] not in known:
   if edge["target"] not in original_ids: raise ValueError("historical reference absent from pinned baseline")
   resources.append({"id":edge["target"],"types":["urn:usl:native-implementation:HistoricalReference"],"locator":baseline["locator"],"metadata":{**baseline["metadata"],"selector":"/resources/"+str(original_ids[edge["target"]]),"status":"HISTORICAL_REFERENCE_ONLY"}}); known.add(edge["target"])
 for r in resources:
  r.setdefault("locator","file://usl-root/research/native-development/implementation/graph.json")
  r["metadata"]["authorityClass"]="SECONDARY_AI"
 meanings=[{"id":name,"description":"Bounded implementation-progress relation; not an entailment."} for name in sorted({x["predicate"] for x in links})]
 role={"snapshotOf":("implementation","historical"),"derivedFrom":("implementation","baseline"),"addresses":("implementation","requirement"),"implementedBy":("implementation","code"),"checkedBy":("implementation","test"),"observedBy":("implementation","check")}
 typed=[{"id":"urn:usl:native-implementation:link:"+hashlib.sha256(dump(e).encode()).hexdigest(),"meaning":e["predicate"],"participants":[{"role":role[e["predicate"]][0],"resource":e["source"]},{"role":role[e["predicate"]][1],"resource":e["target"]}]} for e in links]
 return {"schema":"usl-resource-graph/v1","resources":resources,"meanings":meanings,"links":typed,"provenance":{"sources":[baseline["id"]]}}
def main():
 ap=argparse.ArgumentParser(); ap.add_argument("--check",action="store_true"); ap.add_argument("--input",type=pathlib.Path); a=ap.parse_args()
 if a.check and a.input: ap.error("--check is read-only and cannot record --input")
 checks=load_checks()
 if a.input:
  c=json.loads(a.input.read_text()); validate_check(c,current_pins()); checks["checks"]=[c]
 graph=model(checks)
 nodes={r["id"]:{"@id":r["id"],"@type":r["types"],"ni:locator":r["locator"],"ni:metadata":{"@value":r["metadata"],"@type":"@json"},**({"ni:status":r["metadata"]["status"]} if "status" in r["metadata"] else {})} for r in graph["resources"]}
 for resource in graph["resources"]:
  if "sha256" in resource["metadata"]: nodes[resource["id"]]["ni:sha256"]=resource["metadata"]["sha256"]
  if "role" in resource["metadata"]: nodes[resource["id"]]["ni:role"]=resource["metadata"]["role"]
 for link in graph["links"]:
  source,target=[p["resource"] for p in link["participants"]]
  nodes[source].setdefault("ni:"+link["meaning"],[]).append({"@id":target})
  if link["meaning"] in ("snapshotOf","derivedFrom"): nodes[source].setdefault("prov:wasDerivedFrom",[]).append({"@id":target})
 trace={"@context":{"ni":"urn:usl:native-implementation:","prov":"http://www.w3.org/ns/prov#"},"@graph":list(nodes.values())}
 outputs={BASE/"graph.json":dump(graph),BASE/"trace.jsonld":dump(trace),BASE/"progress.json":dump({"schema":"usl-native-implementation-progress/v1","checks":checks["checks"],"pins":current_pins(),"claim":"BOUNDED_IMPLEMENTATION_EVIDENCE_ONLY"})}
 if a.check:
  for p,s in outputs.items():
   if not p.exists() or p.read_text()!=s: raise SystemExit("stale implementation projection: "+str(p))
 else:
  BASE.mkdir(parents=True,exist_ok=True)
  if a.input: (BASE/"checks.json").write_text(dump(checks))
  for p,s in outputs.items(): p.write_text(s)
 print(dump({"mode":"CHECKED" if a.check else "BUILT","checks":len(checks["checks"]),"pending":list(PENDING)}))
if __name__=="__main__": main()
