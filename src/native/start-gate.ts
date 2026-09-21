export type NativeStartBarrierStatus = Readonly<{
  blocked: boolean;
  state?: "active" | "cleanup_unconfirmed" | "reconciliation_required";
  runId?: string;
}>;

export type NativeStartLeaseStatus = Readonly<{
  busy: boolean;
  runId?: string;
}>;

export function classifyNativeStartSafety(input: {
  barrier: NativeStartBarrierStatus;
  lease: NativeStartLeaseStatus;
  durableRunsBlocked: boolean;
  nativeOperationsBlocked: boolean;
}): "clear" | "busy" | "reconciliation_required" {
  const currentActiveOwner =
    input.barrier.blocked &&
    input.barrier.state === "active" &&
    typeof input.barrier.runId === "string" &&
    input.lease.busy &&
    input.lease.runId === input.barrier.runId;

  if (currentActiveOwner) return "busy";
  if (input.barrier.blocked) return "reconciliation_required";
  if (input.durableRunsBlocked || input.nativeOperationsBlocked)
    return "reconciliation_required";
  if (input.lease.busy) return "busy";
  return "clear";
}
