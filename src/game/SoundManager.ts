export class SoundManager {
  private context?: AudioContext;

  shot(): void {
    this.tone(150, 0.08, "sawtooth", 0.05, 420);
  }

  bounce(): void {
    this.tone(740, 0.045, "square", 0.025, 470);
  }

  hit(): void {
    this.tone(105, 0.12, "sawtooth", 0.055, 55);
  }

  shield(): void {
    this.tone(360, 0.16, "triangle", 0.05, 120);
  }

  reclaim(): void {
    this.tone(420, 0.14, "sine", 0.04, 880);
    window.setTimeout(() => this.tone(660, 0.12, "triangle", 0.025, 1040), 65);
  }

  aimHeartbeat(): void {
    this.tone(58, 0.09, "sine", 0.024, 44);
    window.setTimeout(() => this.tone(52, 0.08, "sine", 0.018, 40), 125);
  }

  tension(intensity: number): void {
    const strength = Math.max(0, Math.min(1, intensity));
    this.tone(72 + strength * 34, 0.1, "sine", 0.012 + strength * 0.012, 58 + strength * 20);
    if (strength > 0.72) {
      window.setTimeout(() => this.tone(48, 0.16, "sawtooth", 0.01 + strength * 0.008, 36), 55);
    }
  }

  dashWarning(): void {
    this.tone(260, 0.12, "square", 0.018, 130);
  }

  dash(): void {
    this.tone(90, 0.09, "sawtooth", 0.035, 280);
  }

  nearMiss(): void {
    this.tone(880, 0.1, "sine", 0.035, 1320);
  }

  phase(): void {
    this.tone(110, 0.28, "sawtooth", 0.05, 42);
    window.setTimeout(() => this.tone(220, 0.18, "square", 0.025, 90), 90);
  }

  reward(chain: number): void {
    const start = 460 + Math.min(chain, 4) * 90;
    this.tone(start, 0.09, "triangle", 0.025, start * 1.45);
  }

  fail(): void {
    this.tone(180, 0.32, "sawtooth", 0.045, 55);
  }

  clear(): void {
    this.tone(440, 0.18, "triangle", 0.04, 660);
    window.setTimeout(() => this.tone(660, 0.24, "triangle", 0.04, 990), 120);
  }

  private tone(startFrequency: number, duration: number, type: OscillatorType, volume: number, endFrequency: number): void {
    try {
      this.context ??= new AudioContext();
      if (this.context.state === "suspended") void this.context.resume();

      const now = this.context.currentTime;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(startFrequency, now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), now + duration);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gain).connect(this.context.destination);
      oscillator.start(now);
      oscillator.stop(now + duration);
    } catch {
      // Audio is optional; browsers may block it before the first user gesture.
    }
  }
}
