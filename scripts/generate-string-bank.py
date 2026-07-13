#!/usr/bin/env python3
"""Generate MotionScore's original loopable bowed-string sample bank."""

from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np


RATE = 48_000
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "audio" / "inertia-strings"
PEAK = 10 ** (-7 / 20)
STRINGS = {"g3": 55, "d4": 62, "a4": 69, "e5": 76}


def midi_frequency(note: int) -> float:
    return 440.0 * (2.0 ** ((note - 69) / 12.0))


def bowed_string(note: int) -> np.ndarray:
    frequency = midi_frequency(note)
    cycles = max(320, round(frequency * 2.2))
    frames = round(cycles * RATE / frequency)
    actual_frequency = cycles * RATE / frames
    time = np.arange(frames, dtype=np.float64) / RATE
    rng = np.random.default_rng(note * 733)

    # A periodic harmonic body keeps the complete file click-free when looped.
    body = np.zeros(frames, dtype=np.float64)
    harmonics = [1.0, 0.48, 0.31, 0.23, 0.17, 0.12, 0.085, 0.06, 0.043]
    for index, amplitude in enumerate(harmonics, start=1):
        phase = rng.uniform(0, 2 * math.pi)
        body += amplitude * np.sin(2 * math.pi * actual_frequency * index * time + phase)

    # Repeating bow texture adds rosin noise without breaking the loop seam.
    texture = rng.normal(0, 1, frames)
    texture = sum(np.roll(texture, offset) for offset in range(-8, 9)) / 17
    texture = np.roll(texture, 8) - texture
    slow = 0.93 + 0.07 * np.sin(2 * math.pi * 3 * np.arange(frames) / frames)
    tone = np.tanh((body * slow + texture * 0.095) * 0.82)

    width = 0.00038 + (note - 55) * 0.000008
    delayed = np.roll(tone, max(1, round(width * RATE)))
    left = tone * 0.86 + delayed * 0.14
    right = delayed * 0.82 + tone * 0.18
    return np.column_stack((left, right))


def write24(path: Path, stereo: np.ndarray) -> None:
    stereo = stereo / max(float(np.max(np.abs(stereo))), 1e-9) * PEAK
    values = np.round(np.clip(stereo, -1, 1).reshape(-1) * 8_388_607).astype(np.int32) & 0xFFFFFF
    packed = np.empty((values.size, 3), dtype=np.uint8)
    packed[:, 0] = values & 255
    packed[:, 1] = (values >> 8) & 255
    packed[:, 2] = (values >> 16) & 255
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(3)
        wav.setframerate(RATE)
        wav.writeframes(packed.tobytes())


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, note in STRINGS.items():
        write24(OUT / f"{name}.wav", bowed_string(note))
    (OUT / "README.txt").write_text(
        "MotionScore Inertia Strings\n"
        "Four original seamless bowed-string loops; 48 kHz / 24-bit / stereo.\n"
        "Open strings: G3 D4 A4 E5. Each string glides continuously across seven semitones.\n",
        encoding="utf-8",
    )
    print(OUT)


if __name__ == "__main__":
    main()
