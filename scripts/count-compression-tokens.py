"""Offline token counter for benchmark payloads. Reads {texts, encodings} from stdin."""
import json, sys
import tiktoken

request = json.load(sys.stdin)
encodings = request.get("encodings", [])
texts = request.get("texts", {})
if not isinstance(encodings, list) or not isinstance(texts, dict): raise SystemExit("expected encodings and texts")
result = {"tiktokenVersion": tiktoken.__version__, "pythonVersion": sys.version.split()[0], "encodings": {}}
for name in encodings:
    encoding = tiktoken.get_encoding(name)
    result["encodings"][name] = {key: len(encoding.encode_ordinary(value)) for key, value in texts.items()}
print(json.dumps(result, ensure_ascii=False, sort_keys=True))
