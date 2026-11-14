"""Compose a source-cited preview around the presenter's original recording."""

import json
import math
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import NamedTuple


MAX_SECONDS = 60
MAX_CHAPTERS = 7
INPUT_FORMATS = {".mp4": "mov", ".mov": "mov", ".webm": "matroska"}


class ChapterCue(NamedTuple):
    path: Path
    start: float
    end: float
    page: int
    motion: bool


def _run(command, timeout):
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8",
            errors="replace", check=True, timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"{Path(command[0]).name} was not found.") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{Path(command[0]).name} took too long.") from exc
    except subprocess.CalledProcessError as exc:
        details = (exc.stderr or "").strip()
        raise RuntimeError(details[-1400:] or "Video processing failed.") from exc
    return result.stdout


def _recording_info(video_path, ffprobe, input_format):
    raw = _run([
        ffprobe, "-v", "error", "-protocol_whitelist", "file",
        "-f", input_format, "-select_streams", "v:0",
        "-show_entries", "format=duration:stream=width,height,duration",
        "-of", "json", str(video_path),
    ], timeout=15)
    info = json.loads(raw)
    streams = info.get("streams", [])
    if not streams:
        raise ValueError("The recording has no video stream.")
    video = streams[0]
    if not all(0 < video.get(axis, 0) <= 4096 for axis in ("width", "height")):
        raise ValueError("Use a recording at up to 4K resolution.")
    duration = video.get("duration") or info.get("format", {}).get("duration")
    if duration in (None, "N/A"):
        raise ValueError("The recording does not report a duration.")
    seconds = float(duration)
    if not math.isfinite(seconds) or not 0.25 <= seconds <= MAX_SECONDS:
        raise ValueError(f"Use a recording between 0.25 and {MAX_SECONDS} seconds.")
    return seconds


def _chapter_cues(chapters, duration):
    if len(chapters) > MAX_CHAPTERS:
        raise ValueError(f"The preview supports up to {MAX_CHAPTERS} chapters.")

    cues = []
    for index, chapter in enumerate(chapters):
        motion_path = Path(chapter["motion_path"]).resolve() if chapter.get("motion_path") else None
        still_path = Path(chapter["asset_path"]).resolve() if chapter.get("asset_path") else None
        motion = bool(motion_path and motion_path.suffix.lower() == ".mp4" and motion_path.is_file())
        path = motion_path if motion else still_path
        if not path or (not motion and (path.suffix.lower() != ".png" or not path.is_file())):
            continue
        start = index * duration / len(chapters)
        end = (index + 1) * duration / len(chapters)
        page = chapter.get("page", index + 1)
        if type(page) is not int or page < 1:
            page = index + 1
        cues.append(ChapterCue(path, start, end, page, motion))
    return cues


def _fit(width, height):
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:"
        "force_divisible_by=2,setsar=1"
    )


def _composition(cues):
    full_camera = (
        f"{_fit(1280, 720)},pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x131d23"
    )
    if not cues:
        return f"[0:v:0]fps=24,{full_camera}[out]"

    filters = [
        "[0:v:0]fps=24,split=2[camera][inset]",
        f"[camera]{full_camera}[view0]",
        f"[inset]{_fit(324, 220)},pad=332:228:(ow-iw)/2:(oh-ih)/2:color=0xe9b779[presenter]",
    ]
    conditions = []
    for index, cue in enumerate(cues, start=1):
        condition = f"gte(t,{cue.start:.6f})*lt(t,{cue.end:.6f})"
        conditions.append(condition)
        source_timing = f"setpts=PTS-STARTPTS+{cue.start:.6f}/TB," if cue.motion else ""
        label = f"SOURCE PDF  /  PAGE {cue.page}"
        if cue.motion:
            label += "  /  ILLUSTRATIVE MODEL"
        filters.extend([
            (
                f"[{index}:v:0]{source_timing}{_fit(848, 590)},"
                "pad=1280:720:x=36+(848-iw)/2:y=32+(590-ih)/2:color=0x131d23,"
                f"drawtext=text='{label}':"
                f"fontsize=22:fontcolor=0xe9b779:x=36:y=654[landmark{index}]"
            ),
            f"[view{index - 1}][landmark{index}]overlay=enable='{condition}'[view{index}]",
        ])
    active = "+".join(conditions)
    filters.append(
        f"[view{len(cues)}][presenter]overlay=x=912:y=454:enable='{active}'[out]"
    )
    return ";".join(filters)


def render_preview(video_path, chapters, output_path, *, ffmpeg="ffmpeg", ffprobe="ffprobe"):
    """Render chapter models and images, with a camera inset and original audio."""
    video_path = Path(video_path).resolve()
    output_path = Path(output_path).resolve()
    input_format = INPUT_FORMATS.get(video_path.suffix.lower())
    if input_format is None or not video_path.is_file():
        raise ValueError("Provide a valid MP4, MOV or WebM recording.")
    if output_path == video_path or output_path.suffix.lower() != ".mp4":
        raise ValueError("Export to a different file ending in .mp4.")
    duration = _recording_info(video_path, ffprobe, input_format)
    cues = _chapter_cues(chapters, duration)
    command = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-protocol_whitelist", "file", "-f", input_format, "-i", str(video_path),
    ]
    for cue in cues:
        command.extend(["-protocol_whitelist", "file"])
        if cue.motion:
            command.extend(["-stream_loop", "-1"])
        command.extend(["-f", "mov" if cue.motion else "png_pipe", "-i", str(cue.path)])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".render-", dir=output_path.parent) as temp_dir:
        rendered = Path(temp_dir) / "preview.mp4"
        _run(command + [
            "-filter_complex_threads", "2", "-filter_complex", _composition(cues),
            "-map", "[out]", "-map", "0:a:0?", "-t", f"{duration:.6f}",
            "-c:v", "libx264", "-threads:v", "4", "-preset", "veryfast",
            "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac",
            "-b:a", "128k", "-movflags", "+faststart", str(rendered),
        ], timeout=120)
        rendered.replace(output_path)
    return output_path


def main():
    if len(sys.argv) != 4:
        print("Usage: python video_render.py RECORDING CHAPTERS_JSON OUTPUT_MP4", file=sys.stderr)
        return 2
    recording, chapter_file, output = sys.argv[1:]
    try:
        chapters = json.loads(Path(chapter_file).read_text(encoding="utf-8"))
        if not isinstance(chapters, list) or any(not isinstance(item, dict) for item in chapters):
            raise ValueError("Chapters must be a JSON array of objects.")
        render_preview(
            recording, chapters, output,
            ffmpeg=os.environ.get("FFMPEG", "ffmpeg"),
            ffprobe=os.environ.get("FFPROBE", "ffprobe"),
        )
    except (OSError, RuntimeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
