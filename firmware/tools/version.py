# Setzt FIRMWARE_VERSION beim Bauen: die ersten 10 Zeichen des letzten Commits,
# der firmware/ geaendert hat. Mit nicht eingecheckten Aenderungen haengt
# "+lokal" dran, so eine Firmware ersetzt das Board nie von selbst.
# Ohne git: "unbekannt".
import os
import subprocess

Import("env")  # noqa: F821, von PlatformIO bereitgestellt

projekt = env.subst("$PROJECT_DIR")  # noqa: F821


def git(*argumente):
    try:
        return subprocess.check_output(
            ["git", *argumente], cwd=projekt, stderr=subprocess.DEVNULL, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


version = git("log", "-1", "--format=%H", "--", ".")[:10] or "unbekannt"
if version != "unbekannt" and git("status", "--porcelain", "--", "."):
    version += "+lokal"

env.Append(CPPDEFINES=[("FIRMWARE_VERSION", env.StringifyMacro(version))])  # noqa: F821

# Fuer den Workflow, der die Firmware mit dem Hub ausrollt
ordner = env.subst("$BUILD_DIR")  # noqa: F821
os.makedirs(ordner, exist_ok=True)
with open(os.path.join(ordner, "version.txt"), "w", encoding="utf-8") as datei:
    datei.write(version + "\n")
print(f"Firmware-Version: {version}")
