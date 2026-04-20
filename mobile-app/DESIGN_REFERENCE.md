# Greek Foods Mobile App — Design Reference Guide

## Color Palette

```
┌─────────────────────────────────────────┐
│ BASE BACKGROUNDS                        │
├─────────────────────────────────────────┤
│ #0a0a14  ███  background (main)         │
│ #12121e  ███  surface (subtle content)   │
│ #1a1a2e  ███  surfaceElevated (cards)    │
│ #232338  ███  surfaceHover (interactive) │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ BORDERS & DIVIDERS                      │
├─────────────────────────────────────────┤
│ #252540  ███  border (primary)           │
│ #323245  ███  borderLight (secondary)    │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ PRIMARY BRAND COLORS                    │
├─────────────────────────────────────────┤
│ #6366f1  ███  accent (indigo)            │
│ #8b5cf6  ███  accentAlt (violet)         │
│ #818cf8  ███  accentLight (lighter)      │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ SEMANTIC COLORS                         │
├─────────────────────────────────────────┤
│ #10b981  ███  success (green)            │
│ #f59e0b  ███  warning (amber)            │
│ #ef4444  ███  danger (red)               │
│ #3b82f6  ███  info (blue)                │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ TEXT COLORS                             │
├─────────────────────────────────────────┤
│ #f1f5f9  ███  text (primary)             │
│ #94a3b8  ███  textSecondary              │
│ #475569  ███  textMuted (disabled)       │
│ #0f172a  ███  textInverse (dark text)    │
└─────────────────────────────────────────┘
```

## Component Styles

### Cards
```
Background: #1a1a2e (surfaceElevated)
Border: 1px solid #252540
Padding: 16px
Border Radius: 16px
Shadow: elevation 3, opacity 0.1
```

### KPI Cards
```
Header Separator: 1px solid #252540, bottom
Accent Bar: 3px width, colored accent
Label: 12px, uppercase, #94a3b8 (textSecondary)
Value: 32px, weight 800, #f1f5f9 (text)
Subtitle: 12px, #475569 (textMuted)
```

### Buttons
```
Primary Button: 
  Background: #6366f1 (accent)
  Text: #ffffff
  Padding: 12-14px vertical, 16-28px horizontal
  Border Radius: 12px
  Shadow: elevation 4, opacity 0.3

Secondary Button:
  Background: #1a1a2e (surfaceElevated)
  Border: 1px solid #252540
  Text: #94a3b8 (textSecondary)
```

### Input Fields
```
Background: #12121e (surface)
Border: 1px solid #252540
Text Color: #f1f5f9
Placeholder: #475569 (textMuted)
Padding: 12px horizontal, 12px vertical
Border Radius: 12px
```

### Status Badges
```
Success: bg #10b981 + 20% opacity, text #10b981
Warning: bg #f59e0b + 20% opacity, text #f59e0b
Danger:  bg #ef4444 + 20% opacity, text #ef4444
Info:    bg #3b82f6 + 20% opacity, text #3b82f6

Padding: 10px horizontal, 4px vertical
Border Radius: 20px
Font Size: 12px, weight 600
```

### Tab Bar
```
Active Tab: #6366f1 (accent), text white, larger icon (24px)
Inactive Tab: #94a3b8 (textSecondary), smaller icon (20px)
Background: #1a1a2e (surfaceElevated)
Border Top: 1px solid #252540
Badge: #ef4444 (danger), min-width 18px, height 18px
```

## Typography

### Heading Styles
```
H1: 28px, weight 800  (brand title)
H2: 20-22px, weight 700 (screen titles)
H3: 18px, weight 700  (modal titles)
H4: 16px, weight 700  (section headers)
H5: 14px, weight 600  (labels)
```

### Body Styles
```
Body Large: 16px, weight 500 (descriptions)
Body Regular: 14-15px, weight 400-500 (body text)
Body Small: 12px, weight 400-600 (secondary info)
Caption: 11px, weight 400-500 (meta info)
```

## Spacing System

```
xs: 4px
sm: 8px
md: 12px
lg: 16px
xl: 20px
2xl: 24px
3xl: 32px
```

## Border Radius

```
None: 0px
sm: 8px
md: 12px
lg: 14px
xl: 16px
2xl: 20px
full: 999px
```

## Shadows & Elevation

```
Subtle: elevation 3, shadow offset (0,2), opacity 0.1, radius 8
Normal: elevation 4, shadow offset (0,4), opacity 0.15, radius 12
Strong: elevation 5, shadow offset (0,8), opacity 0.2, radius 16
Button Focus: elevation 4, offset (0,4), opacity 0.3, radius 8
```

## Component-Specific Guidelines

### DashboardScreen
- Header greeting: "Добър ден, [name] 👋"
- KPI Grid: 2 columns, gap 10px
- Section Label: uppercase, #6366f1, letter-spacing 1.2px
- Expiring Alert: 14px title, 12px subtitle, amber accent

### InventoryScreen
- Search Input: rounded 12px, light text color
- Filter Chips: active = indigo bg, inactive = surface bg
- Product Cards: icon 44x44px, rounded 12px
- Stock Bar: visual progress (green=normal, red=low)

### IncomingGoodsScreen
- Delivery Cards: supplier name, invoice number, status badge
- FAB Button: accent color, positioned bottom-right
- Modal Headers: consistent padding, border-bottom divider
- Status Colors:
  - Pending: amber
  - Received: blue
  - Confirmed: green
  - Cancelled: red

### LoginScreen
- Logo Box: 72x72px, accent color, shadow effect
- Form Card: surfaceElevated, border 1px
- Inputs: surface bg, full width
- Remember Switch: track changes color with accent

## Animation Guidelines

- Skeleton Loader: opacity pulse 0.6 → 1 → 0.6, duration 800ms
- Button Press: opacity 0.6 on disabled state
- Badge Pulse: using opacity animation for loading states
- Transitions: 300ms ease-in-out for state changes

## Accessibility

- Contrast Ratio: All text meets WCAG AA standards
- Touch Targets: Minimum 44x44px for interactive elements
- Icons: Meaningful emoji paired with text labels
- Color Not Only: Status uses color + icon/text
- Typography: Clear hierarchy with size/weight differences

## Dark Mode

✅ **Complete dark theme implementation** — no light mode variant needed
- All backgrounds are dark (navy/slate)
- All text is light (slate-100 to slate-900)
- Accent colors provide sufficient contrast
- No white backgrounds in production UI
