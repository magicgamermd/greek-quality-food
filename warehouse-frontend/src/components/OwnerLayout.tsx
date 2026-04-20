import { BarChart3, Camera, CreditCard, LogOut, Trophy } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const ownerNavItems = [
  { to: "/owner/dashboard", label: "Анализи", icon: BarChart3, end: true },
  { to: "/owner/scan", label: "Сканирай", icon: Camera, end: false },
  { to: "/owner/payments", label: "Плащания", icon: CreditCard, end: true },
  { to: "/owner/top", label: "Топ", icon: Trophy, end: true },
];

const ownerRouteNames: Record<string, string> = {
  "/owner": "Анализи",
  "/owner/dashboard": "Анализи",
  "/owner/scan": "Сканиране на фактура",
  "/owner/payments": "Плащания",
  "/owner/top": "Топ продукти и партньори",
  "/owner/incoming": "Приемане на доставки",
  "/owner/incoming/scan": "Сканиране на фактура",
};

export function OwnerLayout() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const currentRouteName =
    ownerRouteNames[location.pathname] ?? ownerRouteNames["/owner"];

  const handleLogout = () => {
    logout();
    navigate("/owner/login");
  };

  return (
    // No `overflow-hidden` + no inner `overflow-y-auto` on <main>.
    // Letting the window scroll natively lets Safari's auto-hide-chrome
    // behaviour kick in (URL bar + bottom toolbar collapse on scroll-down).
    // When installed as a PWA ("Add to Home Screen") Safari chrome is
    // absent entirely so neither behaviour matters.
    <div className="relative min-h-screen bg-[#090c18] text-[#f3f6ff] flex flex-col">
      <div className="pointer-events-none fixed -top-28 -right-24 h-80 w-80 rounded-full bg-[#4f7cff]/16 blur-3xl" />
      <div className="pointer-events-none fixed -bottom-36 -left-24 h-96 w-96 rounded-full bg-[#25c38b]/12 blur-3xl" />

      {/*
        Desktop header: full branding + nav row. On mobile we hide this
        whole thing (`hidden md:block`) because the user browses via the
        bottom tab bar and the header just eats vertical space every time
        she switches tab. A tiny floating logout button below handles the
        rare "log me out" case on phone.
      */}
      <header className="hidden md:block sticky top-0 z-30 border-b border-[#243055] bg-[#090c18]/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-xl border border-[#243055] bg-[#12162a] flex items-center justify-center font-bold text-sm text-[#f97316]">
              ММ
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate text-[#f3f6ff]">
                МЕРТ-М Owner
              </p>
              <p className="text-xs text-[#9aa8d6] truncate">
                {currentRouteName}
              </p>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 rounded-lg border border-[#243055] bg-[#12162a] px-3 py-2 text-xs text-[#f3f6ff] hover:bg-[#161c34] transition-colors"
          >
            <LogOut className="h-4 w-4" />
            <span>Изход</span>
          </button>
        </div>

        <div className="border-t border-[#243055]">
          <nav className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-2">
            {ownerNavItems.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors border",
                    isActive
                      ? "border-[#4f7cff] bg-[rgba(79,124,255,0.2)] text-[#4f7cff]"
                      : "border-transparent text-[#9aa8d6] hover:text-[#f3f6ff] hover:bg-[#12162a]",
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      {/*
        Mobile-only floating logout button. Sits in the top-right corner
        over page content, ~36px round, semi-transparent so it's present
        but unobtrusive. Respects the iOS safe-area-inset-top so it
        doesn't collide with the status bar / Dynamic Island.
      */}
      <button
        onClick={handleLogout}
        aria-label="Изход"
        className="md:hidden fixed right-3 z-30 h-9 w-9 rounded-full border border-[#243055] bg-[#12162a]/80 backdrop-blur flex items-center justify-center text-[#9aa8d6] active:bg-[#1f2544] hover:text-[#f3f6ff]"
        // Mirrors main's padding-top so the button aligns visually with
        // the first row of content (the h1 title).
        style={{ top: "calc(env(safe-area-inset-top) + 12px)" }}
      >
        <LogOut className="h-4 w-4" />
      </button>

      {/*
        Mobile padding:
          - top  = safe-area-inset-top + 8px  → content clears the iOS
            status bar (time / Dynamic Island) when running as a
            standalone PWA. Without this, h1 titles like "Анализи" end
            up directly under the clock.
          - pb-32 leaves room for the fixed bottom nav (~72px) + the
            home-indicator safe-area (~34px on modern iPhones) + visual
            breathing space.
        On desktop (md+) the sticky <header> already provides top cushion.
        No overflow-y here — scroll happens on <body> so Safari's auto-hide
        URL bar actually triggers on scroll.
      */}
      <main
        className="relative flex-1 pb-32 md:pb-0"
        // Inline style so env() resolves per-device. On desktop browsers
        // safe-area-inset-top is 0 so this collapses to 8px — no layout
        // noise. On iPhone standalone PWA it grows to ~50px (clearing the
        // Dynamic Island / clock strip).
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 8px)" }}
      >
        <Outlet />
      </main>

      {/*
        Mobile bottom nav. Two tricks to un-bury the icons from the
        home-indicator:
          - pb-[env(safe-area-inset-bottom)] adds the iOS gesture-bar height
            as extra padding so tap targets clear the indicator.
          - py-3 (was py-2.5) lifts them another ~4px for comfortable reach.
        The inner grid handles the actual visuals while the outer <nav>
        owns the safe-area cushion.
      */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-[#243055] bg-[#12162a]/95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="grid grid-cols-4 max-w-6xl mx-auto">
          {ownerNavItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center justify-center gap-1 py-3 text-xs font-medium border-t-2 transition-colors",
                  isActive
                    ? "text-[#4f7cff] border-[#4f7cff]"
                    : "text-[#9aa8d6] border-transparent hover:text-[#f3f6ff]",
                )
              }
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
