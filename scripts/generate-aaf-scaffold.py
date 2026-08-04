/**
 * Regenerate the patchable AAF scaffold used by browser-side AAF export.
 * Run: python3 scripts/generate-aaf-scaffold.py
 */
from __future__ import annotations

import json
import os
from pathlib import Path

import aaf2
from aaf2.auid import AUID

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "aaf"

MAX_CLIPS = 64
EDIT_RATE = 30
MEDIA_FRAMES = 10_000_000
MARKER_URL = "file:///RESCRIPT_MEDIA_PLACEHOLDER"
MARKER_NAME = "RESCRIPT_MEDIA_PLACEHOLDER"  # 26 chars — keep in sync with lib/aaf/patchAaf.ts


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "scaffold.aaf"

    with aaf2.open(str(out), "w") as f:
        src = f.create.SourceMob()
        src.name = MARKER_NAME
        desc = f.create.ImportDescriptor()
        loc = f.create.NetworkLocator()
        loc["URLString"].value = MARKER_URL
        desc["Locator"].value = [loc]
        src.descriptor = desc
        f.content.mobs.append(src)

        pic = src.create_picture_slot(EDIT_RATE)
        pic.segment.length = MEDIA_FRAMES
        snd = src.create_sound_slot(EDIT_RATE)
        snd.segment.length = MEDIA_FRAMES

        master = f.create.MasterMob()
        master.name = MARKER_NAME
        f.content.mobs.append(master)
        mps = master.create_timeline_slot(EDIT_RATE)
        mps.segment = src.create_source_clip(
            slot_id=pic.slot_id, start=0, length=MEDIA_FRAMES, media_kind="Picture"
        )
        mss = master.create_timeline_slot(EDIT_RATE)
        mss.segment = src.create_source_clip(
            slot_id=snd.slot_id, start=0, length=MEDIA_FRAMES, media_kind="Sound"
        )

        comp = f.create.CompositionMob("Rescript Edit")
        comp["UsageCode"].value = AUID("0d010102-0101-0700-060e-2b3404010101")
        f.content.mobs.append(comp)

        for kind, master_slot in [("Picture", mps), ("Sound", mss)]:
            seq = f.create.Sequence(media_kind=kind)
            for i in range(MAX_CLIPS):
                seq.components.append(
                    master.create_source_clip(
                        slot_id=master_slot.slot_id,
                        start=i,
                        length=1,
                        media_kind=kind,
                    )
                )
            slot = comp.create_timeline_slot(EDIT_RATE)
            slot.segment = seq

        meta = {
            "maxClips": MAX_CLIPS,
            "editRate": EDIT_RATE,
            "markerUrl": MARKER_URL,
            "markerName": MARKER_NAME,
            "sourceMobId": str(src.mob_id),
            "masterMobId": str(master.mob_id),
            "compMobId": str(comp.mob_id),
            "masterPictureSlot": mps.slot_id,
            "masterSoundSlot": mss.slot_id,
        }

    with aaf2.open(str(out), "r") as f:
        tops = [m.name for m in f.content.toplevel()]
        if tops != ["Rescript Edit"]:
            raise SystemExit(f"expected TopLevel composition, got {tops!r}")

    meta_path = OUT_DIR / "scaffold.meta.json"
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {out} ({os.path.getsize(out)} bytes)")
    print(f"wrote {meta_path}")


if __name__ == "__main__":
    main()
