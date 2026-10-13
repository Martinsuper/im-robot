# Design QA — 模型服务单层表单

## Evidence

- Source visual truth: `/Users/duanluyao/.codex/generated_images/01a12b8d-67a3-7d10-a3b0-90ffd5dfe3aa/exec-715caf10-de84-4517-8bce-4937755bf863.png`
- Implementation: in-app browser capture of `http://127.0.0.1:4173/?view=panel`, captured during this run.
- Viewport: 944 × 836 CSS px; implementation device scale factor 1. The source is 1365 × 1180 px, so comparison used layout hierarchy and the same desktop breakpoint rather than pixel-for-pixel dimensions.
- State: Settings tab open, `本地 Ollama` selected, advanced connection settings both closed and expanded.
- Interactions checked: provider selector is available, editable Base URL / Model / API Key fields render, advanced parameters expand, save state remains disabled until there are changes, and save-and-test remains available. The companion, reminder, system, privacy, and advanced groups retain their existing controls after the shared layout treatment.
- Console check: one stale Vite hot-reload warning was retained from an intermediate edit; the subsequent production build and full browser reload completed successfully, and the rendered panel showed no runtime failure.

## Findings

- No P0, P1, or P2 findings.
- The implemented view deliberately retains the product's pale sage palette and narrow settings-shell conventions instead of copying the mock's blue accent. This is an intentional product-system adaptation, not a fidelity defect.

## Fidelity surfaces

- Typography: existing product font stack, sizing, and label weights remain consistent; the new helper copy uses the existing small-label scale.
- Spacing and layout rhythm: the model-service content is a single vertical flow with one outer settings-group boundary; the former inner card is removed. A divider separates provider selection from connection fields.
- Shared settings treatment: all direct content sections inside a settings group now use the same single-surface treatment; consecutive sections use a quiet divider instead of stacked rounded cards. Advanced disclosures use the same flat divider pattern.
- Colors and visual tokens: existing `--piko-*` tokens are used throughout; no new hard-coded palette was introduced.
- Image and icon fidelity: this screen needs no new raster assets. The advanced disclosure uses the existing text-free control pattern.
- Copy: provider-specific hint, local key-storage explanation, and collapsed advanced-settings label give each action immediate context.

## Comparison history

1. Initial implementation exposed the selected-provider context, Base URL, Model, API Key, and the collapsed advanced controls in one flow.
2. Verified the desktop settings page at 944 × 836 and verified the advanced disclosure expands to reveal Temperature and timeout fields.
3. Applied and verified the shared treatment at the same desktop breakpoint: companion preferences no longer sit in a second container, while the existing form controls and grouping remain legible.

## Follow-up polish

- P3: when the settings viewport is very narrow, the form intentionally stays single-column; a future dedicated compact layout could shorten the selected-provider hint.

final result: passed
