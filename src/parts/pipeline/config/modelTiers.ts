export const MODEL_TIERS = ['max', 'deep', 'balance', 'fast', 'mini'] as const;
export type ModelTier = string;

export interface ModelTierSelection {
  readonly model: string;
  readonly effort?: string;
}

export type ModelTiers = Readonly<Record<ModelTier, ModelTierSelection>>;
