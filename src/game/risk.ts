export interface RiskInput {
  distance: number;
  bounces: number;
  kills: number;
  nearMisses: number;
}

export interface RiskReward {
  multiplier: number;
  bonus: number;
  tier: "SAFE" | "BOLD" | "RECKLESS";
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function enemyPressureMultiplier(unarmed: boolean, latePressure: boolean): number {
  return (unarmed ? 1.14 : 1) * (latePressure ? 1.08 : 1);
}

export function calculateRiskReward(input: RiskInput): RiskReward {
  const distanceRisk = clamp01((input.distance - 140) / 520) * 0.7;
  const ricochetRisk = clamp01(input.bounces / 5) * 0.25;
  const chainRisk = Math.min(3, Math.max(0, input.kills - 1)) * 0.15;
  const nearMissRisk = Math.min(2, Math.max(0, input.nearMisses)) * 0.2;
  const multiplier = Math.round((1 + distanceRisk + ricochetRisk + chainRisk + nearMissRisk) * 10) / 10;
  const bonus = Math.round(Math.max(0, input.distance - 100) * 0.32 * multiplier);
  const tier = multiplier >= 2 ? "RECKLESS" : multiplier >= 1.4 ? "BOLD" : "SAFE";
  return { multiplier, bonus, tier };
}
