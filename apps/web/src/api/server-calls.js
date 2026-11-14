import { createServerFn } from "@tanstack/react-start";

/**
 * Same-origin proxy to the CrewPay API as server functions.
 *
 * The API bearer token lives in server environment only and is read inside
 * the handlers, which never ship to the browser — the framework replaces
 * handler bodies with RPC stubs on the client. Components call `apiList` /
 * `apiPost` and never see a credential.
 */

async function forward(path, method, body) {
  const token = process.env.CREWPAY_API_TOKEN;
  const origin = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";
  if (!token) throw new Error("CREWPAY_API_TOKEN is not set for the console");
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json?.error ?? "request failed"}`);
  return json;
}

const listFn = createServerFn({ method: "GET" }).handler(async ({ data }) => forward(data.path, "GET"));

const writeFn = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  forward(data.path, "POST", data.body),
);

export async function apiList(path) {
  return listFn({ data: { path } });
}

export async function apiPost(path, body) {
  return writeFn({ data: { path, body } });
}

/**
 * Fetch a CSV export and hand back its text. The API requires a bearer token, so
 * the browser cannot download the file directly; this reads it server-side and
 * returns the body for the client to save.
 */
const csvFn = createServerFn({ method: "GET" }).handler(async ({ data }) => {
  const token = process.env.CREWPAY_API_TOKEN;
  const origin = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";
  if (!token) throw new Error("CREWPAY_API_TOKEN is not set for the console");
  const res = await fetch(`${origin}${data.path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: export failed`);
  return text;
});

export async function apiCsv(path) {
  return csvFn({ data: { path } });
}

/**
 * The public pay page's transport. The `/v1/pay/*` routes are deliberately
 * unauthenticated — the invoice id in the URL is the capability — so these
 * carry no bearer token. Keeping them separate from `forward` makes that
 * explicit: nothing here can reach an authenticated route.
 */
async function forwardPublic(path, method, body) {
  const origin = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json?.error ?? "request failed"}`);
  return json;
}

const publicGetFn = createServerFn({ method: "GET" }).handler(async ({ data }) =>
  forwardPublic(data.path, "GET"),
);
const publicPostFn = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  forwardPublic(data.path, "POST", data.body),
);

export async function publicGet(path) {
  return publicGetFn({ data: { path } });
}

export async function publicPost(path, body) {
  return publicPostFn({ data: { path, body } });
}
