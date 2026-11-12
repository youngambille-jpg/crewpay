import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRules, type PolicyRules } from "@crewpay/domain";
import { compileManifest, diffManifest, usdString, MAX_APPROVERS } from "./manifest.ts";

function rules(overrides: Partial<PolicyRules> = {}): PolicyRules {
  return { ...defaultRules(), ...overrides };
}

test("compiles limits and threshold to decimal strings, never floats", () => {
  const { manifest } = compileManifest(
    rules({ maxPerTransactionCents: 500_000, maxDailyCents: 5_000_000, approvalThresholdCents: 200_000 }),
  );
  assert.equal(manifest.limits.per_transaction, "5000.00");
  assert.equal(manifest.limits.daily, "50000.00");
  assert.equal(manifest.multisig.approval_above, "2000.00");
});

test("usdString keeps cents exact, including sub-dollar and zero", () => {
  assert.equal(usdString(0), "0.00");
  assert.equal(usdString(1), "0.01");
  assert.equal(usdString(99), "0.99");
  assert.equal(usdString(100), "1.00");
  assert.equal(usdString(150_000), "1500.00");
});

test("capabilities default every signing door shut", () => {
  const { manifest } = compileManifest(rules());
  // A custody wallet that only funds deposits must not be able to sign
  // arbitrary payloads: a compromise would then extract signatures.
  assert.equal(manifest.capabilities.raw_sign.allowed, false);
  assert.equal(manifest.capabilities.evm_sign.allowed, false);
  assert.equal(manifest.capabilities.solana_sign.allowed, false);
  assert.equal(manifest.capabilities.intents_call, false);
  assert.deepEqual(manifest.capabilities.raw_sign.chains, []);
});

test("chains are derived from the allowed corridors", () => {
  const { manifest } = compileManifest(
    rules({ allowedCorridors: ["base:usdc>near:usdc", "arb:usdc>near:usdc"] }),
  );
  assert.deepEqual(manifest.chains.allowed, ["arb", "base", "near"]);
});

test("an empty corridor list means no chain restriction, not all chains denied", () => {
  const { manifest } = compileManifest(rules({ allowedCorridors: [] }));
  assert.deepEqual(manifest.chains.allowed, []);
});

test("payee addresses become a whitelist when given, and no rule when empty", () => {
  const withList = compileManifest(rules(), { payeeAddresses: ["ada.near", "0xlinus"] });
  assert.equal(withList.manifest.addresses.mode, "whitelist");
  assert.deepEqual(withList.manifest.addresses.list, ["ada.near", "0xlinus"]);

  const without = compileManifest(rules());
  assert.equal(without.manifest.addresses.mode, "none");
});

test("the schedule becomes a time restriction with the org timezone", () => {
  const { manifest } = compileManifest(rules({ schedule: { fromHour: 9, toHour: 17 } }), {
    timezone: "Europe/London",
  });
  assert.deepEqual(manifest.time_restrictions, { from_hour: 9, to_hour: 17, timezone: "Europe/London" });
});

test("no schedule means no time restriction, so the field is absent", () => {
  const { manifest } = compileManifest(rules());
  assert.equal("time_restrictions" in manifest, false);
});

test("approvers and threshold are carried through", () => {
  const { manifest } = compileManifest(rules(), { approvers: ["owner.near", "cfo.near"], threshold: 2 });
  assert.deepEqual(manifest.multisig.approvers, ["owner.near", "cfo.near"]);
  assert.equal(manifest.multisig.threshold, 2);
});

test("rules OutLayer cannot express are warned about, not silently dropped", () => {
  const { warnings } = compileManifest(
    rules({
      requireApprovalForNewPayee: true,
      maxPayeeRiskScore: 70,
      allowedPayeeKinds: ["contractor"],
    }),
    { approvers: ["owner.near"] },
  );
  const codes = warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ["NEW_PAYEE_APPROVAL", "PAYEE_KIND", "RISK_SCORE"]);
});

test("no approvers is a warning, because multisig cannot be met without votes", () => {
  const { warnings, manifest } = compileManifest(rules());
  assert.ok(warnings.some((w) => w.code === "NO_APPROVERS"));
  assert.equal(manifest.multisig.threshold, 0);
});

test("more than 16 approvers is a warning: the ballot could never pass", () => {
  const many = Array.from({ length: MAX_APPROVERS + 1 }, (_, i) => `approver${i}.near`);
  const { warnings } = compileManifest(rules(), { approvers: many, threshold: many.length });
  assert.ok(warnings.some((w) => w.code === "NO_APPROVERS" && w.detail.includes("cap")));
});

test("a full default policy compiles with no warnings when approvers are set", () => {
  const { warnings } = compileManifest(rules({ requireApprovalForNewPayee: false }), {
    approvers: ["owner.near"],
  });
  assert.deepEqual(warnings, []);
});

test("diffManifest reports a changed limit and says nothing when identical", () => {
  const { manifest } = compileManifest(rules({ maxDailyCents: 5_000_000 }), { approvers: ["o.near"] });
  assert.deepEqual(diffManifest(manifest, manifest), []);

  const loosened = { ...manifest, limits: { ...manifest.limits, daily: "999999.00" } };
  const drift = diffManifest(manifest, loosened);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]!.field, "limits.daily");
  assert.equal(drift[0]!.expected, '"50000.00"');
  assert.equal(drift[0]!.actual, '"999999.00"');
});

test("diffManifest catches a capability quietly switched on", () => {
  const { manifest } = compileManifest(rules(), { approvers: ["o.near"] });
  const widened = {
    ...manifest,
    capabilities: { ...manifest.capabilities, raw_sign: { allowed: true, chains: ["near"] } },
  };
  const drift = diffManifest(manifest, widened);
  assert.ok(drift.some((d) => d.field === "capabilities"));
});

test("diffManifest tolerates a wallet with no policy set, and reports the absence", () => {
  const { manifest } = compileManifest(rules(), { approvers: ["o.near"] });
  // An empty object is what a wallet with no policy answers with. Every field
  // is absent, which is drift, but it must not throw.
  const drift = diffManifest(manifest, {});
  assert.ok(drift.length > 0);
  assert.ok(drift.every((d) => d.actual === "null"));
  assert.ok(drift.some((d) => d.field === "limits.daily"));
});
