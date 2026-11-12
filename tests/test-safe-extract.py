import subprocess
import tempfile
import stat
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTRACTOR = ROOT / "tools" / "releases" / "extract-release.py"

class SafeExtractTests(unittest.TestCase):
    def test_extracts_normal_release_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            archive = base / "release.zip"
            dest = base / "out"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("dist/index.html", "ok")
                zf.writestr("release-manifest.json", "{}")
            result = subprocess.run(["python3", str(EXTRACTOR), str(archive), str(dest)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((dest / "dist/index.html").read_text(), "ok")

    def test_rejects_zip_slip(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            archive = base / "evil.zip"
            dest = base / "out"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("../escaped.txt", "evil")
            result = subprocess.run(["python3", str(EXTRACTOR), str(archive), str(dest)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((base / "escaped.txt").exists())

    def test_rejects_windows_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            archive = base / "evil.zip"
            dest = base / "out"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("..\\escaped.txt", "evil")
            result = subprocess.run(["python3", str(EXTRACTOR), str(archive), str(dest)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

    def test_rejects_symlink_member(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            archive = base / "symlink.zip"
            dest = base / "out"
            info = zipfile.ZipInfo("jump")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr(info, "../../etc/passwd")
            result = subprocess.run(["python3", str(EXTRACTOR), str(archive), str(dest)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((dest / "jump").exists())

    def test_rejects_windows_drive_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            archive = base / "drive.zip"
            dest = base / "out"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("C:/Windows/evil.txt", "evil")
            result = subprocess.run(["python3", str(EXTRACTOR), str(archive), str(dest)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

if __name__ == "__main__":
    unittest.main()
