from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
PROTO_DIR = ROOT / "vendor" / "t4" / "proto"
MANIFEST = PROTO_DIR / "protos.txt"
OUT_DIR = ROOT


def _read_manifest() -> list[str]:
    if not MANIFEST.exists():
        raise SystemExit(f"Missing T4 proto manifest: {MANIFEST}")
    return [
        line.strip().replace("\\", "/")
        for line in MANIFEST.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def _ensure_package_inits() -> None:
    for path in [
        OUT_DIR / "t4",
        OUT_DIR / "t4" / "v1",
        OUT_DIR / "t4" / "v1" / "account",
        OUT_DIR / "t4" / "v1" / "auth",
        OUT_DIR / "t4" / "v1" / "common",
        OUT_DIR / "t4" / "v1" / "market",
        OUT_DIR / "t4" / "v1" / "orderrouting",
    ]:
        path.mkdir(parents=True, exist_ok=True)
        init_file = path / "__init__.py"
        init_file.touch(exist_ok=True)


def main() -> int:
    try:
        import grpc_tools
        from grpc_tools import protoc
    except ImportError:
        raise SystemExit("grpcio-tools is missing. Run: .\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt")

    proto_files = _read_manifest()
    google_proto_dir = Path(grpc_tools.__file__).resolve().parent / "_proto"
    args = [
        "grpc_tools.protoc",
        f"--proto_path={PROTO_DIR}",
        f"--proto_path={google_proto_dir}",
        f"--python_out={OUT_DIR}",
        *proto_files,
    ]
    result = protoc.main(args)
    if result != 0:
        return result

    _ensure_package_inits()
    print(f"Compiled {len(proto_files)} T4 proto files into {OUT_DIR / 't4'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
