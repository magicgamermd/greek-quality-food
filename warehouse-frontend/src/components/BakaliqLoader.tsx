export function BakaliqLoader({ text = "Сканиране..." }: { text?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 200 200"
        style={{ width: 180, height: 180, display: "block" }}
      >
        <defs>
          <style>{`
            .bl-spin-smooth {
              transform-origin: 100px 90px;
              animation: bl-spin 2s linear infinite;
            }
            .bl-spin-dynamic {
              transform-origin: 100px 90px;
              animation: bl-spin 1.8s cubic-bezier(0.68, -0.25, 0.265, 1.25) infinite;
              animation-direction: reverse;
            }
            .bl-float-olive {
              animation: bl-float 2s ease-in-out infinite alternate;
            }
            .bl-pulse-text {
              animation: bl-pulse 1.5s ease-in-out infinite alternate;
            }
            .bl-pulse-text-delayed {
              animation: bl-pulse 1.5s ease-in-out infinite alternate;
              animation-delay: 0.5s;
            }
            @keyframes bl-spin {
              100% { transform: rotate(360deg); }
            }
            @keyframes bl-float {
              0% { transform: translateY(-4px); }
              100% { transform: translateY(4px); }
            }
            @keyframes bl-pulse {
              0% { opacity: 0.4; }
              100% { opacity: 1; }
            }
          `}</style>
          <radialGradient id="bl-oliveGrad" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#fbbf77" />
            <stop offset="100%" stopColor="#ea580c" />
          </radialGradient>
        </defs>

        {/* Background ring */}
        <circle
          cx="100"
          cy="90"
          r="50"
          fill="none"
          stroke="#fff7ed"
          strokeWidth="3"
        />

        {/* Main navy spinning ring */}
        <circle
          cx="100"
          cy="90"
          r="50"
          fill="none"
          stroke="#0a1628"
          strokeWidth="4"
          strokeDasharray="90 224"
          strokeLinecap="round"
          className="bl-spin-smooth"
        />

        {/* Inner orange reverse ring */}
        <circle
          cx="100"
          cy="90"
          r="42"
          fill="none"
          stroke="#f97316"
          strokeWidth="2"
          strokeDasharray="40 223"
          strokeLinecap="round"
          className="bl-spin-dynamic"
        />

        {/* Floating spark */}
        <g className="bl-float-olive">
          <path d="M 114 62 Q 130 50 135 65 Q 120 75 114 62 Z" fill="#f97316" />
          <path d="M 108 70 Q 92 58 88 70 Q 100 82 108 70 Z" fill="#fb923c" />
          <path
            d="M 103 76 Q 106 66 114 62"
            fill="none"
            stroke="#0a1628"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <ellipse
            cx="100"
            cy="95"
            rx="14"
            ry="20"
            fill="url(#bl-oliveGrad)"
            transform="rotate(15 100 95)"
          />
          <ellipse
            cx="95"
            cy="87"
            rx="3"
            ry="6"
            fill="#FFFFFF"
            opacity="0.4"
            transform="rotate(15 95 87)"
          />
        </g>

        <text
          x="100"
          y="175"
          fontFamily="system-ui, -apple-system, sans-serif"
          fontWeight="800"
          fontSize="14"
          fill="#0a1628"
          textAnchor="middle"
          letterSpacing="2"
          className="bl-pulse-text"
        >
          МЕРТ-М
        </text>
      </svg>

      <p className="text-sm text-muted-foreground animate-pulse">{text}</p>
    </div>
  );
}
