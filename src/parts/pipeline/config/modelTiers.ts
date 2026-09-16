export const MODEL_TIERS = ['max', 'deep', 'balance', 'fast', 'mini'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export type ModelTiers = Readonly<Partial<Record<ModelTier, string>>>;
