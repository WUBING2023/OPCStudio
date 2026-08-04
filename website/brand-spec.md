# OPC Studio Brand Spec

> Collected: 2026-08-04
> Sources: production web UI tokens and current product screenshots
> Completeness: sufficient for the public release site

## Core Assets

- Product mark: compact three-node organization mark used in the site header and footer.
- Company workspace: `assets/opc-studio-home.png` (2429 x 1248).
- Workbench: `assets/opc-studio-workbench.png` (1280 x 720).
- Product screenshots must remain legible and must not be blurred, recolored, or used only as low-opacity decoration.

## Color System

- Canvas: `#ffffff`
- Quiet surface: `#f7f7f7`
- Ink: `#0d0d0d`
- Muted ink: `#5d5d5d`
- Border: `#dedede`
- OPC interaction blue: `#0071d9`
- OPC blue hover: `#005db3`
- Success: `#10a37f`
- Warning: `#d97706`
- Error: `#dc2626`
- Graphite media field: `#171717`

These values are taken from `apps/web/src/index.css`. The public site must not introduce an unrelated neon or gradient palette.

## Typography

- Display and body: `Inter`, `Segoe UI`, `PingFang SC`, `Microsoft YaHei`, system sans-serif.
- Data and evidence labels: `ui-monospace`, `SFMono-Regular`, `Consolas`, monospace.
- Use weight, scale, and spacing for hierarchy. Do not introduce a decorative serif display face.

## Signature Detail

The signature composition is a real OPC Studio workspace shown at inspection size, paired with a second real workbench view. Evidence labels use the same blue and green status language as the application.

## Avoid

- Lime or purple technology themes unrelated to the application.
- Gradients, glow effects, decorative orbs, and fake browser chrome.
- Product screenshots blurred into atmospheric backgrounds without a clear, inspectable version.
- Excessive cards, pill-shaped labels, or visual claims without evidence.
