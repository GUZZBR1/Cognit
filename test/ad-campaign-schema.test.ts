import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAdCampaignDataset,
  type AdCampaignDataset,
} from "../src/cognit/ad-campaign-schema.ts";

const validDataset: AdCampaignDataset = {
  campaigns: [{ id: "campaign-1", name: "Spring launch" }],
  budgets: [{ id: "budget-1", campaignId: "campaign-1", amount: 1250, currency: "USD" }],
  creatives: [{
    id: "creative-1",
    campaignId: "campaign-1",
    name: "Banner A",
    assetRef: "assets/banner-a",
    challengeMetadataIds: ["challenge-meta-1"],
  }],
  challengeMetadata: [{ id: "challenge-meta-1", challengeId: "challenge-1", stimulusId: "stimulus-1" }],
  impressions: [{
    id: "impression-1",
    campaignId: "campaign-1",
    creativeId: "creative-1",
    challengeMetadataId: "challenge-meta-1",
    occurredAt: "2026-10-22T12:00:00.000Z",
  }],
  interactions: [{
    id: "interaction-1",
    impressionId: "impression-1",
    campaignId: "campaign-1",
    creativeId: "creative-1",
    eventType: "click",
    occurredAt: "2026-10-22T12:00:03.000Z",
  }],
};

function paths(dataset: AdCampaignDataset): string[] {
  return validateAdCampaignDataset(dataset).map(({ path }) => path);
}

test("accepts all six related campaign records", () => {
  assert.deepEqual(validateAdCampaignDataset(validDataset), []);
});

test("validates IDs and references across campaigns, creatives, budgets, and events", () => {
  const dataset = structuredClone(validDataset);
  dataset.campaigns.push({ id: "campaign-1", name: "Duplicate" });
  dataset.budgets[0].campaignId = "missing-campaign";
  dataset.creatives[0].campaignId = "missing-campaign";
  dataset.impressions[0].creativeId = "missing-creative";
  dataset.interactions[0].impressionId = "missing-impression";

  const result = validateAdCampaignDataset(dataset);
  assert.ok(result.some(({ path }) => path === "campaigns[1].id"));
  assert.ok(result.some(({ path }) => path === "budgets[0].campaignId"));
  assert.ok(result.some(({ path }) => path === "creatives[0].campaignId"));
  assert.ok(result.some(({ path }) => path === "impressions[0].creativeId"));
  assert.ok(result.some(({ path }) => path === "interactions[0].impressionId"));
});

test("keeps impression and interaction attribution consistent", () => {
  const dataset = structuredClone(validDataset);
  dataset.impressions[0].campaignId = "another-campaign";
  dataset.interactions[0].creativeId = "another-creative";

  const result = validateAdCampaignDataset(dataset);
  assert.ok(result.some(({ path }) => path === "impressions[0].campaignId"));
  assert.ok(result.some(({ path }) => path === "interactions[0]"));
});

test("requires challenge compatibility references to resolve and match the creative", () => {
  const dataset = structuredClone(validDataset);
  dataset.impressions[0].challengeMetadataId = "unknown-metadata";
  assert.ok(paths(dataset).includes("impressions[0].challengeMetadataId"));

  dataset.impressions[0].challengeMetadataId = "other-metadata";
  dataset.challengeMetadata.push({ id: "other-metadata", challengeId: "challenge-2" });
  assert.ok(paths(dataset).includes("impressions[0].challengeMetadataId"));
});

test("validates budget values, timestamps, event types, and rejects undeclared security controls", () => {
  const dataset = structuredClone(validDataset);
  dataset.budgets[0].amount = -1;
  dataset.budgets[0].currency = "usd";
  dataset.impressions[0].occurredAt = "yesterday";
  dataset.interactions[0].eventType = "score" as "click";
  (dataset.campaigns[0] as AdCampaignDataset["campaigns"][number] & { threshold?: number }).threshold = 0.9;

  const result = validateAdCampaignDataset(dataset);
  assert.ok(result.some(({ path }) => path === "budgets[0].amount"));
  assert.ok(result.some(({ path }) => path === "budgets[0].currency"));
  assert.ok(result.some(({ path }) => path === "impressions[0].occurredAt"));
  assert.ok(result.some(({ path }) => path === "interactions[0].eventType"));
  assert.ok(result.some(({ path }) => path === "campaigns[0].threshold"));
});
