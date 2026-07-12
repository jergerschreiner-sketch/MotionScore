#!/usr/bin/env python3
"""Generate MotionScore's original shaker and heavy-drum samples."""

from pathlib import Path
import wave
import numpy as np

RATE = 48_000
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "audio" / "kinetic-percussion"
PEAK = 10 ** (-4 / 20)


def write24(path: Path, stereo: np.ndarray) -> None:
    stereo = stereo / max(float(np.max(np.abs(stereo))), 1e-9) * PEAK
    values = np.round(np.clip(stereo, -1, 1).reshape(-1) * 8_388_607).astype(np.int32) & 0xFFFFFF
    packed = np.empty((values.size, 3), dtype=np.uint8)
    packed[:, 0], packed[:, 1], packed[:, 2] = values & 255, (values >> 8) & 255, (values >> 16) & 255
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2); wav.setsampwidth(3); wav.setframerate(RATE); wav.writeframes(packed.tobytes())


def shaker(seed: int) -> np.ndarray:
    duration = 0.16
    t = np.arange(int(RATE * duration)) / RATE
    rng = np.random.default_rng(seed)
    stereo = np.zeros((t.size, 2))
    for _ in range(24):
        onset = rng.uniform(0.002, 0.085)
        start = int(onset * RATE)
        local = t[: t.size - start]
        decay = rng.uniform(0.0025, 0.010)
        envelope = np.exp(-local / decay)
        frequency = rng.uniform(3_800, 11_800)
        resonance = np.sin(2 * np.pi * frequency * local + rng.uniform(0, 2 * np.pi))
        grit = rng.normal(0, 1, local.size)
        grit = np.concatenate(([0.0], np.diff(grit)))
        particle = (resonance * 0.42 + grit * 0.22) * envelope * rng.uniform(0.18, 0.55)
        pan = rng.uniform(0.18, 0.82)
        stereo[start:, 0] += particle * (1 - pan)
        stereo[start:, 1] += particle * pan
    shell = rng.normal(0, 1, t.size)
    shell = np.convolve(shell, np.ones(5) / 5, mode="same") * np.exp(-t / 0.055) * 0.035
    stereo += shell[:, None]
    return np.tanh(stereo * 2.6)


def heavy_drum() -> np.ndarray:
    duration = 1.15
    t = np.arange(int(RATE * duration)) / RATE
    phase = 2 * np.pi * (54 * t + 68 * (1 - np.exp(-t * 18)) / 18)
    sub = np.sin(phase) * np.exp(-t / 0.42)
    click = np.random.default_rng(88).normal(0, 1, t.size) * np.exp(-t / 0.012)
    tone = np.tanh(sub * 1.55 + click * 0.18)
    return np.column_stack((tone, np.roll(tone, 5) * 0.98))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write24(OUT / "shaker.wav", shaker(20260712))
    write24(OUT / "heavy-drum.wav", heavy_drum())
    (OUT / "README.txt").write_text("Kinetic Percussion: one original shaker and one heavy drum; 48 kHz / 24-bit / stereo.\n", encoding="utf-8")
    print(OUT)


if __name__ == "__main__": main()
