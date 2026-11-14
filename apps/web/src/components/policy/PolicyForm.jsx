import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import Notice from "@/components/common/Notice";
import { money, toCents } from "@/lib/format";
import { DEFAULT_RULES } from "@/api/crewpay";
import { publishPolicy } from "@/lib/treasury";

const KINDS = ["contractor", "vendor", "employee", "agent"];

/** Integer cents -> the dollar string an input shows, e.g. 125050 -> "1250.50". */
function centsToInput(cents) {
  if (typeof cents !== "number") return "";
  return (cents / 100).toFixed(2);
}

function listField(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function parseList(input) {
  return String(input ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Edit the active policy. Publishing always creates a new version — the API
 * bumps the version and deactivates the old one — so there is no "edit in
 * place": a decision recorded yesterday must still replay against the rules
 * that were in force when it was made.
 *
 * Every money field is kept as the integer cents the API stores; the dollar
 * inputs are converted on the way in and back on the way out, never through a
 * float in the stored value.
 */
export default function PolicyForm({ policy, onPublished }) {
  // With no active policy the editor seeds from the same defaults a new org
  // would get, so publishing v1 sends real caps rather than an empty object.
  const current = policy?.rules ?? DEFAULT_RULES;
  const [rules, setRules] = useState(current);
  const [assets, setAssets] = useState(listField(current.allowedAssets));
  const [corridors, setCorridors] = useState(listField(current.allowedCorridors));
  const [busy, setBusy] = useState(false);

  const agentCap = rules.perKindCents?.agent;
  const dirty = useMemo(() => JSON.stringify(rules) !== JSON.stringify(current), [rules, current]);

  function setMoney(key) {
    return (event) => setRules((r) => ({ ...r, [key]: toCents(event.target.value) }));
  }

  function toggleKind(kind) {
    setRules((r) => {
      const has = r.allowedPayeeKinds?.includes(kind);
      const next = has
        ? (r.allowedPayeeKinds ?? []).filter((k) => k !== kind)
        : [...(r.allowedPayeeKinds ?? []), kind];
      // Keep the canonical order so the round-trip is stable and diffable.
      return { ...r, allowedPayeeKinds: KINDS.filter((k) => next.includes(k)) };
    });
  }

  async function publish() {
    setBusy(true);
    try {
      const published = await publishPolicy({
        ...rules,
        allowedAssets: parseList(assets),
        allowedCorridors: parseList(corridors),
      });
      toast.success(`Published policy version ${published.version}`);
      onPublished?.(published);
    } catch (error) {
      toast.error(error?.message || "Could not publish the policy");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <Notice title="Publishing creates a new version" tone="indigo">
        The version is bumped server-side and the previous one is deactivated, so any past decision still replays
        against the rules that produced it.
      </Notice>

      <div className="grid gap-3.5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pol-txn">Max per transaction (USD)</Label>
          <Input
            id="pol-txn"
            inputMode="decimal"
            defaultValue={centsToInput(current.maxPerTransactionCents)}
            onChange={setMoney("maxPerTransactionCents")}
            className="tabular"
          />
          <p className="text-[11px] text-muted-foreground">
            Currently {typeof rules.maxPerTransactionCents === "number" ? money(rules.maxPerTransactionCents) : "—"}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pol-daily">Max daily (USD)</Label>
          <Input
            id="pol-daily"
            inputMode="decimal"
            defaultValue={centsToInput(current.maxDailyCents)}
            onChange={setMoney("maxDailyCents")}
            className="tabular"
          />
          <p className="text-[11px] text-muted-foreground">
            Currently {typeof rules.maxDailyCents === "number" ? money(rules.maxDailyCents) : "—"}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pol-approval">Approval above (USD)</Label>
          <Input
            id="pol-approval"
            inputMode="decimal"
            defaultValue={centsToInput(current.approvalThresholdCents)}
            onChange={setMoney("approvalThresholdCents")}
            className="tabular"
          />
          <p className="text-[11px] text-muted-foreground">Lines strictly above this need a human signature.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pol-agent">Agent per-task cap (USD)</Label>
          <Input
            id="pol-agent"
            inputMode="decimal"
            defaultValue={typeof agentCap === "number" ? centsToInput(agentCap) : ""}
            onChange={(event) =>
              setRules((r) => ({
                ...r,
                perKindCents: { ...(r.perKindCents ?? {}), agent: toCents(event.target.value) },
              }))
            }
            className="tabular"
          />
          <p className="text-[11px] text-muted-foreground">
            Applies on top of the global cap; leave blank to remove it.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Allowed payee kinds</Label>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((kind) => {
            const on = rules.allowedPayeeKinds?.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                aria-pressed={on}
                className={`rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors ${
                  on
                    ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                    : "border-border bg-white text-muted-foreground hover:text-foreground"
                }`}
              >
                {kind}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          A kind left off cannot be paid at all. OutLayer does not model payee kinds, so this rule stays in the local
          engine.
        </p>
      </div>

      <div className="grid gap-3.5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pol-assets">Allowed assets</Label>
          <Input
            id="pol-assets"
            value={assets}
            onChange={(event) => setAssets(event.target.value)}
            placeholder="usdc, usdt, dai"
            className="font-mono text-[12px]"
          />
          <p className="text-[11px] text-muted-foreground">Comma-separated payout assets.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pol-corridors">Allowed corridors</Label>
          <Input
            id="pol-corridors"
            value={corridors}
            onChange={(event) => setCorridors(event.target.value)}
            placeholder="base:usdc>near:usdc"
            className="font-mono text-[12px]"
          />
          <p className="text-[11px] text-muted-foreground">Empty means every known corridor.</p>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-xl border hairline bg-secondary/40 px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <Label htmlFor="pol-newpayee" className="text-[13px]">
            New payees always need approval
          </Label>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            A payee with no prior payment history is held for a human before its first line settles.
          </p>
        </div>
        <Switch
          id="pol-newpayee"
          checked={Boolean(rules.requireApprovalForNewPayee)}
          onCheckedChange={(checked) => setRules((r) => ({ ...r, requireApprovalForNewPayee: checked }))}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] text-muted-foreground">
          {policy
            ? `Editing v${policy.version} — publishing creates v${policy.version + 1}.`
            : "No active policy yet — publishing creates v1."}
        </p>
        <Button
          onClick={publish}
          disabled={busy || (policy ? !dirty : false)}
          className="h-9 rounded-xl text-[13px]"
        >
          {busy ? "Publishing…" : "Publish new version"}
        </Button>
      </div>
    </div>
  );
}
