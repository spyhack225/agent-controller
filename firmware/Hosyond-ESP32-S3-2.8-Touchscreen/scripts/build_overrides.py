"""Inject release version and OTA verifier without committing deployment secrets."""

import os

Import("env")  # type: ignore[name-defined]  # PlatformIO/SCons global.


def quoted(value: str) -> str:
    return '\\"' + value.replace("\\", "\\\\").replace('"', '\\"') + '\\"'


definitions = []
firmware_version = os.environ.get("AGENT_CONTROLLER_FIRMWARE_VERSION")
verify_key = os.environ.get("AGENT_CONTROLLER_OTA_VERIFY_KEY")
if firmware_version:
    definitions.append(("BUILD_FIRMWARE_VERSION", quoted(firmware_version)))
if verify_key:
    definitions.append(("BUILD_OTA_MANIFEST_VERIFY_KEY", quoted(verify_key)))
if definitions:
    env.Append(CPPDEFINES=definitions)  # type: ignore[name-defined]
