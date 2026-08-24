"""Inject release-only values without writing secrets into controller_config.h.

PlatformIO runs this as a SCons pre-script. Normal developer builds are unchanged;
manufacturing/release jobs opt in with process environment variables.
"""

import os

Import("env")  # type: ignore[name-defined]  # Provided by PlatformIO/SCons.


def quoted(value: str) -> str:
    return '\\"' + value.replace("\\", "\\\\").replace('"', '\\"') + '\\"'


definitions = []
firmware_version = os.environ.get("AGENT_CONTROLLER_FIRMWARE_VERSION")
verify_key = os.environ.get("AGENT_CONTROLLER_OTA_VERIFY_KEY")
rollback_drill = os.environ.get("AGENT_CONTROLLER_OTA_ROLLBACK_DRILL")

if firmware_version:
    definitions.append(("BUILD_FIRMWARE_VERSION", quoted(firmware_version)))
if verify_key:
    definitions.append(("BUILD_OTA_MANIFEST_VERIFY_KEY", quoted(verify_key)))
if rollback_drill in {"0", "1"}:
    definitions.append(("BUILD_OTA_ROLLBACK_DRILL", rollback_drill))

if definitions:
    env.Append(CPPDEFINES=definitions)  # type: ignore[name-defined]
