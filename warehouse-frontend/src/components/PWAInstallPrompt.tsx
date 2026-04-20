import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISS_KEY = "owner_pwa_install_prompt_dismissed";

function isStandaloneMode(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    nav.standalone === true
  );
}

function isIosDevice(): boolean {
  const ua = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(ua);
}

export function PWAInstallPrompt() {
  const location = useLocation();
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem(DISMISS_KEY) === "1"
      : false,
  );
  const [installed, setInstalled] = useState(() =>
    typeof window !== "undefined" ? isStandaloneMode() : false,
  );
  const [iosDevice] = useState(() =>
    typeof window !== "undefined" ? isIosDevice() : false,
  );

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const isOwnerSurface = location.pathname.startsWith("/owner");

  const visible = useMemo(
    () =>
      isOwnerSurface &&
      !dismissed &&
      !installed &&
      (deferredPrompt != null || iosDevice),
    [isOwnerSurface, dismissed, installed, deferredPrompt, iosDevice],
  );

  if (!visible) return null;

  return (
    <div className="fixed bottom-3 left-3 right-3 z-50 sm:left-auto sm:right-6 sm:w-[360px]">
      <div className="rounded-xl border border-[#243055] bg-[#12162a]/95 shadow-lg p-3 backdrop-blur-sm">
        <div className="text-sm font-semibold text-[#f3f6ff]">
          Инсталирай Owner PWA
        </div>
        <p className="text-xs text-[#9aa8d6] mt-1">
          {deferredPrompt
            ? "Добави owner приложението за бърз достъп до анализи и приемане на доставки."
            : "Safari (iPhone): Share → Add to Home Screen за инсталиране на owner PWA."}
        </p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-[#243055] bg-[#161c34] text-[#f3f6ff] hover:bg-[#1b2340]"
            onClick={() => {
              localStorage.setItem(DISMISS_KEY, "1");
              setDismissed(true);
            }}
          >
            По-късно
          </Button>
          {deferredPrompt ? (
            <Button
              size="sm"
              className="bg-[#4f7cff] hover:bg-[#4672ec] text-white"
              onClick={async () => {
                if (!deferredPrompt) return;
                await deferredPrompt.prompt();
                const choice = await deferredPrompt.userChoice;
                if (choice.outcome === "accepted") {
                  setInstalled(true);
                }
                setDeferredPrompt(null);
              }}
            >
              Инсталирай
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
