#!/usr/bin/env python3
"""Version-pinned installer for the EveJS playerbots add-on bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parent
INTEGRATION_ROOT = PACKAGE_ROOT / "integration" / "server"
ADDON_SOURCE = PACKAGE_ROOT / "addons" / "playerbots"
OVERRIDE_SOURCE = PACKAGE_ROOT / "compose.override.yaml"
STATE_NAME = ".playerbots-install-state.json"
# Add-on files earlier releases installed that this release no longer ships.
# They are moved into the install backup (rollback puts them back) so an
# upgrade does not leave stale files behind. The guides now ship only with the
# package and the repository, not inside the EveJS folder.
OBSOLETE_ADDON_FILES = (
    "addons/playerbots/dashboard/app.js",
    "addons/playerbots/README.md",
    "addons/playerbots/GUIDE.md",
    "addons/playerbots/INSTALLATION.md",
    "addons/playerbots/OPERATIONS.md",
    "addons/playerbots/TROUBLESHOOTING.md",
    "addons/playerbots/LOCAL_DEFENSE.md",
)
# Package-level tools that are not copied into the EveJS folder.
PACKAGE_ONLY_FILES = {
    "addons/playerbots/install.sh",
    "addons/playerbots/install.py",
    "addons/playerbots/rollback.py",
    "addons/playerbots/verify.py",
    "addons/playerbots/compose.override.yaml",
}

# playerbots.py (start, stop, status) ships in addons/playerbots; the
# installer shares its Compose helpers.
sys.path.insert(0, str(ADDON_SOURCE))
sys.path.insert(0, str(PACKAGE_ROOT))
import playerbots as ops  # noqa: E402


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest() -> dict:
    path = PACKAGE_ROOT / "integration" / "manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"The ZIP integration manifest is missing or invalid: {error}") from error


def check_version(target: Path, expected: str) -> None:
    for relative in ("package.json", "server/package.json"):
        path = target / relative
        try:
            actual = json.loads(path.read_text(encoding="utf-8")).get("version")
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Cannot read {relative}: {error}") from error
        if actual != expected:
            raise RuntimeError(f"Unsupported EveJS source version in {relative}: expected {expected}, found {actual!r}.")


def validate_target(target: Path, manifest: dict, replace_conflicts: bool = False,
                    settings: dict | None = None) -> tuple[list[str], list[str]]:
    settings = settings or ops.compose_settings(target)
    if not (target / "docker/entrypoint.sh").is_file():
        raise RuntimeError(f"{target} is not an EveJS source folder (docker/entrypoint.sh is missing).")
    if not (target / settings["baseFile"]).is_file():
        raise RuntimeError(f"{target} has no {settings['baseFile']}. Pass --base-compose for a non-standard Compose setup.")
    check_version(target, str(manifest["evejsVersion"]))
    # Files this installer wrote last time are an ordinary upgrade, not a
    # conflict. Only files changed by hand since then need a decision.
    previous = ops.read_state(target).get("installedSha256") or {}
    conflicts = []
    for relative, record in manifest["files"].items():
        source = INTEGRATION_ROOT / relative
        if not source.is_file():
            raise RuntimeError(f"The package integration source is missing: {relative}.")
        source_hash = sha256(source)
        if source_hash != record.get("sourceSha256") or source_hash != record.get("overlaySha256"):
            raise RuntimeError(f"The package source/overlay checksum failed: {relative}.")
        destination = target / relative
        if destination.exists():
            current = sha256(destination)
            if current not in {record.get("baseSha256"), record["overlaySha256"], previous.get(relative)}:
                conflicts.append(relative)
        elif record.get("baseSha256") is not None:
            conflicts.append(relative)
    if conflicts and not replace_conflicts:
        sample = ", ".join(conflicts[:8])
        more = "" if len(conflicts) <= 8 else f" and {len(conflicts) - 8} more"
        raise RuntimeError(
            "These server files match neither stock EveJS nor the last Playerbots install "
            f"(changed by hand, or missing): {sample}{more}. No files were changed. Review them, then rerun with --replace-conflicts; "
            "the installer backs up each file and rollback.py can restore it."
        )
    return list(manifest["files"]), conflicts


def preflight_compose(target: Path, settings: dict) -> None:
    command = ops.compose_command(target, settings, "config", "--quiet")
    # Before installing, the override is not in the EveJS folder yet; check
    # the package's copy in its place.
    command[command.index(ops.OVERRIDE)] = str(OVERRIDE_SOURCE)
    subprocess.run(command, cwd=target, check=True)


def update_env(path: Path) -> tuple[bool, bool, bool]:
    existed = path.exists()
    original_mode = path.stat().st_mode & 0o777 if existed else None
    lines = path.read_text(encoding="utf-8").splitlines() if existed else []
    keys = {
        "EVEJS_PLAYER_BOTS_ADDON_TOKEN",
        "EVEJS_PLAYER_BOTS_ADDON_MODE",
    }
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() in keys:
            values[key.strip()] = value.strip().strip("\"'")

    token = values.get("EVEJS_PLAYER_BOTS_ADDON_TOKEN", "")
    token_created = len(token) < 32
    if token_created:
        values["EVEJS_PLAYER_BOTS_ADDON_TOKEN"] = secrets.token_hex(32)
    mode_created = "EVEJS_PLAYER_BOTS_ADDON_MODE" not in values
    if mode_created:
        values["EVEJS_PLAYER_BOTS_ADDON_MODE"] = "auto"

    output = []
    emitted: set[str] = set()
    for line in lines:
        stripped = line.strip()
        key = stripped.split("=", 1)[0].strip() if "=" in stripped and not stripped.startswith("#") else ""
        if key == "EVEJS_PLAYER_BOTS_DASHBOARD_PASSWORD":
            continue
        if key in values:
            if key not in emitted:
                output.append(f"{key}={values[key]}")
                emitted.add(key)
        else:
            output.append(line)
    for key in keys:
        if key not in emitted:
            output.append(f"{key}={values[key]}")
    path.write_text("\n".join(output) + "\n", encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)
    return token_created, mode_created


def install(target: Path, overlay_files: list[str], settings: dict, version: str = "") -> tuple[Path, list[str]]:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = target / f".playerbots-install-backup-{stamp}"
    backup.mkdir(mode=0o700)
    managed: list[str] = []
    existed: list[str] = []
    removed: list[str] = []

    def copy_managed(source: Path, relative: str) -> None:
        destination = target / relative
        backup_path = backup / relative
        if destination.is_file():
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(destination, backup_path)
            existed.append(relative)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        managed.append(relative)

    try:
        for relative in overlay_files:
            copy_managed(INTEGRATION_ROOT / relative, relative)

        for source in sorted(ADDON_SOURCE.rglob("*")):
            if not source.is_file() or "__pycache__" in source.parts or source.suffix == ".pyc":
                continue
            relative = source.relative_to(PACKAGE_ROOT).as_posix()
            if relative in PACKAGE_ONLY_FILES:
                continue
            copy_managed(source, relative)
        copy_managed(OVERRIDE_SOURCE, "addons/playerbots/compose.override.yaml")

        for relative in OBSOLETE_ADDON_FILES:
            obsolete = target / relative
            if obsolete.is_file() and relative not in managed:
                backup_path = backup / relative
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(obsolete, backup_path)
                obsolete.unlink()
                removed.append(relative)

        env_path = target / ".env"
        env_existed = env_path.is_file()
        if env_existed:
            shutil.copy2(env_path, backup / ".env")
            existed.append(".env")
        token_created, mode_created = update_env(env_path)
        managed.append(".env")

        state = {
            "installedAt": datetime.now(timezone.utc).isoformat(),
            "addonVersion": version,
            "compose": settings,
            "backupDirectory": backup.name,
            "managedFiles": managed,
            "installedSha256": {relative: sha256(target / relative) for relative in managed},
            "preExistingFiles": existed,
            "removedFiles": removed,
            "envExisted": env_existed,
            "tokenCreated": token_created,
            "modeCreated": mode_created,
        }
        state_path = target / STATE_NAME
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        if os.name != "nt":
            state_path.chmod(0o600)

        ops.run(target, settings, "config", "--quiet")
        return backup, removed
    except Exception:
        for relative in removed:
            saved = backup / relative
            if saved.is_file():
                (target / relative).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(saved, target / relative)
        for relative in reversed(managed):
            destination = target / relative
            saved = backup / relative
            if saved.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(saved, destination)
            elif destination.is_file():
                destination.unlink()
        state_path = target / STATE_NAME
        if state_path.is_file():
            state_path.unlink()
        raise


# ----------------------------------------------------------------- native

NATIVE_MOD_ID = "evejs-playerbots-native"
NATIVE_PROTOCOL = "evejs_launcher_mod_v1"
NATIVE_PACKAGE_HOME = "_local/playerbots-native/package"
NATIVE_STATE = "_local/playerbots-native/overlay-state.json"


def _version_key(path: Path) -> tuple[int, ...]:
    version = path.stem.rsplit("-v", 1)[-1]
    return tuple(int(part) for part in version.split(".") if part.isdigit())


def find_windows_package(explicit: str | None = None) -> Path:
    """The native (EVEJS Launcher) package ZIP: the one given, else the newest
    next to this installer or in dist/, else one built from windows-native/."""
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError(f"Package not found: {path}")
        return path
    candidates = [*PACKAGE_ROOT.glob("evejs-playerbots-windows-v*.zip"),
                  *(PACKAGE_ROOT / "dist").glob("evejs-playerbots-windows-v*.zip")]
    if candidates:
        return max(candidates, key=_version_key)
    builder = PACKAGE_ROOT / "tools" / "playerbots" / "build-windows-native.py"
    if builder.is_file():
        print("Building the native package from this repository...")
        subprocess.run([sys.executable, str(builder)], check=True)
        return find_windows_package()
    raise RuntimeError(
        "The native package is not in this folder. Download evejs-playerbots-windows-v<version>.zip "
        "from the same release and pass it with --package.")


def check_native_target(target: Path, evejs_version: str) -> None:
    version_file = target / "config" / "version.json"
    try:
        actual = json.loads(version_file.read_text(encoding="utf-8-sig")).get("evejsVersion")
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{target} is not a native EveJS folder (cannot read config/version.json: {error}).") from error
    if actual != evejs_version:
        raise RuntimeError(f"This Playerbots release needs EveJS {evejs_version}; {target} is EveJS {actual}.")


def node_major() -> int:
    try:
        output = subprocess.run(["node", "--version"], check=True, text=True, stdout=subprocess.PIPE).stdout
    except FileNotFoundError as error:
        raise RuntimeError("Node.js was not found. Install Node.js 26 or later, the same one EveJS runs on.") from error
    return int(output.strip().lstrip("v").split(".")[0])


def run_native_helper(package_dir: Path, target: Path, action: str) -> str:
    """Run the package's launcher helper the way EVEJS Launcher does."""
    import tempfile
    import uuid
    with tempfile.TemporaryDirectory(prefix="playerbots-native-") as temporary:
        request_path = Path(temporary) / "request.json"
        result_path = Path(temporary) / "result.json"
        request = {
            "protocol": NATIVE_PROTOCOL,
            "requestId": str(uuid.uuid4()),
            "action": action,
            "profile": None,
            "runtime": {"backend": "native", "evejsRoot": str(target)},
            "mod": {"id": NATIVE_MOD_ID},
        }
        request_path.write_text(json.dumps(request), encoding="utf-8")
        completed = subprocess.run(
            ["node", str(package_dir / "helper.cjs"), "--request", str(request_path), "--result", str(result_path)],
            cwd=package_dir, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if not result_path.is_file():
            raise RuntimeError((completed.stderr or completed.stdout or "The native helper did not answer.").strip())
        result = json.loads(result_path.read_text(encoding="utf-8"))
    if not result.get("success"):
        raise RuntimeError(result.get("message") or "The native helper failed.")
    return str(result.get("message") or "Done.")


def _extract_package(zip_path: Path, into: Path) -> Path:
    import zipfile
    with zipfile.ZipFile(zip_path) as archive:
        for name in archive.namelist():
            if name.startswith("/") or ".." in Path(name).parts:
                raise RuntimeError(f"Unsafe path in package: {name}")
        archive.extractall(into)
    roots = [path for path in into.iterdir() if path.is_dir() and (path / "helper.cjs").is_file()]
    if (into / "helper.cjs").is_file():
        return into
    if len(roots) != 1:
        raise RuntimeError(f"{zip_path.name} is not a Playerbots native package.")
    return roots[0]


def _package_version(package_dir: Path) -> str:
    return str(json.loads((package_dir / "evejs-launcher.mod.json").read_text(encoding="utf-8")).get("version") or "")


def native_direct(target: Path, zip_path: Path, evejs_version: str, remove: bool = False) -> None:
    """Install (or remove) the native package without EVEJS Launcher, for
    servers started with StartServer.bat or node directly. Game must be
    stopped. Original files are kept in _local/playerbots-native/stock."""
    check_native_target(target, evejs_version)
    if node_major() < 26:
        raise RuntimeError("Playerbots needs Node.js 26 or later.")
    home = target / NATIVE_PACKAGE_HOME
    state_path = target / NATIVE_STATE
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.is_file() else None

    if remove:
        if not (home / "helper.cjs").is_file():
            raise RuntimeError("No direct native install was found. If you installed through EVEJS Launcher, "
                               "disable or remove Playerbots in its Mods page.")
        print(run_native_helper(home, target, "prepare_remove"))
        return

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    staging = target / f"_local/playerbots-native/package-new-{stamp}"
    staging.mkdir(parents=True)
    try:
        package_dir = _extract_package(zip_path, staging)
        new_version = _package_version(package_dir)
        if state and state.get("version") != new_version:
            # The helper upgrades only from a restored (stock) source tree.
            if not (home / "helper.cjs").is_file():
                raise RuntimeError(
                    f"Playerbots {state.get('version')} was installed through EVEJS Launcher. Disable it there "
                    "(Game stopped), then run this again, or upgrade through the launcher.")
            print(f"Restoring the EveJS files of Playerbots {state.get('version')} before upgrading...")
            print(run_native_helper(home, target, "prepare_remove"))
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if state.get("status") != "stock":
                raise RuntimeError("The previous version did not restore cleanly; nothing else was changed.")
            state_path.rename(state_path.with_name(f"overlay-state-{state.get('version')}-{stamp}.json"))
        if home.exists():
            home.rename(home.with_name(f"package-old-{stamp}"))
        package_dir.rename(home)
        print(run_native_helper(home, target, "install"))
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print("Settings live in config/playerbots-native.json (EVEJS Launcher's Configure page writes the same file).")
    print("Start Game as usual; the bots start with it. Dashboard: http://127.0.0.1:8080")


def native_launcher_steps(zip_path: Path) -> None:
    print("Install it with EVEJS Launcher (1.0.91 or later):")
    print("  1. Stop Game and Market in the launcher, and back up your EveJS folder.")
    print("  2. Open Mods -> Import and choose:")
    print(f"       {zip_path}")
    print("  3. Turn on Playerbots, set it up under Configure, then Start Stack.")
    print("  4. Open http://127.0.0.1:8080")
    if os.name == "nt":
        subprocess.run(["explorer", "/select,", str(zip_path)], check=False)


# ------------------------------------------------------------ interactive

def ask(question: str, choices: dict[str, str], default: str) -> str:
    keys = "/".join(key.upper() if key == default else key for key in choices)
    for key, label in choices.items():
        print(f"  {key}) {label}")
    while True:
        answer = input(f"{question} [{keys}]: ").strip().lower() or default
        if answer in choices:
            return answer
        print(f"Please answer {' or '.join(choices)}.")


def wizard(manifest: dict) -> list[str]:
    """Ask how EveJS runs and turn the answers into installer arguments."""
    print(f"EveJS Playerbots installer (EveJS {manifest['evejsVersion']})\n")
    folder = input("EveJS folder [current folder]: ").strip().strip('"') or "."
    target = Path(folder).expanduser().resolve()
    docker_likely = (target / "compose.yaml").is_file() and shutil.which("docker") is not None
    print("\nHow do you run EveJS?")
    mode = ask("Choose", {
        "1": "Docker Compose",
        "2": "Native: Node.js on this PC (EVEJS Launcher or StartServer.bat)",
    }, "1" if docker_likely else "2")
    if mode == "1":
        args = [str(target), "--docker"]
        try:
            _, conflicts = validate_target(target, manifest, replace_conflicts=True)
        except RuntimeError:
            conflicts = []  # The install itself reports what is wrong with the folder.
        if conflicts:
            print(f"\n{len(conflicts)} server file(s) differ from stock EveJS and from the last Playerbots install:")
            for relative in conflicts[:10]:
                print(f"  {relative}")
            if len(conflicts) > 10:
                print(f"  ... and {len(conflicts) - 10} more")
            replace = ask("Replace them? Each is backed up first, and rollback.py restores them.",
                          {"y": "yes", "n": "no, stop here"}, "n")
            if replace != "y":
                raise RuntimeError("Nothing was changed. Review those files, then run the installer again.")
            args.append("--replace-conflicts")
        print()
        start = ask("Build and start it now?", {"y": "yes", "n": "no, install only"}, "y")
        return [*args, *(["--start"] if start == "y" else [])]
    print("\nHow should the native package be installed?")
    method = ask("Choose", {
        "1": "Through EVEJS Launcher (if you use it): I'll point you to the ZIP to import",
        "2": "Directly now (StartServer.bat setups; stop Game first)",
    }, "1")
    return [str(target), "--native", "--method", "launcher" if method == "1" else "direct"]


# ------------------------------------------------------------------ main

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install or upgrade the EveJS Playerbots add-on. Run it with no options to be asked "
                    "whether EveJS runs in Docker or natively. Re-run the same command to upgrade.")
    parser.add_argument("target", nargs="?", help="EveJS folder")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--docker", action="store_true", help="install for Docker Compose (the default when a folder is given)")
    mode.add_argument("--native", action="store_true", help="install for a native Node.js EveJS (EVEJS Launcher or StartServer.bat)")
    docker = parser.add_argument_group("Docker")
    docker.add_argument("--start", action="store_true",
                        help="after installing, rebuild the EveJS image, start the server, wait until it is healthy, then start the bots")
    docker.add_argument("--dry-run", action="store_true", help="check everything and change nothing")
    docker.add_argument("--replace-conflicts", action="store_true",
                        help="replace server files that were changed by hand, after backing them up")
    docker.add_argument("--base-compose", help="base Compose file, relative to the EveJS folder (default: compose.yaml)")
    docker.add_argument("--compose-file", action="append", default=[], dest="compose_files",
                        help="extra Compose file your setup uses, such as a launcher's (repeatable)")
    docker.add_argument("--project-name", help="Compose project name, for setups that use one")
    docker.add_argument("--env-file", help="Compose env file, for setups that keep it outside the EveJS folder")
    docker.add_argument("--wait-timeout", type=int, default=ops.DEFAULT_WAIT_SECONDS,
                        help="with --start: seconds to wait for the server to become healthy (default 600)")
    native = parser.add_argument_group("Native")
    native.add_argument("--method", choices=["launcher", "direct"], default="launcher",
                        help="launcher: show the ZIP to import in EVEJS Launcher (default); "
                             "direct: install now without the launcher (Game must be stopped)")
    native.add_argument("--remove", action="store_true", help="direct: restore the original EveJS files")
    native.add_argument("--package", help="native package ZIP to use (default: the newest one found)")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        manifest = load_manifest()
        if not argv:
            try:
                argv = wizard(manifest)
            except (EOFError, KeyboardInterrupt):
                print("\nCancelled. Run with --help to see every option.", file=sys.stderr)
                return 2
            print()
        arguments = parser.parse_args(argv)
        target = Path(arguments.target or ".").expanduser().resolve()
        if arguments.native:
            zip_path = find_windows_package(arguments.package)
            if arguments.method == "direct" or arguments.remove:
                native_direct(target, zip_path, str(manifest["evejsVersion"]), arguments.remove)
            else:
                native_launcher_steps(zip_path)
            return 0
        return docker_main(arguments, target, manifest)
    except FileNotFoundError as error:
        if getattr(error, "filename", None) == "docker":
            print("Installation stopped: Docker was not found. Install Docker with the Compose plugin.", file=sys.stderr)
        else:
            print(f"Installation stopped: {error}", file=sys.stderr)
        return 2
    except (OSError, RuntimeError, subprocess.CalledProcessError, KeyError, ValueError) as error:
        print(f"Installation stopped: {error}", file=sys.stderr)
        return 2


def docker_main(arguments: argparse.Namespace, target: Path, manifest: dict) -> int:
    # Settings given now are remembered for playerbots.py and later upgrades.
    settings = ops.compose_settings(target, {
        "baseFile": arguments.base_compose,
        "extraFiles": arguments.compose_files,
        "projectName": arguments.project_name,
        "envFile": arguments.env_file,
    })
    version = ""
    try:
        version = str(json.loads((ADDON_SOURCE / "manifest.json").read_text(encoding="utf-8")).get("version") or "")
    except (OSError, json.JSONDecodeError):
        version = ""
    overlay_files, conflicts = validate_target(target, manifest, arguments.replace_conflicts, settings)
    preflight_compose(target, settings)
    if arguments.dry_run:
        note = f"; {len(conflicts)} changed or missing server files would be backed up and replaced" if conflicts else ""
        print(f"Dry run passed for EveJS {manifest['evejsVersion']} at {target}{note}. Nothing was changed.")
        return 0

    backup, removed = install(target, overlay_files, settings, version)
    print(f"Playerbots {version} installed for EveJS {manifest['evejsVersion']}.".replace("  ", " "))
    if conflicts:
        print(f"Replaced {len(conflicts)} changed or missing server files; the old ones are in the backup.")
    if removed:
        print(f"Moved {len(removed)} file(s) this release no longer uses into the backup.")
    print(f"Backup of every replaced file: {backup}")
    print("The game database was not touched.")
    if arguments.start:
        ops.run(target, settings, "stop", "playerbots-addon", check=False)
        ops.run(target, settings, "build", "init")
        ops.start(target, settings, arguments.wait_timeout, recreate=True)
    else:
        print("Nothing was started. To build and start, run from the EveJS folder:")
        print("  python3 addons/playerbots/playerbots.py rebuild")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
