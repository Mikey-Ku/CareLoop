"""Camera check call-back: the agent calls her phone, records a quiet stretch of her camera and writes it as a
30 fps H.264 MP4 for Presage to read.

The call goes through the Relay Python SDK (aiortc), which repairs lost video packets; on live calls the
TypeScript receiver dropped frames every few seconds, so Presage never had 12 s of continuous video. Presage
reads the file afterwards (apps/server/src/calls/camera-callback.ts), so nothing here is real-time.

    python camera_check.py --chat-id ID --to HANDLE --out FILE.mp4 [--seconds 35] [--say-start TEXT] [--say-end TEXT] [--say-camera TEXT]
    python camera_check.py --self-test FILE.mp4

Environment: RELAY_AGENT_TOKEN (and RELAY_API_URL); ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID speak the prompts
when set. Keys are never printed. stdout carries one JSON line per step and nothing else; the last line is
"recorded" (exit 0) or "failed" with a reason (exit 2).
"""

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request
import uuid
from fractions import Fraction

import av
import numpy as np

FPS = 30
TICK_US = 1_000_000 / FPS
ANSWER_TIMEOUT_S = 75
VIDEO_TIMEOUT_S = 45  # after the start prompt, for her camera's first frame
CAMERA_REMINDER_S = 10  # no frame yet by then: she is asked once more to tap the video button


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


class Recorder:
    """Writes frames as constant 30 fps (a frame is repeated or skipped by its capture time), all at the first
    frame's size: Presage's pulse model expects about 30 fps, and the phone often steps up its resolution."""

    def __init__(self, path: str, seconds: float) -> None:
        self.path, self.seconds = path, seconds
        self.container = None
        self.stream = None
        self.size: tuple[int, int] | None = None
        self.first_us: int | None = None
        self.prev_us: int | None = None
        self.written = 0
        self.received = 0
        self.longest_gap_ms = 0.0

    def add(self, frame: av.VideoFrame, timestamp_us: int) -> bool:
        """Adds one frame; returns True once the recording is long enough."""
        if self.container is None:
            width, height = frame.width - frame.width % 2, frame.height - frame.height % 2
            self.size = (width, height)
            self.container = av.open(self.path, "w")
            self.stream = self.container.add_stream("libx264", rate=FPS)
            self.stream.width, self.stream.height, self.stream.pix_fmt = width, height, "yuv420p"
            self.stream.options = {"crf": "17", "preset": "veryfast"}
            self.first_us = timestamp_us
        if self.prev_us is not None:
            self.longest_gap_ms = max(self.longest_gap_ms, (timestamp_us - self.prev_us) / 1000)
        self.prev_us = timestamp_us
        self.received += 1
        width, height = self.size
        if (frame.width, frame.height) != (width, height) or frame.format.name != "yuv420p":
            frame = frame.reformat(width=width, height=height, format="yuv420p")
        due = int((timestamp_us - self.first_us) / TICK_US) + 1  # output frames that should exist by now
        while self.written < due and self.written < self.seconds * FPS:
            out = frame if self.written == due - 1 else frame.reformat()  # a repeated frame needs its own pts
            out.pts, out.time_base = self.written, Fraction(1, FPS)
            for packet in self.stream.encode(out):
                self.container.mux(packet)
            self.written += 1
        return self.written >= self.seconds * FPS

    def close(self) -> None:
        if self.container is None:
            return
        for packet in self.stream.encode():
            self.container.mux(packet)
        self.container.close()


def speech(text: str | None) -> np.ndarray | None:
    """The prompt spoken by the agent's ElevenLabs voice as 48 kHz mono PCM, or None (no key, no text, a failure)."""
    key, voice = os.environ.get("ELEVENLABS_API_KEY", "").strip(), os.environ.get("ELEVENLABS_VOICE_ID", "").strip()
    if not (text and key and voice):
        return None
    request = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=pcm_48000",
        data=json.dumps({"text": text, "model_id": "eleven_flash_v2_5"}).encode(),
        method="POST",
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return np.frombuffer(response.read(), dtype="<i2").copy()
    except Exception as error:  # a missing prompt must not cost her the check
        emit("speech_failed", detail=type(error).__name__)
        return None


async def say(call, pcm: np.ndarray | None) -> None:
    """Speaks a prompt. Best effort: audio is held while she isn't listening, so a hang-up mid-prompt must not
    stall the check."""
    from relaymessenger.calls import RelayAudioFrame

    if pcm is None:
        return

    async def play() -> None:
        for start in range(0, len(pcm), 960):  # whole 20 ms frames
            chunk = pcm[start : start + 960]
            if len(chunk) < 960:
                chunk = np.pad(chunk, (0, 960 - len(chunk)))
            await call.write_audio(RelayAudioFrame(chunk, 48_000, 1))
        await call.wait_for_playout()

    try:
        await asyncio.wait_for(play(), timeout=len(pcm) / 48_000 + 10)
    except Exception as error:
        emit("speech_failed", detail=type(error).__name__)


async def first_of(*events: asyncio.Event, timeout: float) -> bool:
    """Waits until one of the events is set; False when the time runs out first."""
    if any(event.is_set() for event in events):
        return True
    waits = [asyncio.ensure_future(event.wait()) for event in events]
    try:
        done, _ = await asyncio.wait(waits, timeout=max(timeout, 0), return_when=asyncio.FIRST_COMPLETED)
        return bool(done)
    finally:
        for wait in waits:
            wait.cancel()


def place_call(api: str, token: str, chat_id: str, handle: str) -> str:
    request = urllib.request.Request(
        f"{api}/v1/chats/{chat_id}/calls",
        data=json.dumps({"to": [handle]}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Idempotency-Key": str(uuid.uuid4()), "Content-Type": "application/json", "User-Agent": "checkin-companion-camera-check/1.0"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        body = json.load(response)
    call = body.get("call") or (body.get("data") or {}).get("call") or body
    if not call.get("id"):
        raise RuntimeError("the call response had no id")
    return call["id"]


async def run(args: argparse.Namespace) -> int:
    from relaymessenger.calls import RelayCallTransport, VideoStream

    token = os.environ.get("RELAY_AGENT_TOKEN", "").strip()
    api = (os.environ.get("RELAY_API_URL", "").strip() or "https://api.relayapp.im").rstrip("/")
    if not token:
        emit("failed", reason="no_token")
        return 2
    # The prompts, rendered together before the phone rings.
    start_pcm, end_pcm, camera_pcm = await asyncio.gather(*(asyncio.to_thread(speech, text) for text in (args.say_start, args.say_end, args.say_camera)))
    try:
        call_id = place_call(api, token, args.chat_id, args.to)
    except Exception as error:
        emit("failed", reason="call_not_placed", detail=type(error).__name__)
        return 2
    emit("calling")
    loop = asyncio.get_running_loop()
    ring_deadline = loop.time() + ANSWER_TIMEOUT_S
    call = RelayCallTransport(api_key=token, call_id=call_id, base_url=api)
    recorder = Recorder(args.out, args.seconds)
    answered = asyncio.Event()  # her audio or her camera reached the agent: she picked up
    first_frame = asyncio.Event()
    recording = asyncio.Event()
    finished = asyncio.Event()
    ended = asyncio.Event()  # she declined or hung up
    camera_flag = None  # her camera on or off, as the call room says
    reader = None
    readers = 0

    async def read(track) -> None:
        try:
            async for event in VideoStream(track, capacity=2):
                if not first_frame.is_set():
                    first_frame.set()
                    answered.set()
                    emit("video", width=event.frame.width, height=event.frame.height)
                if recording.is_set() and not finished.is_set():
                    if recorder.add(event.frame.to_av(), event.timestamp_us):
                        finished.set()
        except Exception as error:  # a reader that dies says so, and the wait for her camera starts another
            emit("video_error", detail=type(error).__name__)

    def start_reading(track) -> None:
        nonlocal reader, readers
        if track is None or (reader is not None and not reader.done()) or readers >= 3:
            return
        readers += 1
        reader = loop.create_task(read(track))

    def video_facts() -> dict:
        """What the call knew about her video, for a check that got none."""
        facts = {"camera_flag": camera_flag, "has_track": call.remote_video_track is not None, "readers": readers}
        try:
            inbound = call.video_stats().inbound
            if inbound is not None:
                facts.update(frames_decoded=inbound.frames_decoded, frames_dropped=inbound.frames_dropped, decode_errors=inbound.decode_errors, codec=inbound.codec)
        except Exception:
            pass
        return facts

    @call.on("track_subscribed")
    def _camera(track) -> None:
        start_reading(track)

    @call.on("remote_video")
    def _camera_switched(on) -> None:
        nonlocal camera_flag
        camera_flag = bool(on)

    @call.on("peer_audio")
    def _picked_up() -> None:
        answered.set()

    @call.on("ended")
    def _hung_up(*_) -> None:
        ended.set()

    try:
        # connect() returns once the agent's own media is up, while her phone may still be ringing.
        await asyncio.wait_for(call.connect(), timeout=ANSWER_TIMEOUT_S)
        if not await first_of(answered, ended, timeout=ring_deadline - loop.time()) or not answered.is_set():
            emit("failed", reason="not_answered")
            return 2
        emit("answered")
        await say(call, start_pcm)  # it asks her to tap the video button when her camera is off
        video_deadline = loop.time() + VIDEO_TIMEOUT_S
        reminder_at = loop.time() + CAMERA_REMINDER_S
        while not first_frame.is_set() and not ended.is_set() and loop.time() < video_deadline:
            # The SDK says "track_subscribed" once; its track is also read here, and a reader that died is started again.
            start_reading(call.remote_video_track)
            if camera_pcm is not None and loop.time() >= reminder_at:
                pcm, camera_pcm = camera_pcm, None
                emit("camera_reminder")
                await say(call, pcm)
            await first_of(first_frame, ended, timeout=0.5)
        if not first_frame.is_set():
            emit("failed", reason="hung_up" if ended.is_set() else "no_video", **video_facts())
            return 2
        recording.set()
        emit("recording", seconds=args.seconds)
        await first_of(finished, ended, timeout=args.seconds + 20)  # a short recording is still read; Presage decides
        finished.set()  # read() adds nothing more, so closing the file is safe
        recorder.close()
        if not ended.is_set():
            await say(call, end_pcm)
        if recorder.written < FPS * 15:
            emit("failed", reason="too_short", frames=recorder.written)
            return 2
        emit("recorded", path=args.out, frames=recorder.written, seconds=round(recorder.written / FPS, 1), received=recorder.received, longest_gap_ms=round(recorder.longest_gap_ms), width=recorder.size[0], height=recorder.size[1])
        return 0
    except asyncio.TimeoutError:
        emit("failed", reason="not_answered")
        return 2
    except Exception as error:  # the call ending before she answered (declined, or her phone busy) ends connect() this way
        emit("failed", reason="call_ended" if ended.is_set() else "call_error", detail=type(error).__name__)
        return 2
    finally:
        try:
            result = call.end()
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            pass
        try:
            await call.aclose()
        except Exception:
            pass


def self_test(path: str) -> int:
    """Offline check of the recorder: 25 fps input with a pause and a size change becomes constant 30 fps at one size."""
    recorder = Recorder(path, seconds=4)
    t = 0
    for i in range(140):
        size = (64, 96) if i < 60 else (80, 120)  # the phone steps up its resolution
        frame = av.VideoFrame.from_ndarray(np.full((size[1], size[0], 3), i % 255, dtype=np.uint8), format="rgb24")
        t += 40_000 if i != 50 else 1_000_000  # 25 fps, one 1 s pause
        if recorder.add(frame, t):
            break
    recorder.close()
    container = av.open(path)
    stream = container.streams.video[0]
    frames = [f for f in container.decode(video=0)]
    ok = len(frames) == 4 * FPS and all((f.width, f.height) == (64, 96) for f in frames) and round(float(stream.average_rate)) == FPS
    emit("self_test", ok=ok, frames=len(frames), size=f"{frames[0].width}x{frames[0].height}", fps=float(stream.average_rate))
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chat-id")
    parser.add_argument("--to")
    parser.add_argument("--out")
    parser.add_argument("--seconds", type=float, default=35)
    parser.add_argument("--say-start")
    parser.add_argument("--say-end")
    parser.add_argument("--say-camera")
    parser.add_argument("--self-test", metavar="FILE")
    args = parser.parse_args()
    if args.self_test:
        return self_test(args.self_test)
    if not (args.chat_id and args.to and args.out):
        parser.error("--chat-id, --to and --out are required")
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
