"""The published files' schemas, and the bytes a JSON file is written as."""

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import jsonschema

from ousd.publish.errors import PublishRefused

SCHEMA_VERSION = 2
# The manifest's own schema moved on alone: provenance came in and stale state moved out.
MANIFEST_SCHEMA_VERSION = 3
# Beside the package, in pipeline/ousd/schemas, where the site reads them too.
SCHEMA_DIR = Path(__file__).parent.parent / "schemas"

# jsonschema follows the spec, where 714.0 is an integer. A float here means a mart changed type.
_Validator = jsonschema.validators.extend(
    jsonschema.Draft202012Validator,
    type_checker=jsonschema.Draft202012Validator.TYPE_CHECKER.redefine(
        "integer", lambda _, value: isinstance(value, int) and not isinstance(value, bool)
    ),
)


def _json_bytes(payload: Mapping[str, Any]) -> bytes:
    return (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode()


def _validate(filename: str, payload: Mapping[str, Any]) -> None:
    schema = json.loads((SCHEMA_DIR / f"{filename.removesuffix('.json')}.schema.json").read_text())
    error = jsonschema.exceptions.best_match(_Validator(schema).iter_errors(payload))
    if error is not None:
        # The place and the rule, not the value.
        place = "/".join(str(part) for part in error.absolute_path)
        raise PublishRefused(f"{filename} fails its schema at {place or 'top'}: {error.validator}")
