import { render, screen } from "@testing-library/react";
import { Activity } from "lucide-react";

import { Button, EmptyState, StatusBadge } from "./ui";

describe("shared interface primitives", () => {
  test("keeps pending actions disabled and announces their state", () => {
    render(<Button busy>Pair environment</Button>);

    const button = screen.getByRole("button", { name: /pair environment/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  test("renders semantic status and actionable empty-state copy", () => {
    render(
      <>
        <StatusBadge tone="success" label="Reachable" />
        <EmptyState
          icon={Activity}
          title="No commands yet"
          description="Send a prompt to begin the timeline."
        />
      </>,
    );

    expect(screen.getByText("Reachable")).toBeVisible();
    expect(screen.getByText("No commands yet")).toBeVisible();
    expect(screen.getByText(/send a prompt/i)).toBeVisible();
  });
});
