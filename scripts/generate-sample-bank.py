#!/usr/bin/env python3
"""Generate MotionScore's original 24-bit glass/metal multisample bank."""

from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np


SAMPLE_RATE = 48_000
DURATION = 4.8
TARGET_PEAK = 10 ** (-6 / 20)
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "audio" / "inertia-glass"

NOTES = {
    "c4": 60,
    "d4": 62,
    "e4": 64,
    "g4": 67,
    "a4": 69,
    "c5": 72,
    "d5": 74,
    "e5": 76,
}

LAYERS = {
    "soft": {"brightness": 0.62, "strike": 0.32, "decay": 1.12},
    "medium": {"brightness": 0.92, "strike": 0.62, "decay": 1.0},
    "hard": {"brightness": 1.28, "strike": 1.0, "decay": 0.86},
}


def midi_frequency(note: int) -> float:
    return 440.0 * (2.0 ** ((note - 69) / 12.0))


def render_note(note: int, layer_name: str, settings: dict[str, float]) -> np.ndarray:
    total = int(SAMPLE_RATE * DURATION)
    time = np.arange(total, dtype=np.float64) / SAMPLE_RATE
    rng = np.random.default_rng(note * 101 + sum(ord(char) for char in layer_name))
    fundamental = midi_frequency(note)
    brightness = settings["brightness"]
    strike = settings["strike"]
    decay_scale = settings["decay"]

    # Slight downward pitch settling gives the strike a physical, resonant feel.
    pitch_settle = np.exp(-time * 42.0)
    phase_base = 2.0 * math.pi * fundamental * (
        time + 0.00042 * strike * (1.0 - pitch_settle)
    )

    partials = [
        (1.000, 1.00, 2.70),
        (2.006, 0.42, 1.85),
        (3.918, 0.24, 1.20),
        (5.430, 0.15, 0.82),
        (7.112, 0.10, 0.58),
        (9.270, 0.065, 0.42),
    ]

    left = np.zeros(total, dtype=np.float64)
    right = np.zeros(total, dtype=np.float64)
    for index, (ratio, amplitude, decay) in enumerate(partials):
        high_weight = 1.0 if index == 0 else brightness ** (0.45 + index * 0.1)
        envelope = np.exp(-time / (decay * decay_scale))
        phase = rng.uniform(0, math.pi * 2)
        shimmer = 0.0018 * np.sin(2.0 * math.pi * (0.19 + index * 0.037) * time)
        left += amplitude * high_weight * envelope * np.sin(phase_base * ratio + phase + shimmer)
        right += amplitude * high_weight * envelope * np.sin(
            phase_base * ratio * (1.0 + (index + 1) * 0.000013) + phase - shimmer
        )

    # Short filtered noise and a tiny low body pulse form the mallet/metal attack.
    noise = rng.normal(0.0, 1.0, total)
    noise = np.concatenate(([0.0], np.diff(noise)))
    attack_envelope = np.exp(-time / (0.008 + strike * 0.014))
    attack = noise * attack_envelope * (0.045 + strike * 0.12)
    body = np.sin(2.0 * math.pi * fundamental * 0.5 * time) * np.exp(-time / 0.20)
    body *= 0.08 + strike * 0.08

    fade_in = np.minimum(time / 0.0025, 1.0)
    tail_fade = np.ones(total)
    tail_start = int(total * 0.90)
    tail_fade[tail_start:] = np.linspace(1.0, 0.0, total - tail_start) ** 1.5

    left = np.tanh((left + attack + body) * (0.72 + strike * 0.20))
    right = np.tanh((right + attack * 0.96 + body) * (0.72 + strike * 0.20))
    stereo = np.column_stack((left, right)) * fade_in[:, None] * tail_fade[:, None]

    peak = float(np.max(np.abs(stereo))) or 1.0
    return (stereo / peak * TARGET_PEAK).astype(np.float32)


def write_pcm24(path: Path, audio: np.ndarray) -> None:
    clipped = np.clip(audio, -1.0, 1.0)
    values = np.round(clipped.reshape(-1) * 8_388_607).astype(np.int32)
    unsigned = values & 0xFFFFFF
    packed = np.empty((unsigned.size, 3), dtype=np.uint8)
    packed[:, 0] = unsigned & 0xFF
    packed[:, 1] = (unsigned >> 8) & 0xFF
    packed[:, 2] = (unsigned >> 16) & 0xFF

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(2)
        wav_file.setsampwidth(3)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(packed.tobytes())


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for note_name, midi_note in NOTES.items():
        for layer_name, settings in LAYERS.items():
            target = OUTPUT / f"{note_name}_{layer_name}.wav"
            write_pcm24(target, render_note(midi_note, layer_name, settings))
            print(target.relative_to(ROOT))

    (OUTPUT / "README.txt").write_text(
        "MotionScore Inertia Glass multisample bank\n"
        "Original procedural sound design; 48 kHz / 24-bit / stereo.\n"
        "Notes: C4 D4 E4 G4 A4 C5 D5 E5. Layers: soft medium hard.\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
