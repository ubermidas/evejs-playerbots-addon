#!/usr/bin/env python3
"""Build the Docker add-on release ZIP from this repository.

    python3 tools/playerbots/build-addon-package.py                 # dist/evejs-playerbots-addon-v<version>.zip
    python3 tools/playerbots/build-addon-package.py --manifest-only # refresh integration/manifest.json only
    python3 tools/playerbots/build-addon-package.py --compat-root /path/to/stock/EveJS-261125.3

The server files come from integration/server/ and the add-on from
addons/playerbots/. Before packaging, integration/manifest.json is refreshed:
the installed hashes of every managed server file and the add-on file hashes.
The stock hashes (baseSha256) are kept as recorded, or re-read from a stock
EveJS checkout when --compat-root is given (for moving to a new EveJS version).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ADDON_SOURCE = REPO / "addons" / "playerbots"
OVERLAY = REPO / "integration" / "server"
MANIFEST = REPO / "integration" / "manifest.json"
# Package-level tools: placed at the package root, not inside addons/playerbots.
INSTALLER_FILES = {"install.sh", "install.py", "rollback.py", "verify.py"}
# Documents shipped at the package root.
DOCS = ("README.md", "GUIDE.md", "CHANGELOG.md", "PLAYERBOTS_ROADMAP.md", "LICENSE", "THIRD_PARTY_NOTICES.md")
# Keep in step with addons/playerbots/verify.py.
SUBSYSTEM_PREFIXES = (
    ("server/src/services/playerbots/", "playerbots-core"),
    ("server/src/services/scheduler/", "scheduler"),
    ("server/src/services/market/", "economy-authorities"),
    ("server/src/services/account/", "economy-authorities"),
    ("server/src/services/contracts/", "economy-authorities"),
    ("server/src/services/corporation/", "corporation-sovereignty-structures"),
    ("server/src/services/sovereignty/", "corporation-sovereignty-structures"),
    ("server/src/services/structure/", "corporation-sovereignty-structures"),
    ("server/src/services/chat/", "chat-commands"),
    ("server/src/services/dungeon/", "dungeon"),
    ("server/src/services/planet/", "planetary"),
    ("server/src/services/fleets/", "fleets"),
    ("server/src/space/", "space-runtime"),
    ("server/src/gameStore/", "gamestore"),
    ("server/assets/fittings/", "fittings"),
    ("server/src/_secondary/fitting/", "fittings"),
)


def subsystem_for(relative: str) -> str:
    for prefix, name in SUBSYSTEM_PREFIXES:
        if relative.startswith(prefix):
            return name
    return "platform"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def addon_files() -> list[Path]:
    return [path for path in sorted(ADDON_SOURCE.rglob("*"))
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
            and path.relative_to(ADDON_SOURCE).as_posix() not in INSTALLER_FILES]


def refresh_manifest(compat_root: Path | None) -> dict:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    files = manifest["files"]
    on_disk = sorted(path.relative_to(OVERLAY).as_posix() for path in OVERLAY.rglob("*") if path.is_file())
    for relative in on_disk:
        record = files.setdefault(relative, {"baseSha256": None, "subsystem": subsystem_for(relative)})
        record["sourceSha256"] = record["overlaySha256"] = sha256(OVERLAY / relative)
        if compat_root is not None:
            stock = compat_root / relative
            record["baseSha256"] = sha256(stock) if stock.is_file() else None
    missing = sorted(set(files) - set(on_disk))
    if missing:
        raise SystemExit(f"integration/manifest.json lists files that are not in integration/server: {', '.join(missing[:5])}")
    manifest["files"] = {key: files[key] for key in sorted(files)}
    manifest["addonFiles"] = {
        f"addons/playerbots/{path.relative_to(ADDON_SOURCE).as_posix()}": sha256(path) for path in addon_files()
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--compat-root", help="stock EveJS checkout to re-read stock hashes from")
    parser.add_argument("--manifest-only", action="store_true", help="refresh integration/manifest.json and stop")
    parser.add_argument("--output", help="output ZIP path (default: dist/evejs-playerbots-addon-v<version>.zip)")
    args = parser.parse_args()

    compat_root = Path(args.compat_root).expanduser().resolve() if args.compat_root else None
    if compat_root is not None and not (compat_root / "server/package.json").is_file():
        raise SystemExit(f"Not an EveJS checkout: {compat_root}")
    manifest = refresh_manifest(compat_root)
    if args.manifest_only:
        print(f"Refreshed {MANIFEST.relative_to(REPO)}: {len(manifest['files'])} server files, "
              f"{len(manifest['addonFiles'])} add-on files.")
        return 0

    version = str(json.loads((ADDON_SOURCE / "manifest.json").read_text(encoding="utf-8"))["version"])
    package_name = f"EveJS-Playerbots-Addon-v{version}"
    output = Path(args.output).expanduser().resolve() if args.output else REPO / "dist" / f"evejs-playerbots-addon-v{version}.zip"

    with tempfile.TemporaryDirectory(prefix="evejs-playerbots-package-") as temporary:
        stage = Path(temporary) / package_name
        for relative in manifest["files"]:
            copy_file(OVERLAY / relative, stage / "integration/server" / relative)
        copy_file(MANIFEST, stage / "integration/manifest.json")
        for path in addon_files():
            copy_file(path, stage / "addons/playerbots" / path.relative_to(ADDON_SOURCE))
        for name in ("install.py", "rollback.py", "verify.py"):
            copy_file(ADDON_SOURCE / name, stage / name)
        copy_file(ADDON_SOURCE / "compose.override.yaml", stage / "compose.override.yaml")
        package_manifest = json.dumps({
            "id": "evejs.playerbots",
            "name": "EveJS Playerbots Add-on",
            "version": version,
            "evejsVersion": manifest["evejsVersion"],
            "apiVersion": 1,
            "runtime": "node >= 26",
            "process": "standalone",
            "sourceOverlay": "integration/manifest.json",
        }, indent=2) + "\n"
        (stage / "manifest.json").write_text(package_manifest, encoding="utf-8")
        # The repository root doubles as an unpacked package for git installs.
        (REPO / "manifest.json").write_text(package_manifest, encoding="utf-8")
        for name in DOCS:
            copy_file(REPO / name, stage / name)
        copy_file(REPO / "doc/name-library-template.json", stage / "doc/name-library-template.json")
        (stage / "install.sh").write_text(
            "#!/usr/bin/env bash\nset -Eeuo pipefail\n"
            "PACKAGE_DIR=\"$(cd -- \"$(dirname -- \"${BASH_SOURCE[0]}\")\" && pwd)\"\n"
            "exec python3 \"${PACKAGE_DIR}/install.py\" \"$@\"\n",
            encoding="utf-8",
        )
        (stage / "install.sh").chmod(0o755)
        copy_file(REPO / "install.cmd", stage / "install.cmd")
        # Carry the native (EVEJS Launcher) package so one download covers
        # both choices the installer offers. Build it first.
        native = sorted((REPO / "dist").glob("evejs-playerbots-windows-v*.zip"),
                        key=lambda path: tuple(int(part) for part in path.stem.rsplit("-v", 1)[-1].split(".")))
        if native:
            copy_file(native[-1], stage / native[-1].name)
        else:
            print("Note: no native package in dist/; build it first with build-windows-native.py.")

        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    info = zipfile.ZipInfo((Path(package_name) / path.relative_to(stage)).as_posix(),
                                           date_time=(2026, 1, 1, 0, 0, 0))
                    info.external_attr = (0o755 if path.name == "install.sh" else 0o644) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, path.read_bytes(), compresslevel=9)

    subsystems = sorted({record["subsystem"] for record in manifest["files"].values()})
    print(f"Created {output.relative_to(REPO) if output.is_relative_to(REPO) else output} "
          f"({output.stat().st_size:,} bytes): {len(manifest['files'])} server files in "
          f"{len(subsystems)} subsystems, {len(manifest['addonFiles'])} add-on files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
