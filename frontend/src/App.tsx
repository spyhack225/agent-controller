import {
  Activity,
  Boxes,
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleDot,
  Folder,
  GalleryVerticalEnd,
  Menu,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Sparkles,
  Sun,
  TerminalSquare,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { type ClaimLink, readClaimLink } from "./claimLink";
import { useController } from "./controller";
import { ActivityPage } from "./features/ActivityPage";
import { ClaimPage } from "./features/ClaimPage";
import { DevicesPage } from "./features/DevicesPage";
import { EnvironmentsPage } from "./features/EnvironmentsPage";
import { LandingPage } from "./features/LandingPage";
import { MediaPage } from "./features/MediaPage";
import { OnboardingPage } from "./features/OnboardingPage";
import { OperatePage } from "./features/OperatePage";
import { QuickPage } from "./features/QuickPage";
import { SettingsPage } from "./features/SettingsPage";
import type { AuthConfig, ClerkBridge, PageId } from "./types";
import {
  Button,
  ConfirmProvider,
  IconButton,
  StatusBadge,
  Toast,
  cn,
} from "./ui";

interface AppProps {
  authConfig: AuthConfig;
  clerk?: ClerkBridge | null;
}

interface NavItem {
  id: PageId;
  label: string;
  shortLabel: string;
  description: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  {
    id: "quick",
    label: "Quick control",
    shortLabel: "Quick",
    description: "Push-to-talk, camera, approvals, and macros",
    icon: Zap,
  },
  {
    id: "operate",
    label: "Operate",
    shortLabel: "Operate",
    description: "Dispatch and supervise agent work",
    icon: TerminalSquare,
  },
  {
    id: "devices",
    label: "Devices",
    shortLabel: "Devices",
    description: "Claim and configure controllers",
    icon: Boxes,
  },
  {
    id: "environments",
    label: "Environments",
    shortLabel: "T3",
    description: "Pair T3 Code workstations",
    icon: Cable,
  },
  {
    id: "media",
    label: "Media",
    shortLabel: "Media",
    description: "Capture image and audio context",
    icon: GalleryVerticalEnd,
  },
  {
    id: "activity",
    label: "Activity",
    shortLabel: "Activity",
    description: "Approvals, commands, and audit",
    icon: Activity,
  },
  {
    id: "settings",
    label: "Settings",
    shortLabel: "Settings",
    description: "Access, privacy, and diagnostics",
    icon: Settings,
  },
];

const onboardingNavItem: NavItem = {
  id: "onboarding",
  label: "Setup",
  shortLabel: "Setup",
  description: "T3, workspace, model, and controller",
  icon: Sparkles,
};

const navById = new Map(navItems.map((item) => [item.id, item]));

function nav(id: PageId): NavItem {
  const item = navById.get(id);
  if (!item) throw new Error(`Unknown navigation target: ${id}`);
  return item;
}

// The phone bar carries the five destinations a handset operator actually needs; the rest
// stay one tap away behind the slide-out sidebar so nothing here has to scroll at 375px.
const mobileNavItems: NavItem[] = [
  nav("quick"),
  nav("operate"),
  nav("activity"),
  nav("media"),
  nav("settings"),
];

function readPage(): PageId {
  const value = window.location.hash.replace(/^#\/?/, "") as PageId;
  return value === "onboarding" || navItems.some((item) => item.id === value) ? value : "operate";
}

function readTheme(): "light" | "dark" {
  try {
    const stored = localStorage.getItem("agentControllerTheme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall back to the user's system preference.
  }
  return "dark";
}

function readMobileViewport(): boolean {
  return window.matchMedia?.("(max-width: 820px)").matches ?? false;
}

function connectionTone(connection: string) {
  if (connection === "live") return "live" as const;
  if (connection === "connected") return "success" as const;
  if (connection === "reconnecting" || connection === "connecting") return "warning" as const;
  if (connection === "error") return "danger" as const;
  return "neutral" as const;
}

function AppContent({ authConfig, clerk = null }: AppProps) {
  const controller = useController({ authConfig, clerk });
  const c = controller;
  const [page, setPageState] = useState<PageId>(readPage);
  // Read once, before anything else can rewrite the URL. A scanned QR is a one-shot arrival.
  const [claimLink, setClaimLink] = useState<ClaimLink | null>(() => readClaimLink());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(readMobileViewport);
  const [theme, setTheme] = useState<"light" | "dark">(readTheme);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const onboardingAutoOpenedRef = useRef(false);

  const setPage = (next: PageId) => {
    setPageState(next);
    window.location.hash = next;
    setMobileMenuOpen(false);
  };

  useEffect(() => {
    const onHashChange = () => setPageState(readPage());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const onChange = (event: MediaQueryListEvent) => {
      setMobileViewport(event.matches);
      if (!event.matches) setMobileMenuOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        sidebarSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("agentControllerTheme", theme);
    } catch {
      // Theme persistence is a convenience only.
    }
  }, [theme]);

  useEffect(() => {
    if (!c.notice) return;
    const timeout = window.setTimeout(() => c.setNotice(null), 5200);
    return () => window.clearTimeout(timeout);
  }, [c.notice, c.setNotice]);

  useEffect(() => {
    // A pending claim link owns the screen; auto-opening the wizard underneath it would strand the
    // scanned code the moment the claim resolves and hands off deliberately.
    if (claimLink) return;
    if (onboardingAutoOpenedRef.current || !c.authenticated || !c.onboardingLoaded || !c.onboarding) return;
    onboardingAutoOpenedRef.current = true;
    const initialRoute = window.location.hash.replace(/^#\/?/, "");
    const shouldAutoOpen = (initialRoute === "" || initialRoute === "operate")
      && (c.onboarding.status === "not_started" || c.onboarding.status === "in_progress");
    if (shouldAutoOpen) setPage("onboarding");
  }, [c.authenticated, c.onboarding, c.onboardingLoaded, claimLink]);

  const activeNav = page === "onboarding"
    ? onboardingNavItem
    : navById.get(page) ?? nav("operate");
  const normalizedSidebarQuery = sidebarQuery.trim().toLowerCase();
  const visibleEnvironments = c.environments.filter((environment) =>
    !normalizedSidebarQuery || environment.label.toLowerCase().includes(normalizedSidebarQuery)
  );
  const visibleProjects = c.projects.filter((project) => {
    const label = project.title ?? project.name ?? project.workspaceRoot ?? project.id;
    return !normalizedSidebarQuery
      || label.toLowerCase().includes(normalizedSidebarQuery)
      || c.threads.some((thread) =>
        thread.projectId === project.id && thread.label.toLowerCase().includes(normalizedSidebarQuery)
      );
  });
  const ungroupedThreads = c.threads.filter((thread) =>
    !thread.projectId
    && (!normalizedSidebarQuery || thread.label.toLowerCase().includes(normalizedSidebarQuery))
  );
  const activeThread = c.threads.find((thread) => thread.id === c.selectedThreadId);
  const topbarTitle = page === "operate"
    ? activeThread?.label ?? (c.selectedEnvironment ? "No active thread" : "No environment selected")
    : activeNav.label;
  const topbarContext = page === "operate"
    ? c.selectedEnvironment?.label ?? "Select a T3 environment"
    : activeNav.description;
  const counts: Record<PageId, number> = {
    quick: c.pendingApprovals.length,
    operate: c.pendingApprovals.length,
    devices: c.devices.length,
    environments: c.environments.length,
    media: c.media.length,
    activity: c.pendingApprovals.length,
    settings: 0,
    onboarding: 0,
  };
  const pageContent = useMemo(() => {
    switch (page) {
      case "quick":
        return <QuickPage controller={controller} onNavigate={setPage} />;
      case "devices":
        return <DevicesPage controller={controller} />;
      case "environments":
        return <EnvironmentsPage controller={controller} />;
      case "media":
        return <MediaPage controller={controller} />;
      case "activity":
        return <ActivityPage controller={controller} />;
      case "settings":
        return <SettingsPage controller={controller} />;
      case "onboarding":
        return <OnboardingPage controller={controller} onNavigate={setPage} />;
      default:
        return <OperatePage controller={controller} />;
    }
  }, [controller, page]);

  if (claimLink) {
    return (
      <ClaimPage
        controller={controller}
        link={claimLink}
        onDone={async ({ device }) => {
          setClaimLink(null);
          if (!device) {
            setPage("devices");
            return;
          }
          await c.refreshAll();
          c.setSelectedDeviceId(device.id);
          // A claimed controller still has to be pointed at an environment and thread. Land on the
          // wizard's device step when setup is unfinished; otherwise Devices is the right home.
          const setupIncomplete = c.onboarding && c.onboarding.status !== "completed";
          if (setupIncomplete) {
            await c.saveOnboarding({
              status: "in_progress",
              currentStep: "device",
              device: { mode: "claim", deviceId: device.id, credentialConfirmed: false },
            });
            setPage("onboarding");
          } else {
            setPage("devices");
          }
        }}
      />
    );
  }

  // A signed-out visitor gets the front door, not an empty app shell. Ordered after the claim
  // branch: a scanned QR has its own signed-out screen that keeps the code in hand through sign-in.
  if (!c.authenticated) {
    // `authenticated` is false both for "signed out" and for "Clerk has not answered yet". Showing
    // the landing page during the second would flash a marketing page at a returning user, so an
    // unresolved session gets a neutral hold instead.
    if (authConfig.clerk?.enabled && clerk && !clerk.loaded) {
      return <div className="landing landing--resolving" role="status" aria-label="Restoring your session" />;
    }
    return <LandingPage authConfig={authConfig} clerk={clerk} />;
  }

  return (
    <div className="app-shell" data-sidebar-collapsed={sidebarCollapsed || undefined}>
      <aside
        className={cn("sidebar", mobileMenuOpen && "sidebar--mobile-open")}
        aria-label="Primary navigation"
        aria-hidden={mobileViewport && !mobileMenuOpen ? true : undefined}
        inert={mobileViewport && !mobileMenuOpen ? true : undefined}
      >
        <div className="sidebar__brand">
          <div className="brand-mark" aria-hidden="true">
            <TerminalSquare className="size-4" />
          </div>
          <div className="brand-copy">
            <p className="brand-copy__name">Agent Controller</p>
            <p className="brand-copy__meta">NIGHTLY</p>
          </div>
          {mobileViewport ? (
            <IconButton
              className="mobile-menu-close"
              variant="ghost"
              icon={X}
              label="Close navigation"
              onClick={() => setMobileMenuOpen(false)}
            />
          ) : (
            <IconButton
              className="sidebar-brand-collapse"
              variant="ghost"
              icon={sidebarCollapsed ? ChevronRight : ChevronLeft}
              label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setSidebarCollapsed((value) => !value)}
            />
          )}
        </div>

        <div className="sidebar-search">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            ref={sidebarSearchRef}
            type="search"
            value={sidebarQuery}
            onChange={(event) => setSidebarQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search environments and projects"
          />
          <kbd>⌘K</kbd>
        </div>

        <nav className="sidebar__nav">
          <div className="sidebar__section-heading">
            <span>Workspace</span>
          </div>
          {c.onboardingLoaded && c.onboarding?.status !== "completed" ? (
            <button
              type="button"
              className="nav-item"
              data-active={page === "onboarding" || undefined}
              onClick={() => setPage("onboarding")}
              aria-current={page === "onboarding" ? "page" : undefined}
              title={sidebarCollapsed ? "Setup" : undefined}
            >
              <Sparkles className="nav-item__icon" />
              <span className="nav-item__copy">
                <span className="nav-item__label">Finish setup</span>
              </span>
              <span className="resource-row__status resource-row__status--live" aria-label="Setup incomplete" />
            </button>
          ) : null}
          {[nav("quick"), nav("operate"), nav("activity")].map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const count = counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                className="nav-item"
                data-active={active || undefined}
                onClick={() => setPage(item.id)}
                aria-current={active ? "page" : undefined}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <Icon className="nav-item__icon" />
                <span className="nav-item__copy">
                  <span className="nav-item__label">{item.label}</span>
                </span>
                {count ? (
                  <span className={cn("nav-count", item.id === "activity" || item.id === "operate" ? "nav-count--warning" : "")}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}

          <div className="sidebar__section-heading sidebar__section-heading--resources">
            <span>Environments</span>
            <span className="sidebar__section-actions">
              <button
                type="button"
                aria-label="Refresh environments"
                title="Refresh environments"
                disabled={!c.authenticated}
                onClick={() => void c.refreshAll()}
              >
                <ChevronsUpDown className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Add environment"
                title="Add environment"
                onClick={() => setPage("environments")}
              >
                <Plus className="size-3.5" />
              </button>
            </span>
          </div>

          <div className="resource-tree">
            {visibleEnvironments.length ? visibleEnvironments.map((environment) => {
              const selected = environment.id === c.selectedEnvironmentId;
              return (
                <div key={environment.id} className="resource-group">
                  <button
                    type="button"
                    className="resource-row resource-row--environment"
                    data-active={selected || undefined}
                    onClick={() => {
                      c.setSelectedEnvironmentId(environment.id);
                      setPage("operate");
                      void c.run(
                        `sidebar-snapshot-${environment.id}`,
                        "T3 workspace loaded.",
                        () => c.loadSnapshot(environment.id),
                      );
                    }}
                  >
                    <ChevronDown className={cn("resource-row__chevron", !selected && "-rotate-90")} />
                    <Server className="resource-row__icon" />
                    <span className="resource-row__label">{environment.label}</span>
                    <span
                      className={cn(
                        "resource-row__status",
                        environment.status === "reachable" && "resource-row__status--live",
                        (environment.status === "unreachable" || environment.status === "token_expired")
                          && "resource-row__status--danger",
                      )}
                      title={environment.status ?? "unknown"}
                      role="img"
                      aria-label={`Environment status: ${environment.status ?? "unknown"}`}
                    />
                  </button>

                  {selected ? (
                    <div className="resource-children">
                      {visibleProjects.length ? visibleProjects.map((project) => {
                        const projectLabel = project.title ?? project.name ?? project.workspaceRoot ?? project.id;
                        const projectMatches = projectLabel.toLowerCase().includes(normalizedSidebarQuery);
                        const projectThreads = c.threads.filter((thread) =>
                          thread.projectId === project.id
                          && (!normalizedSidebarQuery
                            || projectMatches
                            || thread.label.toLowerCase().includes(normalizedSidebarQuery))
                        );
                        return (
                          <div key={project.id} className="resource-project">
                            <button
                              type="button"
                              className="resource-row resource-row--project"
                              data-active={project.id === c.selectedProjectId || undefined}
                              onClick={() => {
                                c.setSelectedProjectId(project.id);
                                setPage("operate");
                              }}
                            >
                              <Folder className="resource-row__icon" />
                              <span className="resource-row__label">{projectLabel}</span>
                            </button>
                            {projectThreads.map((thread) => (
                              <button
                                key={thread.id}
                                type="button"
                                className="resource-thread"
                                data-active={thread.id === c.selectedThreadId || undefined}
                                onClick={() => {
                                  c.setSelectedProjectId(project.id);
                                  c.setSelectedThreadId(thread.id);
                                  setPage("operate");
                                }}
                              >
                                <CircleDot className="size-3" />
                                <span>{thread.label}</span>
                                <span className="resource-thread__status">{thread.status ?? ""}</span>
                              </button>
                            ))}
                          </div>
                        );
                      }) : ungroupedThreads.length ? ungroupedThreads.map((thread) => (
                        <button
                          key={thread.id}
                          type="button"
                          className="resource-thread"
                          data-active={thread.id === c.selectedThreadId || undefined}
                          onClick={() => {
                            c.setSelectedThreadId(thread.id);
                            setPage("operate");
                          }}
                        >
                          <CircleDot className="size-3" />
                          <span>{thread.label}</span>
                        </button>
                      )) : (
                        <button
                          type="button"
                          className="resource-empty"
                          onClick={() => setPage("operate")}
                        >
                          No threads yet
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            }) : (
              <button type="button" className="resource-empty resource-empty--root" onClick={() => setPage("environments")}>
                <Plus className="size-3.5" />
                {normalizedSidebarQuery ? "No matching environments" : "Connect an environment"}
              </button>
            )}
          </div>

          <div className="sidebar__section-heading sidebar__section-heading--control">
            <span>Control plane</span>
          </div>
          {[nav("devices"), nav("environments"), nav("media")].map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const count = counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                className="nav-item"
                data-active={active || undefined}
                onClick={() => setPage(item.id)}
                aria-current={active ? "page" : undefined}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <Icon className="nav-item__icon" />
                <span className="nav-item__copy">
                  <span className="nav-item__label">{item.label}</span>
                </span>
                {count ? <span className="nav-count">{count}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <button
            type="button"
            className="account-chip"
            onClick={() => setPage("settings")}
            aria-label="Open settings"
            title={sidebarCollapsed ? "Settings" : undefined}
          >
            <Settings className="size-4 shrink-0" />
            <span className="account-chip__copy">
              <span className="truncate text-sm font-medium">Settings</span>
              <span className="truncate text-[10px] text-sidebar-muted">
                {clerk?.userLabel ?? (c.authenticated ? "Authenticated user" : "Not signed in")}
              </span>
            </span>
          </button>
        </div>
      </aside>

      {mobileMenuOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}

      <div className="workspace" inert={mobileViewport && mobileMenuOpen ? true : undefined}>
        <header className="topbar">
          <div className="flex min-w-0 items-center gap-3">
            <IconButton
              className="mobile-menu-trigger"
              variant="ghost"
              icon={Menu}
              label="Open navigation"
              onClick={() => setMobileMenuOpen(true)}
            />
            <div className="min-w-0">
              <div className="topbar__title-line">
                <h1 className="truncate font-display text-base font-semibold sm:text-lg">{topbarTitle}</h1>
                <span className="topbar__context">{topbarContext}</span>
              </div>
            </div>
          </div>
          <div className="topbar__actions">
            {!c.authenticated ? (
              <Button
                size="sm"
                onClick={() => {
                  if (clerk) clerk.openSignIn();
                  else setPage("settings");
                }}
              >
                Sign in
              </Button>
            ) : null}
            {page !== "onboarding" ? (
              <Button
                className="topbar-add-action hidden sm:inline-flex"
                size="sm"
                onClick={() => setPage("operate")}
              >
                <Plus className="size-4" /> Add action
              </Button>
            ) : null}
            {c.authenticated ? (
              <StatusBadge
                className="hidden sm:inline-flex"
                tone={connectionTone(c.connection)}
                label={c.connection}
              />
            ) : null}
            <IconButton
              variant="ghost"
              icon={RefreshCw}
              label="Refresh gateway data"
              disabled={!c.authenticated}
              onClick={() => void c.refreshAll()}
            />
            <IconButton
              variant="ghost"
              icon={theme === "dark" ? Sun : Moon}
              label={theme === "dark" ? "Use light theme" : "Use dark theme"}
              onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
            />
          </div>
        </header>

        <main className="workspace__content" id="main-content">
          {pageContent}
        </main>
      </div>

      <nav
        className="mobile-nav"
        aria-label="Mobile navigation"
        inert={mobileViewport && mobileMenuOpen ? true : undefined}
      >
        {mobileNavItems.map((item) => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-active={active || undefined}
              aria-current={active ? "page" : undefined}
              onClick={() => setPage(item.id)}
            >
              <span className="relative">
                <Icon className="size-4.5" />
                {counts[item.id] ? <span className="mobile-nav__dot" /> : null}
              </span>
              <span>{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      {c.notice ? (
        <Toast tone={c.notice.tone} onDismiss={() => c.setNotice(null)}>
          {c.notice.message}
        </Toast>
      ) : null}
    </div>
  );
}

export default function App(props: AppProps) {
  return (
    <ConfirmProvider>
      <AppContent {...props} />
    </ConfirmProvider>
  );
}
