import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { FakeRail } from "@crewpay/rails";
import { defaultRules } from "@crewpay/domain";
import { createApi } from "./server.ts";

function base(chain: string, asset: string) {
  return { chain, asset };
}

async function start() {
  const { server, store } = createApi({ rail: new FakeRail() });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { server, store, call };
}

test("runs a pay run end to end over HTTP", async () => {
  const { server, call } = await start();
  try {
    await call("/v1/payees", "POST", {
      id: "ada",
      orgId: "org_1",
      kind: "contractor",
      displayName: "Ada",
      destination: base("near", "usdc"),
      address: "ada.near",
      status: "approved",
      screening: "clear",
    });
    await call("/v1/policies", "POST", {
      orgId: "org_1",
      rules: { ...defaultRules(), requireApprovalForNewPayee: false },
    });

    const { status, json } = await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 150_000 }],
    });

    assert.equal(status, 201);
    assert.equal(json.settledCents, 150_000);
    assert.deepEqual(json.denied, []);
    assert.deepEqual(json.awaitingApproval, []);
  } finally {
    server.close();
  }
});

test("health reports the active rail", async () => {
  const { server, call } = await start();
  try {
    const { status, json } = await call("/health", "GET");
    assert.equal(status, 200);
    assert.equal(json.rail, "fake");
  } finally {
    server.close();
  }
});

test("a pay run without a policy is rejected", async () => {
  const { server, call } = await start();
  try {
    const { status } = await call("/v1/pay-runs", "POST", {
      orgId: "org_x",
      period: "2026-11",
      lines: [],
    });
    assert.equal(status, 400);
  } finally {
    server.close();
  }
});
