"""Recipe pictures: from the bytes somebody sent (or a provider served) to three small, clean WebP files.

The input is hostile until proven otherwise (a photo from a phone, an address a web page named, an answer of a recipe site), so
the work is done in a child process of its own (`python -m mahlwerk.imageproc`) with limits the operating system enforces:

  * the size is read from the file header first (imagesize.py): only JPEG, PNG and WebP are accepted, at most `MAX_PIXELS`
    (24 megapixels), and the memory the decoded pixels would need (width x height x bands x bytes per band, read from the opened
    image before anything is decoded) at most `MAX_DECODED_BYTES`; Pillow is then told to open exactly those three formats (`formats=`) and `Image.MAX_IMAGE_PIXELS` is set, so
    a lying header, an SVG, a GIF, an AVIF or an HEIC is refused before any pixel is decoded,
  * only the FIRST frame is read (an animation becomes its first picture),
  * the camera's rotation (EXIF orientation) is applied, then EVERY piece of metadata is dropped: the result is encoded from raw
    pixels into a new image, so no EXIF (GPS position!), no XMP, no ICC profile, no comment and no thumbnail survives; an embedded
    colour profile is DISCARDED, the pixels are read as sRGB (no colour management library, LittleCMS, parses an attacker's profile:
    a smaller attack surface for a slight colour shift of a thumbnail); transparency is laid on the paper colour,
  * three fixed sizes are made, each from the original (not from each other): `l` (long edge 960 px, for the detail), `m` (240 px
    square, the list) and `s` (96 px square, the suggestions); the crops of `m` and `s` are centred,
  * the child runs with REDUCED RIGHTS AND RESOURCES, not in a full sandbox: an address-space limit (768 MB), a CPU-time limit, a
    wall-clock limit set by the parent, no files it could write (RLIMIT_FSIZE 0), very few file descriptors, no new processes
    (RLIMIT_NPROC 0), an empty working directory, no core dumps, every inherited descriptor but stdin/stdout/stderr closed, and, where the
    system allows it without privileges (`os.unshare`, Python 3.12+), its own empty network and user namespace (silently skipped when that
    is not available). It can still read what the user of the server can read: keep Pillow up to date. If the child is killed, crashes in a
    library or times out, the answer is a plain refusal, never an error page and never a hung server,
  * the parent lets ONE child run at a time and at most `MAX_WAITING` more requests wait (a few seconds); every further one is told
    "busy" at once, so a flood of uploads cannot occupy the threads of the server.

The result is WebP only (Pillow here ships libwebp; `check()` tells whether it is there). The file name is derived from the
content (SHA-256 over the three files), never from anything the sender wrote.
"""

import hashlib
import json
import os
import struct
import subprocess
import sys
import threading
from dataclasses import dataclass

from . import imagesize

MAX_PIXELS = 24_000_000
MAX_DECODED_BYTES = 300 * 1024 * 1024  # what the decoded pixels of the first frame may need (a lossless WebP of 1.6 KB can claim a lot)
MAX_WAITING = 2
MAX_INPUT_BYTES = 8 * 1024 * 1024
SIZES = {"l": 960, "m": 240, "s": 96}  # long edge of the detail picture; edge of the square crops
DETAIL_TARGET_BYTES = 150 * 1024  # the detail picture is encoded again with lower quality until it is below this
PAPER = (0xF7, 0xF8, 0xF5)  # the paper colour of the app: transparency is laid on it
MEMORY_LIMIT = 768 * 1024 * 1024  # address space of the child
CPU_SECONDS = 20
WALL_SECONDS = 30.0
WAIT_FOR_TURN = 5.0  # how long a request waits for the one child that may run

_TURN = threading.BoundedSemaphore(1)
_QUEUE = threading.BoundedSemaphore(1 + MAX_WAITING)  # one running and at most MAX_WAITING waiting; the rest is refused without waiting

MAGIC = b"MWI1"
MAX_OUTPUT_BYTES = {"l": 1024 * 1024, "m": 200 * 1024, "s": 64 * 1024}  # far above what the encoder produces; a child that sends more is not trusted
ACCEPTED = ("JPEG", "PNG", "WEBP")
MODEL_EDGE = 1568  # long edge of the picture sent to an image model
MODEL_QUALITY = 85
MAX_MODEL_BYTES = 4 * 1024 * 1024


class ImageRejected(Exception):
    """The picture cannot be used. `kind`: format, too_large, too_many_pixels, broken, busy, unavailable. The text is for the person."""

    TEXTS = {
        "format": "the picture must be a JPEG, PNG or WebP file",
        "too_large": "the picture file is too large",
        "too_many_pixels": f"the picture has too many pixels (at most {MAX_PIXELS // 1_000_000} megapixels)",
        "broken": "the picture could not be read",
        "busy": "another picture is being processed, try again in a moment",
        "unavailable": "pictures cannot be processed on this server (Pillow with WebP support is missing)",
    }

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind

    def __str__(self) -> str:
        return self.TEXTS.get(self.kind, self.kind)


@dataclass(frozen=True)
class Processed:
    hash: str  # 32 hex characters: the name of the files
    width: int  # of the detail picture
    height: int
    files: dict[str, bytes]  # size key -> WebP bytes


def check() -> bool:
    """Pillow with WebP, JPEG and PNG support is installed."""
    try:
        from PIL import features

        return all(features.check(name) for name in ("webp", "jpg", "zlib"))
    except Exception:  # noqa: BLE001 - not installed or broken
        return False


# ---- in the parent ----


def process(data: bytes) -> Processed:
    """The three variants of the picture in `data`, else ImageRejected. Blocks (call it from a thread, not from the event loop)."""
    return _parse(_run_child(data, "recipe"))


def for_model(data: bytes) -> bytes:
    """The picture as ONE clean JPEG for an image model: long edge at most `MODEL_EDGE`, no metadata at all (no EXIF, so no GPS
    position), the camera's rotation applied. Same child process and limits as `process`. Blocks (call it from a thread)."""
    blob = _run_child(data, "model")
    if blob[:2] != b"\xff\xd8":
        raise ImageRejected("broken")
    size = imagesize.dimensions(blob)
    if size is None or not (1 <= max(size) <= MODEL_EDGE) or len(blob) > MAX_MODEL_BYTES:
        raise ImageRejected("broken")
    return blob


def _run_child(data: bytes, mode: str) -> bytes:
    """The output of the child for `mode` (`recipe`: the three WebP files, `model`: one JPEG), else ImageRejected."""
    if len(data) > MAX_INPUT_BYTES:
        raise ImageRejected("too_large")
    size = imagesize.dimensions(data)
    if size is None or size[0] < 1 or size[1] < 1:
        raise ImageRejected("format")
    if size[0] * size[1] > MAX_PIXELS:
        raise ImageRejected("too_many_pixels")
    if not _QUEUE.acquire(blocking=False):
        raise ImageRejected("busy")
    try:
        if not _TURN.acquire(timeout=WAIT_FOR_TURN):
            raise ImageRejected("busy")
        try:
            try:
                done = subprocess.run(
                    [sys.executable, "-I", "-m", "mahlwerk.imageproc"], input=data, capture_output=True, timeout=WALL_SECONDS,
                    env={"PATH": os.environ.get("PATH", ""), "MAHLWERK_IMAGE_CHILD": "1", "MAHLWERK_IMAGE_MODE": mode}, check=False, close_fds=True, cwd="/",
                )
            except subprocess.TimeoutExpired:
                raise ImageRejected("broken") from None
            except OSError:
                raise ImageRejected("unavailable") from None
        finally:
            _TURN.release()
    finally:
        _QUEUE.release()
    if done.returncode != 0:
        kind = done.stderr.decode("ascii", "replace").strip().splitlines()[-1:] or ["broken"]
        raise ImageRejected(kind[0] if kind[0] in ImageRejected.TEXTS else "broken")
    return done.stdout


def _parse(blob: bytes) -> Processed:
    try:
        if blob[:4] != MAGIC:
            raise ValueError
        head_len = struct.unpack(">I", blob[4:8])[0]
        head = json.loads(blob[8:8 + head_len])
        offset, files = 8 + head_len, {}
        width, height = int(head["width"]), int(head["height"])
        for key in SIZES:
            length = int(head["lengths"][key])
            files[key] = blob[offset:offset + length]
            if len(files[key]) != length or length < 12 or files[key][:4] != b"RIFF" or files[key][8:12] != b"WEBP":
                raise ValueError
            offset += length
            # the child's answer is checked again with the header parser: the sizes it claims are the sizes the files have, and they are the ones we make
            got = imagesize.dimensions(files[key])
            want = (width, height) if key == "l" else (SIZES[key], SIZES[key])
            if got != want or length > MAX_OUTPUT_BYTES[key]:
                raise ValueError
        if offset != len(blob) or not (1 <= width <= SIZES["l"] and 1 <= height <= SIZES["l"]) or max(width, height) > SIZES["l"]:
            raise ValueError
        digest = hashlib.sha256(b"".join(files[k] for k in SIZES)).hexdigest()[:32]  # over all three files: they belong together
        return Processed(digest, int(head["width"]), int(head["height"]), files)
    except (ValueError, KeyError, TypeError, struct.error):
        raise ImageRejected("broken") from None


# ---- in the child ----


def _harden() -> None:
    """Reduce what the child may do (see the module text). Everything is best effort and skipped where the system has no such thing:
    this is resource limiting and reduced rights, not a complete sandbox."""
    try:
        os.closerange(3, 1024)  # nothing inherited but stdin, stdout, stderr
    except OSError:
        pass
    try:
        import tempfile

        empty = tempfile.mkdtemp(prefix="mwimg-")
        os.chdir(empty)  # an empty working directory, removed at once (the child then stands in a deleted one)
        os.rmdir(empty)
    except OSError:
        pass
    unshare = getattr(os, "unshare", None)  # Python 3.12+, Linux: an own empty network (and user) namespace when allowed without privileges
    if unshare is not None:
        try:
            unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET)
        except (OSError, AttributeError):
            pass
    try:
        import resource

        for name, value in (("RLIMIT_AS", MEMORY_LIMIT), ("RLIMIT_CPU", CPU_SECONDS), ("RLIMIT_CORE", 0), ("RLIMIT_FSIZE", 0),
                            ("RLIMIT_NOFILE", 8), ("RLIMIT_NPROC", 0)):
            if hasattr(resource, name):
                try:
                    resource.setrlimit(getattr(resource, name), (value, value))
                except (ValueError, OSError):
                    pass
    except ImportError:  # no `resource` (Windows): the wall-clock limit of the parent remains
        pass


def _flatten(img):
    """RGB pixels, transparency on the paper colour. An embedded colour profile is not used (see the module text): the pixels count as sRGB."""
    from PIL import Image

    if img.mode in ("I;16", "I;16L", "I;16B", "I"):  # 16 bit grey: scale down to 8 bit
        img = img.point(lambda v: v / 256).convert("L")
    transparent = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
    if transparent:
        img = img.convert("RGBA")
    elif img.mode != "RGB":
        img = img.convert("RGB")  # CMYK without a profile, grey, palette
    if img.mode == "RGBA":
        ground = Image.new("RGBA", img.size, PAPER + (255,))
        ground.alpha_composite(img)
        img = ground.convert("RGB")
    return img


def _encode(img, quality: int) -> bytes:
    import io

    from PIL import Image

    clean = Image.frombytes("RGB", img.size, img.tobytes())  # a new image from the pixels alone: no metadata can come along
    out = io.BytesIO()
    clean.save(out, "WEBP", quality=quality, method=4)
    return out.getvalue()


def _open_upright(data: bytes, draft: int):
    """The first frame as flat RGB pixels, turned the way the camera meant it. `draft`: a JPEG may be decoded this much smaller."""
    import io

    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        img = Image.open(io.BytesIO(data), formats=list(ACCEPTED))
    except Exception:  # noqa: BLE001
        raise ImageRejected("format") from None
    if img.format not in ACCEPTED:
        raise ImageRejected("format")
    if img.width * img.height > MAX_PIXELS or img.width < 1 or img.height < 1:
        raise ImageRejected("too_many_pixels")
    bytes_per_band = 2 if img.mode.startswith("I;16") else 4 if img.mode in ("I", "F") else 1
    if img.width * img.height * len(img.getbands()) * bytes_per_band > MAX_DECODED_BYTES:  # a JPEG is decoded smaller below, but be strict about the rest
        if img.format != "JPEG":
            raise ImageRejected("too_many_pixels")
    try:
        img.seek(0)  # an animation: its first frame
        if img.format == "JPEG":
            img.draft("RGB", (draft, draft))  # the decoder may scale down while reading: far less memory and time
        orientation = img.getexif().get(0x0112, 1)
        img.load()
        img = _flatten(img)
    except ImageRejected:
        raise
    except Exception:  # noqa: BLE001 - truncated, corrupt, odd modes
        raise ImageRejected("broken") from None
    turn = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180, 4: Image.Transpose.FLIP_TOP_BOTTOM,
            5: Image.Transpose.TRANSPOSE, 6: Image.Transpose.ROTATE_270, 7: Image.Transpose.TRANSVERSE, 8: Image.Transpose.ROTATE_90}.get(orientation)
    if turn is not None:
        img = img.transpose(turn)
    return img


def _model_jpeg(data: bytes) -> bytes:
    import io

    from PIL import Image

    img = _open_upright(data, MODEL_EDGE * 2)
    img.thumbnail((MODEL_EDGE, MODEL_EDGE), Image.Resampling.LANCZOS)
    clean = Image.frombytes("RGB", img.size, img.tobytes())  # a new image from the pixels alone: no metadata can come along
    out = io.BytesIO()
    clean.save(out, "JPEG", quality=MODEL_QUALITY, optimize=True)
    return out.getvalue()


def _variants(data: bytes) -> tuple[dict[str, bytes], tuple[int, int]]:
    from PIL import Image, ImageOps

    img = _open_upright(data, SIZES["l"] * 2)
    files: dict[str, bytes] = {}
    big = img.copy()
    big.thumbnail((SIZES["l"], SIZES["l"]), Image.Resampling.LANCZOS)
    for quality in (82, 74, 66, 58, 50):
        files["l"] = _encode(big, quality)
        if len(files["l"]) <= DETAIL_TARGET_BYTES:
            break
    for key in ("m", "s"):
        edge = SIZES[key]
        files[key] = _encode(ImageOps.fit(img, (edge, edge), Image.Resampling.LANCZOS, centering=(0.5, 0.5)), 78)
    return files, big.size


def _main() -> int:
    if os.environ.get("MAHLWERK_IMAGE_CHILD") != "1":
        sys.stderr.write("broken\n")
        return 2
    import PIL.Image  # noqa: F401 - imported before the limits (the child may open no more files afterwards)
    import PIL.ImageOps  # noqa: F401
    import PIL.WebPImagePlugin, PIL.JpegImagePlugin, PIL.PngImagePlugin  # noqa: F401,E401
    _harden()
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    try:
        if len(data) > MAX_INPUT_BYTES:
            raise ImageRejected("too_large")
        size = imagesize.dimensions(data)
        if size is None:
            raise ImageRejected("format")
        if size[0] * size[1] > MAX_PIXELS:
            raise ImageRejected("too_many_pixels")
        if os.environ.get("MAHLWERK_IMAGE_MODE") == "model":
            out = _model_jpeg(data)
            sys.stdout.buffer.write(out)
            sys.stdout.buffer.flush()
            return 0
        files, (width, height) = _variants(data)
        head = json.dumps({"width": width, "height": height, "lengths": {k: len(v) for k, v in files.items()}}).encode()
        out = MAGIC + struct.pack(">I", len(head)) + head + b"".join(files[k] for k in SIZES)
    except ImageRejected as exc:
        sys.stderr.write(exc.kind + "\n")
        return 2
    except (MemoryError, Exception):  # noqa: BLE001 - whatever a hostile file does: a plain refusal
        sys.stderr.write("broken\n")
        return 2
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(_main())
