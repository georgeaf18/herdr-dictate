"""Live dictation helper for the Herdr `dictate` mod.

Run with parakeet-mlx's own Python, which also needs onnxruntime:
    uv tool install parakeet-mlx --with onnxruntime
    ~/.local/share/uv/tools/parakeet-mlx/bin/python live.py <base> <ffmpeg> <model>

How it transcribes (committed + open text, like Orca's dictation):
- Silero VAD (models/silero_vad.onnx) marks speech in 32 ms frames, so pauses are
  found by voice, not loudness.
- The *open* audio is everything not yet committed. While you talk it is
  re-transcribed about twice a second; that's the only text that can still change.
- At a short pause, every finished sentence but the last is committed: it never
  changes again. The last sentence stays open and keeps its audio, so if you were
  only pausing mid-sentence, the model hears the whole sentence once you go on and
  fixes it ("I made a. Stop" becomes "I made a stop").
- After a long pause, or when you stop, the open sentence is committed too.

Files: <base>.partial (JSON {committed, open}, for the popup), <base>.txt (final).
SIGINT (the mod's stop): commit everything, write <base>.txt, exit 0.
SIGTERM (cancel): exit without writing. It also cancels itself if the mod goes
away without saying so, and stops by itself after MAX_RUN.
"""
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

RATE = 16000
FRAME = 512             # samples per VAD frame (32 ms), what Silero expects at 16 kHz
FRAME_S = FRAME / RATE
SPEECH_ON = 0.5         # VAD probability that starts speech
SPEECH_OFF = 0.35       # ...and below which it counts as quiet (hysteresis)
PAUSE = 0.5             # quiet that ends a phrase: commit finished sentences
LONG_PAUSE = 1.8        # quiet that ends a thought: commit the open sentence too
REFRESH = 0.5           # seconds between re-transcriptions of the open audio
LEAD_IN = 0.3           # audio kept before speech starts, so first sounds aren't clipped
SENTENCE_LEAD = 0.15    # audio kept before an open sentence's first word
MAX_OPEN = 25.0         # open audio is never longer than this
MAX_RUN = 600.0         # the mod stops at 10 min (exec's cap); past that, stop anyway

base, ffmpeg, model_id = sys.argv[1], sys.argv[2], sys.argv[3]
state = {"stop": False, "cancel": False}
signal.signal(signal.SIGINT, lambda *_: state.update(stop=True))
signal.signal(signal.SIGTERM, lambda *_: state.update(stop=True, cancel=True))

rec = subprocess.Popen(
    [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
     "-f", "avfoundation", "-i", ":default",
     "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
)
frames: "queue.Queue[np.ndarray | None]" = queue.Queue()


def orphaned() -> bool:
    """True once the mod is gone.

    HACK: Herdr doesn't always end an exec'd process when a mod's view goes away
    (a reload after editing main.js, a crash), so close() never sends SIGTERM and
    this kept recording for over an hour. Our parent is the mod's `sh` wrapper;
    when Herdr lets go of it, it's re-parented to launchd (pid 1).
    """
    try:
        out = subprocess.run(["ps", "-o", "ppid=", "-p", str(os.getppid())],
                             capture_output=True, text=True, timeout=2).stdout.strip()
        return os.getppid() == 1 or out in ("", "1")
    except Exception:
        return False


def watchdog():
    started = time.monotonic()
    while not state["stop"]:
        time.sleep(1)
        if orphaned():
            state.update(stop=True, cancel=True)
        elif time.monotonic() - started > MAX_RUN:
            state.update(stop=True)


def read_mic():
    while True:
        data = rec.stdout.read(FRAME * 2)  # s16 = 2 bytes per sample
        if len(data) < FRAME * 2:
            break
        frames.put(np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0)
    frames.put(None)


threading.Thread(target=read_mic, daemon=True).start()
threading.Thread(target=watchdog, daemon=True).start()

# Models load while the mic is already being buffered, so nothing said is lost.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
import mlx.core as mx  # noqa: E402
import onnxruntime  # noqa: E402
from parakeet_mlx import from_pretrained  # noqa: E402
from parakeet_mlx.audio import get_logmel  # noqa: E402

try:
    model = from_pretrained(model_id)
except Exception:
    # Offline on purpose: a 2.5 GB download shouldn't start silently behind the popup.
    sys.stderr.write(f"Speech model not downloaded. Run once: HF_HUB_DISABLE_XET=1 ~/.local/share/uv/tools/parakeet-mlx/bin/hf download {model_id}\n")
    rec.terminate()
    sys.exit(1)


class Vad:
    """Silero VAD v5 over ONNX: one speech probability per 512-sample frame."""

    CONTEXT = 64  # samples of the previous frame Silero expects in front of each one

    def __init__(self, path: Path):
        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = opts.intra_op_num_threads = 1
        self.session = onnxruntime.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(self.CONTEXT, dtype=np.float32)
        self.sr = np.array(RATE, dtype=np.int64)

    def __call__(self, frame: np.ndarray) -> float:
        x = np.concatenate([self.context, frame])[None, :]
        out, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": self.sr})
        self.context = frame[-self.CONTEXT:]
        return float(out[0][0])


vad = Vad(Path(__file__).parent / "models" / "silero_vad.onnx")


def transcribe(audio: np.ndarray):
    mel = get_logmel(mx.array(audio), model.preprocessor_config)
    return model.generate(mel)[0]


def join(*parts: str) -> str:
    return " ".join(p.strip() for p in parts if p and p.strip())


def write_atomic(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


committed = ""
open_text = ""
open_audio = np.zeros(0, dtype=np.float32)  # audio behind open_text (and anything newer)
transcribed_len = 0                          # how much of open_audio open_text covers
lead_in: list = []
in_speech = False
quiet = 0.0
since_refresh = 0.0
shown = None


def publish():
    global shown
    snap = (committed, open_text)
    if snap != shown:
        write_atomic(base + ".partial", json.dumps({"committed": committed, "open": open_text}))
        shown = snap


def refresh():
    """Re-transcribe the open audio, without committing anything."""
    global open_text, transcribed_len
    if len(open_audio):
        open_text = transcribe(open_audio).text.strip()
    transcribed_len = len(open_audio)
    publish()


def settle():
    """At a pause: commit every finished sentence but the last; keep the last one open."""
    global committed, open_text, open_audio, transcribed_len
    if not len(open_audio):
        return
    sentences = transcribe(open_audio).sentences
    if len(sentences) > 1:
        committed = join(committed, *(s.text for s in sentences[:-1]))
        cut = max(0, int((sentences[-1].start - SENTENCE_LEAD) * RATE))
        open_audio = open_audio[cut:]
    open_text = sentences[-1].text.strip() if sentences else ""
    transcribed_len = len(open_audio)
    if len(open_audio) / RATE > MAX_OPEN:  # one endless sentence: let it go
        commit_all()
    publish()


def commit_all():
    """Commit the open sentence too (long pause, too long, or stop)."""
    global committed, open_text, open_audio, transcribed_len
    if transcribed_len != len(open_audio):
        refresh()
    committed = join(committed, open_text)
    open_text, open_audio, transcribed_len = "", np.zeros(0, dtype=np.float32), 0
    publish()


while True:
    if state["stop"] and rec.poll() is None:
        rec.terminate()
    try:
        frame = frames.get(timeout=0.2)
    except queue.Empty:
        continue
    if frame is None:
        break
    if state["cancel"]:
        continue

    p = vad(frame)
    if not in_speech:
        if p >= SPEECH_ON:
            in_speech, quiet, since_refresh = True, 0.0, 0.0
            open_audio = np.concatenate([open_audio, *lead_in, frame])
            lead_in = []
        else:
            lead_in = (lead_in + [frame])[-int(LEAD_IN / FRAME_S):]
            if len(open_audio):
                quiet += FRAME_S
                if quiet >= LONG_PAUSE:
                    commit_all()
        continue

    open_audio = np.concatenate([open_audio, frame])
    quiet = quiet + FRAME_S if p < SPEECH_OFF else 0.0
    if quiet >= PAUSE:
        in_speech = False  # quiet keeps counting toward LONG_PAUSE from here
        settle()
        continue
    if len(open_audio) / RATE > MAX_OPEN:
        settle()
        continue
    since_refresh += FRAME_S
    # Only when the reader isn't behind, so a slow pass never makes the text lag more.
    if since_refresh >= REFRESH and frames.qsize() < 4:
        since_refresh = 0.0
        refresh()

if state["cancel"]:
    sys.exit(130)
if not state["stop"]:
    # ffmpeg ended without being asked: the mic failed or access was denied.
    sys.stderr.write("The microphone stopped. Check System Settings > Privacy & Security > Microphone.\n")
    sys.exit(1)

commit_all()
write_atomic(base + ".txt", committed)
