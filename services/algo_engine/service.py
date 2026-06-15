from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
ALGO_DIR = ROOT / "data" / "algo-definitions"
RUNTIME_STATE_FILE = ROOT / "data" / "runtime" / "algo-order-runtime-state.json"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _read_json_or(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def list_algo_definitions() -> list[dict[str, Any]]:
    if not ALGO_DIR.exists():
        return []
    registry_path = ALGO_DIR / "_definition-registry.json"
    registry = _read_json(registry_path) if registry_path.exists() else {}
    active_ids = registry.get("activeDefinitionIds") or registry.get("active") or []
    if not active_ids:
        active_ids = [path.stem for path in ALGO_DIR.glob("*.json") if not path.name.startswith("_")]

    definitions: list[dict[str, Any]] = []
    for definition_id in active_ids:
        path = ALGO_DIR / f"{definition_id}.json"
        if not path.exists():
            continue
        try:
            data = _read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        definitions.append(data)
    return definitions


def algo_manager_state() -> dict[str, Any]:
    definitions = list_algo_definitions()
    return {
        "service": "algo-engine",
        "source": str(ALGO_DIR),
        "count": len(definitions),
        "definitions": definitions,
    }


def algo_builder_templates() -> dict[str, Any]:
    definitions = list_algo_definitions()
    templates = [
        {
            "id": definition.get("templateId") or definition.get("id"),
            "name": definition.get("name") or definition.get("id"),
            "definitionId": definition.get("id"),
            "status": definition.get("status"),
            "instruments": definition.get("instruments", []),
            "signalRules": definition.get("signalRules", []),
            "risk": definition.get("risk", {}),
            "entryPeg": definition.get("entryPeg", {}),
            "layerPlan": definition.get("layerPlan", {}),
            "syntheticOrderManager": definition.get("syntheticOrderManager", {}),
            "exitPolicy": definition.get("exitPolicy", {}),
            "orderPolicy": definition.get("orderPolicy", {}),
            "productMetadata": definition.get("productMetadata", []),
            "raw": definition,
        }
        for definition in definitions
    ]
    return {
        "service": "algo-engine",
        "templates": templates,
    }


def record_algo_guard_event(payload: dict[str, Any]) -> dict[str, Any]:
    state = _read_json_or(RUNTIME_STATE_FILE, {})
    if not isinstance(state, dict):
        state = {}

    timestamp = _iso_now()
    current_sequence = int(state.get("sequence") or 0) + 1
    algo_name = str(payload.get("algoName") or payload.get("name") or "algo")
    symbol = str(payload.get("symbol") or payload.get("marketKey") or "-")
    reason = str(payload.get("reason") or "peg value unavailable")
    message = "send price not published"
    summary = f"{message}: paused {algo_name} on {symbol}; {reason}"
    event = {
        "id": f"AUD-ALGO-GUARD-{current_sequence}",
        "timestamp": timestamp,
        "sequence": current_sequence,
        "channel": "algos",
        "type": "send-price-guard",
        "source": "algo-manager.sanity-check",
        "severity": "error",
        "summary": summary,
        "algoId": payload.get("algoId") or payload.get("id"),
        "algoName": algo_name,
        "symbol": symbol,
        "reason": reason,
        "message": message,
    }

    audit_events = state.get("auditEvents")
    if not isinstance(audit_events, list):
        audit_events = []
    audit_events = [event, *[item for item in audit_events if isinstance(item, dict) and item.get("id") != event["id"]]][:200]

    paused_algos = state.get("pausedAlgos")
    if not isinstance(paused_algos, dict):
        paused_algos = {}
    paused_algos[str(event["algoId"] or algo_name)] = {
        "algoId": event["algoId"],
        "algoName": algo_name,
        "symbol": symbol,
        "pausedAt": timestamp,
        "reason": summary,
    }

    state.update({
        "version": state.get("version") or "acme.algo-order-runtime-state.v1",
        "updatedAt": timestamp,
        "sequence": current_sequence,
        "auditEvents": audit_events,
        "pausedAlgos": paused_algos,
    })
    state.setdefault("algoState", {"working": [], "lastUpdated": timestamp})
    if isinstance(state.get("algoState"), dict):
        state["algoState"]["lastUpdated"] = timestamp
    state.setdefault("orders", [])

    _write_json(RUNTIME_STATE_FILE, state)
    return {"ok": True, "event": event}
