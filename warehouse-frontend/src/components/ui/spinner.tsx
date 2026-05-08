import { cn } from "@/lib/utils";

interface SpinnerProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function Spinner({ className, size = "md" }: SpinnerProps) {
  const sizeClass = { sm: "h-4 w-4", md: "h-6 w-6", lg: "h-10 w-10" }[size];
  return (
    <div
      className={cn(
        "animate-spin rounded-full border-2 border-gray-200 border-t-[#f97316]",
        sizeClass,
        className,
      )}
    />
  );
}

export function LoadingOverlay({ text }: { text?: string } = {}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <Spinner size="lg" />
      {text && <span className="text-sm text-gray-500">{text}</span>}
    </div>
  );
}

export function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="rounded-md bg-red-50 border border-red-200 p-4 text-sm text-red-700">
      {message}
    </div>
  );
}
