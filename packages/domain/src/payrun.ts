import type { Corridor, Money } from "./money.ts";
import type { OperationStatus } from "./operation.ts";

export type PayRunSource = "csv" | "api" | "invoice" | "schedule";

export type PayRunStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "settled"
  | "partially_settled"
  | "failed";

export interface PayRun {
  readonly id: string;
  readonly orgId: string;
  readonly source: PayRunSource;
  readonly sourceRef?: string;
  readonly period: string;
  readonly currency: string;
  readonly status: PayRunStatus;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface PayRunItem {
  readonly id: string;
  readonly payRunId: string;
  readonly payeeId: string;
  readonly amount: Money;
  readonly corridor: Corridor;
  readonly operationId?: string;
  readonly state: OperationStatus | "pending";
}
