"""
Regenerate the patchable .blend scaffold used by browser-side Blender export.
Run with Blender 5.2 and ffmpeg on PATH, from an empty home and temp folder
(Blender saves the file browser's folder and stale path bytes into the file):
  export HOME=$(mktemp -d) TMPDIR=$(mktemp -d)
  blender -b --factory-startup --python scripts/generate-blend-scaffold.py

The scaffold is Blender's Video Editing startup file (so the export opens in
the Video Editing workspace) holding one movie strip and one sound strip.
lib/blend/writeBlend.ts clones those strips once per keep range and repoints
them at the real media. Saved uncompressed so the browser can patch it.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "blend"

MOVIE_STRIP = "RESCRIPT_V"  # keep in sync with lib/blend/writeBlend.ts
SOUND_STRIP = "RESCRIPT_A"
PLACEHOLDER = "RESCRIPT_MEDIA_PLACEHOLDER.mp4"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        media = Path(tmp) / PLACEHOLDER
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y",
                "-f", "lavfi", "-i", "color=black:s=64x64:r=30:d=1",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-t", "1", "-c:v", "libx264", "-c:a", "aac", "-shortest",
                str(media),
            ],
            check=True,
        )

        bpy.ops.wm.read_homefile(app_template="Video_Editing")
        scene = bpy.context.scene
        ed = scene.sequence_editor_create()
        for strip in list(ed.strips_all):
            ed.strips.remove(strip)

        movie = ed.strips.new_movie(MOVIE_STRIP, str(media), channel=2, frame_start=1)
        sound = ed.strips.new_sound(SOUND_STRIP, str(media), channel=1, frame_start=1)
        # 25% proxies: preview plays from small proxy files once Blender has
        # built them (Strip ▸ Movie Strip ▸ Rebuild Proxy and Timecode Indices).
        movie.use_proxy = True
        movie.proxy.build_25 = True
        for strip in (movie, sound):
            strip.select = False
        ed.active_strip = None
        movie.filepath = "//" + PLACEHOLDER
        sound.sound.filepath = "//" + PLACEHOLDER

        for screen in bpy.data.screens:
            for area in screen.areas:
                for space in area.spaces:
                    if space.type == "SEQUENCE_EDITOR":
                        space.proxy_render_size = "PROXY_25"

        out = OUT_DIR / "scaffold.blend"
        bpy.context.preferences.filepaths.use_file_compression = False
        bpy.context.preferences.filepaths.save_version = 0  # no .blend1 backup
        bpy.ops.wm.save_as_mainfile(
            filepath=str(out), compress=False, relative_remap=False, copy=True
        )

    meta = {
        "blenderVersion": bpy.app.version_string,
        "movieStrip": MOVIE_STRIP,
        "soundStrip": SOUND_STRIP,
    }
    (OUT_DIR / "scaffold.meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {out}")


main()
