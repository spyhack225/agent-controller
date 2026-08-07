import {
  Cable,
  CircleAlert,
  Cpu,
  LogIn,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

import type { AuthConfig, ClerkBridge } from "../types";
import { Button } from "../ui";

interface LandingPageProps {
  authConfig: AuthConfig;
  clerk: ClerkBridge | null;
}

const steps = [
  {
    icon: Cable,
    title: "Pair your T3 Code host",
    body: "Run one setup command on the machine already running T3 Code. Provider logins and network prompts stay on that machine.",
  },
  {
    icon: TerminalSquare,
    title: "Launch your first thread",
    body: "Pick a workspace and model from the live snapshot. A thread that actually replies is what proves the connection works.",
  },
  {
    icon: Cpu,
    title: "Add a controller, or don't",
    body: "Claim the hardware controller and point it at that thread — or stay browser-only. Both are complete setups.",
  },
];

/**
 * The signed-out front door. Before this existed, an unauthenticated visitor was dropped into the
 * full app shell — empty sidebar, empty Operate page, and a small "Sign in" button in the corner —
 * with nothing explaining what the product was or what signing in would get them.
 */
export function LandingPage({ authConfig, clerk }: LandingPageProps) {
  const clerkReady = Boolean(authConfig.clerk?.enabled && clerk);
  const checkingSession = clerkReady && !clerk?.loaded;

  return (
    <div className="landing">
      <header className="landing__bar">
        <div className="landing__brand">
          <div className="brand-mark" aria-hidden="true">
            <TerminalSquare className="size-4" />
          </div>
          <div className="brand-copy">
            <p className="brand-copy__name">Agent Controller</p>
            <p className="brand-copy__meta">NIGHTLY</p>
          </div>
        </div>
        {clerkReady ? (
          <Button variant="ghost" size="sm" disabled={checkingSession} onClick={() => clerk?.openSignIn()}>
            <LogIn className="size-4" /> Sign in
          </Button>
        ) : null}
      </header>

      <main className="landing__main" id="main-content">
        <section className="landing__hero">
          <p className="eyebrow">Remote control for your own agents</p>
          <h1>Drive T3 Code from a controller, or from anywhere.</h1>
          <p className="landing__lede">
            Agent Controller is the control plane between you and the T3 Code environment on your own
            machine. It authenticates you, applies your policy, and dispatches the command. It never
            runs the agent itself — your code and your models stay where they already are.
          </p>

          {clerkReady ? (
            <div className="landing__actions">
              <Button size="lg" variant="primary" disabled={checkingSession} onClick={() => clerk?.openSignUp()}>
                <Sparkles className="size-4" />
                {checkingSession ? "Checking session…" : "Create your account"}
              </Button>
              <Button size="lg" variant="ghost" disabled={checkingSession} onClick={() => clerk?.openSignIn()}>
                I already have one
              </Button>
            </div>
          ) : (
            // A self-hoster who has not finished wiring Clerk needs the reason, not a dead button.
            <div className="landing__notice" role="status">
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">Sign-in is not configured on this gateway.</p>
                <p className="mt-1 text-xs leading-relaxed">
                  Set <code>CLERK_PUBLISHABLE_KEY</code> and <code>CLERK_SECRET_KEY</code> in the
                  gateway environment, then restart the service.
                </p>
              </div>
            </div>
          )}

          <p className="landing__reassure">
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
            Every command is policy-screened, and risky ones wait for your approval.
          </p>
        </section>

        <section className="landing__steps" aria-label="What setup looks like">
          <h2 className="eyebrow">Three steps to first run</h2>
          <ol>
            {steps.map((step, index) => {
              const Icon = step.icon;
              return (
                <li key={step.title}>
                  <div className="landing__step-head">
                    <div className="landing__step-icon" aria-hidden="true">
                      <Icon className="size-4" />
                    </div>
                    <span className="landing__step-index" aria-hidden="true">Step {index + 1}</span>
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              );
            })}
          </ol>
        </section>
      </main>
    </div>
  );
}
