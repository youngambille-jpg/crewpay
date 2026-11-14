import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Notice from "@/components/common/Notice";
import { createPayee } from "@/lib/treasury";

const KINDS = ["contractor", "vendor", "employee", "agent"];
const CHAINS = ["near", "base", "ethereum", "polygon", "arbitrum", "solana"];
const ASSETS = ["USDC", "USDT", "DAI"];

export default function NewPayeeForm({ onCreated, existingIds = [] }) {
  const [form, setForm] = useState({ id: "", name: "", kind: KINDS[0], chain: "near", asset: "USDT", address: "" });
  const [busy, setBusy] = useState(false);
  const disabled = busy || !form.id.trim() || !form.name.trim() || !form.address.trim();
  const taken = existingIds.includes(form.id.trim());

  const idHint = useMemo(() => {
    const slug = form.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "payee-id";
  }, [form.name]);

  async function submit(event) {
    event.preventDefault();
    if (disabled) return;
    // The API upserts on id: posting an existing id would replace that record,
    // replacing its address and demoting an approved payee back to draft. Refuse
    // here rather than clobber silently.
    if (taken) {
      toast.error(`Payee id "${form.id.trim()}" already exists — pick another`);
      return;
    }
    setBusy(true);
    try {
      await createPayee({
        id: form.id.trim(),
        name: form.name.trim(),
        kind: form.kind,
        chain: form.chain,
        asset: form.asset,
        address: form.address.trim(),
      });
      toast.success("Payee onboarded as draft — approve it from the table");
      setForm({ id: "", name: "", kind: KINDS[0], chain: "near", asset: "USDT", address: "" });
      onCreated?.();
    } catch (error) {
      toast.error(error?.message || "Could not onboard this payee");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <Notice title="Draft first, approval second">
        New payees land as draft / in review. Policy holds their first payment until a human approves them below.
      </Notice>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="payee-id">Payee ID</Label>
          <Input
            id="payee-id"
            value={form.id}
            onChange={(event) => setForm({ ...form, id: event.target.value })}
            placeholder={idHint}
            aria-invalid={taken || undefined}
          />
          {taken ? <p className="text-[11px] text-rose-600">That id is already taken — choose another.</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="payee-kind">Kind</Label>
          <Select value={form.kind} onValueChange={(value) => setForm({ ...form, kind: value })}>
            <SelectTrigger id="payee-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {kind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="payee-name">Display name</Label>
        <Input
          id="payee-name"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="Ada Lovelace"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="payee-chain">Chain</Label>
          <Select value={form.chain} onValueChange={(value) => setForm({ ...form, chain: value })}>
            <SelectTrigger id="payee-chain" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHAINS.map((chain) => (
                <SelectItem key={chain} value={chain}>
                  {chain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="payee-asset">Asset</Label>
          <Select value={form.asset} onValueChange={(value) => setForm({ ...form, asset: value })}>
            <SelectTrigger id="payee-asset" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSETS.map((asset) => (
                <SelectItem key={asset} value={asset}>
                  {asset}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="payee-address">Payout address</Label>
        <Input
          id="payee-address"
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          placeholder="ada.near"
          className="font-mono"
        />
      </div>

      <Button type="submit" disabled={disabled} className="h-10 w-full rounded-xl text-[13px] font-medium">
        {busy ? "Onboarding…" : "Onboard payee"}
      </Button>
    </form>
  );
}
