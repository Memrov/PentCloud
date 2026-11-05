export const MODEL_ROLES=["primary","adviser","coder","maintenance","memorist","pentester","searcher","reporter"] as const;
export type ModelRole=typeof MODEL_ROLES[number];
