# Cloudlink — UI/UX and Branding Guide

## Brand
- Product name: **Cloudlink**
- Product category: ISP billing and network operations platform.
- Voice: clear, reliable, professional, operationally focused.
- Avoid copying another vendor's logo, exact layout, proprietary text or protected assets.

## Visual direction
Create an original premium SaaS dashboard:
- Dark navy/charcoal sidebar.
- Light main workspace by default, with optional dark theme.
- Blue/cyan accent family used consistently and sparingly.
- Neutral surfaces, restrained shadows and subtle borders.
- Modern legible typography.
- High information density without clutter.
- Consistent spacing, radii, iconography and component states.

## App shell
- Collapsible sidebar.
- Cloudlink logo/wordmark treatment.
- Organization and branch selector.
- Breadcrumbs.
- Global search/command menu.
- Notifications center.
- User profile and session actions.
- Responsive navigation.
- Theme selector and accessible focus styles.

## Navigation
Dashboard; CRM/Leads; Subscribers; Packages; Subscriptions; Invoices; Payments; Reconciliation; Expenses; Collections; Vouchers; Routers; Network Sessions; Support; Notifications; Reports; Staff & Permissions; Branches; Inventory; Integrations; Audit Logs; Settings.

## Page patterns
- Table pages: search, filters, sorting, pagination, row actions, empty state and bulk operations.
- Detail pages: summary cards, activity timeline, tabs for related records and permission-aware actions.
- Create/edit: validated forms with clear field errors and unsaved-change handling.
- Financial actions: amount, currency, reference, impact and confirmation shown clearly.
- Network actions: target device, intended action, risk, current status and confirmation.
- Reports: filters, metric definitions, charts, tabular detail and export controls.
- Customer portal: simpler navigation and mobile-first invoice/payment flows.

## Interaction requirements
- Use Framer Motion for restrained transitions and micro-interactions.
- Respect `prefers-reduced-motion`.
- Support keyboard navigation and accessible dialogs.
- Provide loading, success, failure and empty states.
- Use optimistic updates only when safe; financial and network state must be confirmed by server responses.
- Every visible button must work or be clearly disabled with an explanation.
- Avoid fake data in production. Demo data must be labelled.

## Accessibility and responsive design
- Semantic HTML and labels.
- Keyboard-operable controls.
- Visible focus indicators.
- Accessible contrast.
- Do not rely on color alone for status.
- Responsive data tables with a mobile alternative.
- Screen-reader-friendly status and error messages.
