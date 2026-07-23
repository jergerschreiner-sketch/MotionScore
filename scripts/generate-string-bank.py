#!/usr/bin/env python3
"""Generate MotionScore's Inertia Pluck physical-model sample bank."""

from __future__ import annotations

import math
import random
import wave
from pathlib import Path


RATE = 48_000
DURATION = 3.2
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "audio" / "inertia-strings"
PEAK = 10 ** (-6 / 20)
STRINGS = {"g3": 55, "d4": 62, "a4": 69, "e5": 76}


def midi_frequency(note: int) -> float:
    return 440.0 * (2.0 ** ((note - 69) / 12.0))


def highpass_excitation(length: int, seed: int, pick_position: float) -> list[float]:
    rng = random.Random(seed)
    noise = [rng.uniform(-1.0, 1.0) for _ in range(length)]
    shift = max(1, round(length * pick_position))
    shaped = [noise[index] - 0.76 * noise[(index - shift) % length] for index in range(length)]
    mean = sum(shaped) / length
    return [(value - mean) * math.sin(math.pi * (index + 0.5) / length) for index, value in enumerate(shaped)]


def plucked_string(note: int) -> tuple[list[float], list[float]]:
    frequency = midi_frequency(note)
    delay = max(8, round(RATE / frequency - 0.5))
    ring = highpass_excitation(delay, note * 733, 0.19 + (note - 55) * 0.0018)
    frames = round(RATE * DURATION)
    string = [0.0] * frames
    index = 0
    previous = 0.0
    damping = 0.9966 - (note - 55) * 0.000025

    for frame in range(frames):
        current = ring[index]
        next_value = ring[(index + 1) % delay]
        averaged = (current * 0.51 + next_value * 0.49) * damping
        dispersed = averaged * 0.91 + previous * 0.09
        ring[index] = dispersed
        previous = dispersed
        index = (index + 1) % delay
        string[frame] = current

    left = [0.0] * frames
    right = [0.0] * frames
    stereo_delay = max(1, round(RATE * (0.00042 + (note - 55) * 0.000004)))

    for frame, value in enumerate(string):
        time = frame / RATE
        attack = min(1.0, time / 0.0025)
        pick = math.sin(2 * math.pi * frequency * 3.01 * time + 0.6) * math.exp(-time * 13.5) * 0.12
        glass = math.sin(2 * math.pi * frequency * 5.02 * time + 1.1) * math.exp(-time * 9.2) * 0.055
        body = math.sin(2 * math.pi * (178 + note * 0.31) * time) * math.exp(-time * 4.8) * 0.035
        composite = math.tanh((value * 0.92 + pick + glass + body) * 1.1) * attack
        delayed = string[frame - stereo_delay] if frame >= stereo_delay else 0.0
        left[frame] = composite * 0.91 + delayed * 0.06
        right[frame] = composite * 0.76 + delayed * 0.22

    return left, right


def write24(path: Path, left: list[float], right: list[float]) -> None:
    maximum = max(max(abs(value) for value in left), max(abs(value) for value in right), 1e-9)
    scale = PEAK / maximum
    packed = bytearray()
    for left_value, right_value in zip(left, right):
        for value in (left_value, right_value):
            integer = round(max(-1.0, min(1.0, value * scale)) * 8_388_607)
            if integer < 0:
                integer += 1 << 24
            packed.extend((integer & 255, (integer >> 8) & 255, (integer >> 16) & 255))
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(3)
        wav.setframerate(RATE)
        wav.writeframes(packed)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, note in STRINGS.items():
        left, right = plucked_string(note)
        write24(OUT / f"{name}.wav", left, right)
    (OUT / "README.txt").write_text(
        "MotionScore Inertia Pluck\n"
        "Four original physical-model plucked-string one-shots; 48 kHz / 24-bit / stereo.\n"
        "Touch begins on an exact semitone; horizontal movement adds continuous pitch glide.\n",
        encoding="utf-8",
    )
    print(OUT)


if __name__ == "__main__":
    main()
