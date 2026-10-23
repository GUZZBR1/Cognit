export type AdCampaign = {
  id: string;
  name: string;
};

export type AdBudget = {
  id: string;
  campaignId: string;
  amount: number;
  currency: string;
};

export type AdCreative = {
  id: string;
  campaignId: string;
  name: string;
  assetRef: string;
  challengeMetadataIds: string[];
};

export type ChallengeMetadata = {
  id: string;
  challengeId: string;
  stimulusId?: string;
};

export type AdImpression = {
  id: string;
  campaignId: string;
  creativeId: string;
  challengeMetadataId?: string;
  occurredAt: string;
};

export type AdInteraction = {
  id: string;
  impressionId: string;
  campaignId: string;
  creativeId: string;
  eventType: "click" | "dismiss" | "engage";
  occurredAt: string;
};

export type AdCampaignDataset = {
  campaigns: AdCampaign[];
  budgets: AdBudget[];
  creatives: AdCreative[];
  challengeMetadata: ChallengeMetadata[];
  impressions: AdImpression[];
  interactions: AdInteraction[];
};

export type SchemaIssue = {
  path: string;
  message: string;
};

const allowedKeys = {
  campaigns: ["id", "name"],
  budgets: ["id", "campaignId", "amount", "currency"],
  creatives: ["id", "campaignId", "name", "assetRef", "challengeMetadataIds"],
  challengeMetadata: ["id", "challengeId", "stimulusId"],
  impressions: ["id", "campaignId", "creativeId", "challengeMetadataId", "occurredAt"],
  interactions: ["id", "impressionId", "campaignId", "creativeId", "eventType", "occurredAt"],
} as const;

function exactKeys(value: object, keys: readonly string[], path: string, issues: SchemaIssue[]) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) issues.push({ path: `${path}.${key}`, message: "Unknown field." });
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && value.includes("T");
}

function duplicateIds<T extends { id: string }>(records: T[], collection: string, issues: SchemaIssue[]) {
  const seen = new Set<string>();
  records.forEach((record, index) => {
    if (!nonEmptyString(record.id)) {
      issues.push({ path: `${collection}[${index}].id`, message: "ID is required." });
    } else if (seen.has(record.id)) {
      issues.push({ path: `${collection}[${index}].id`, message: "ID must be unique within its collection." });
    }
    seen.add(record.id);
  });
}

/** Validates the six related records without performing delivery or security decisions. */
export function validateAdCampaignDataset(dataset: AdCampaignDataset): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const collections = Object.keys(allowedKeys) as (keyof AdCampaignDataset)[];

  for (const collection of collections) {
    if (!Array.isArray(dataset[collection])) {
      issues.push({ path: collection, message: "Expected an array." });
    }
  }
  if (issues.length) return issues;

  const { campaigns, budgets, creatives, challengeMetadata, impressions, interactions } = dataset;
  for (const [collection, records] of Object.entries(dataset) as [keyof AdCampaignDataset, object[]][]) {
    records.forEach((record, index) => exactKeys(record, allowedKeys[collection], `${collection}[${index}]`, issues));
  }

  duplicateIds(campaigns, "campaigns", issues);
  duplicateIds(budgets, "budgets", issues);
  duplicateIds(creatives, "creatives", issues);
  duplicateIds(challengeMetadata, "challengeMetadata", issues);
  duplicateIds(impressions, "impressions", issues);
  duplicateIds(interactions, "interactions", issues);

  const campaignIds = new Set(campaigns.map(({ id }) => id));
  const creativeById = new Map(creatives.map((creative) => [creative.id, creative]));
  const metadataById = new Map(challengeMetadata.map((metadata) => [metadata.id, metadata]));
  const impressionById = new Map(impressions.map((impression) => [impression.id, impression]));

  campaigns.forEach((campaign, index) => {
    if (!nonEmptyString(campaign.name)) issues.push({ path: `campaigns[${index}].name`, message: "Name is required." });
  });

  budgets.forEach((budget, index) => {
    if (!campaignIds.has(budget.campaignId)) issues.push({ path: `budgets[${index}].campaignId`, message: "Campaign reference does not exist." });
    if (!Number.isFinite(budget.amount) || budget.amount < 0) issues.push({ path: `budgets[${index}].amount`, message: "Amount must be a non-negative number." });
    if (!/^[A-Z]{3}$/.test(budget.currency)) issues.push({ path: `budgets[${index}].currency`, message: "Currency must be a three-letter uppercase code." });
  });

  creatives.forEach((creative, index) => {
    if (!campaignIds.has(creative.campaignId)) issues.push({ path: `creatives[${index}].campaignId`, message: "Campaign reference does not exist." });
    if (!nonEmptyString(creative.name)) issues.push({ path: `creatives[${index}].name`, message: "Name is required." });
    if (!nonEmptyString(creative.assetRef)) issues.push({ path: `creatives[${index}].assetRef`, message: "Asset reference is required." });
    if (!Array.isArray(creative.challengeMetadataIds)) {
      issues.push({ path: `creatives[${index}].challengeMetadataIds`, message: "Expected an array." });
    } else {
      creative.challengeMetadataIds.forEach((id, challengeIndex) => {
        if (!metadataById.has(id)) issues.push({ path: `creatives[${index}].challengeMetadataIds[${challengeIndex}]`, message: "Challenge metadata reference does not exist." });
      });
    }
  });

  challengeMetadata.forEach((metadata, index) => {
    if (!nonEmptyString(metadata.challengeId)) issues.push({ path: `challengeMetadata[${index}].challengeId`, message: "Challenge ID is required." });
    if (metadata.stimulusId !== undefined && !nonEmptyString(metadata.stimulusId)) issues.push({ path: `challengeMetadata[${index}].stimulusId`, message: "Stimulus ID must be a non-empty string when provided." });
  });

  impressions.forEach((impression, index) => {
    const creative = creativeById.get(impression.creativeId);
    if (!campaignIds.has(impression.campaignId)) issues.push({ path: `impressions[${index}].campaignId`, message: "Campaign reference does not exist." });
    if (!creative) issues.push({ path: `impressions[${index}].creativeId`, message: "Creative reference does not exist." });
    else if (creative.campaignId !== impression.campaignId) issues.push({ path: `impressions[${index}].campaignId`, message: "Campaign must match the referenced creative." });
    if (impression.challengeMetadataId !== undefined) {
      if (!metadataById.has(impression.challengeMetadataId)) issues.push({ path: `impressions[${index}].challengeMetadataId`, message: "Challenge metadata reference does not exist." });
      else if (creative && !creative.challengeMetadataIds.includes(impression.challengeMetadataId)) issues.push({ path: `impressions[${index}].challengeMetadataId`, message: "Challenge metadata must be compatible with the referenced creative." });
    }
    if (!validTimestamp(impression.occurredAt)) issues.push({ path: `impressions[${index}].occurredAt`, message: "Expected an ISO-style timestamp." });
  });

  interactions.forEach((interaction, index) => {
    const impression = impressionById.get(interaction.impressionId);
    if (!impression) issues.push({ path: `interactions[${index}].impressionId`, message: "Impression reference does not exist." });
    else if (impression.campaignId !== interaction.campaignId || impression.creativeId !== interaction.creativeId) {
      issues.push({ path: `interactions[${index}]`, message: "Campaign and creative must match the referenced impression." });
    }
    if (!nonEmptyString(interaction.eventType) || !["click", "dismiss", "engage"].includes(interaction.eventType)) {
      issues.push({ path: `interactions[${index}].eventType`, message: "Event type is not supported." });
    }
    if (!validTimestamp(interaction.occurredAt)) issues.push({ path: `interactions[${index}].occurredAt`, message: "Expected an ISO-style timestamp." });
  });

  return issues;
}
