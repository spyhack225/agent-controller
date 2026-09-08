import { Cable, Fingerprint, KeyRound, PackagePlus } from "lucide-react";

import { Button, cn } from "../ui";

export type DeviceOnboardingFlow = "preprovision" | "register" | "claim";

export function DeviceActionCluster({
  onOpen,
  className,
}: {
  onOpen: (flow: DeviceOnboardingFlow) => void;
  className?: string;
}) {
  return (
    <div className={cn("device-action-cluster", className)} aria-label="Add a device">
      <Button size="sm" onClick={() => onOpen("preprovision")}>
        <Fingerprint className="size-3.5" /> Pre-provision
      </Button>
      <Button size="sm" onClick={() => onOpen("register")}>
        <PackagePlus className="size-3.5" /> Register
      </Button>
      <Button size="sm" variant="primary" onClick={() => onOpen("claim")}>
        <KeyRound className="size-3.5" /> Claim
      </Button>
    </div>
  );
}

export function EnvironmentActionCluster({
  onConnect,
  className,
}: {
  onConnect: () => void;
  className?: string;
}) {
  return (
    <div className={cn("environment-action-cluster", className)}>
      <Button size="sm" variant="primary" onClick={onConnect}>
        <Cable className="size-3.5" /> Connect environment
      </Button>
    </div>
  );
}
