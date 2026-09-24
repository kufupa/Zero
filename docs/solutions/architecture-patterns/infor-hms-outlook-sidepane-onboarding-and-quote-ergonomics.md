---
title: "Infor HMS Outlook 2016 Side Pane Onboarding & Quoting Ergonomics"
problem_type: architecture_pattern
tags: [infor-hms, outlook-vsto, side-pane, onboarding, quote-tool, ux-patterns]
date: "2026-09-24"
---

# Infor HMS Outlook 2016 Side Pane Onboarding & Quoting Ergonomics

## Problem Context
When integrating Infor HMS availability quoting and guest reservation workflows into Microsoft Outlook (2016 desktop VSTO add-in task pane, strictly bounded to 380px), initial implementations frequently suffer from:
1. **Developer Leaks & Jargon:** Exposing internal CLI schema keys (`search.salesStrategy`, `schema: boardBases`, `schemaVersion: 2`, `ISO 8601`) rather than the native Infor HMS vocabulary that hotel reservationists use daily.
2. **Context Duplication:** Quoting the entire email message body inside the side pane, consuming limited vertical real estate when the message is already open side-by-side in the main Outlook window.
3. **Viewport & OS Popup Overflows:** Standard HTML date pickers spawning OS window popups that get clipped or hidden behind the Outlook application window.
4. **Disjointed Onboarding:** Dropping first-time reservationists directly into an empty tool without verifying mailbox ownership or demonstrating how the email-to-HMS bridge operates.

## Architecture & Design Solution

### 1. 4-Step Progressive Onboarding Flow
- **Step 1: Mailbox Detection & Confirmation:** Auto-detects the active Outlook account (e.g. `reservations@centurion.co.za`), displays property affiliation (`HRCEN — The Centurion Hotel`), and requires a single confirmation click.
- **Step 2: 3-Way Bridge Diagnostics:** Performs an immediate live handshake verifying (a) local Outlook VSTO COM add-in bridge, (b) cloud agent core connection latency (18ms ping with server timestamp), and (c) Infor HMS session (`HRCEN verified · NAVAAI active`).
- **Step 3: 3-Slide Interactive Primer:** Walks the reservationist through the three core actions: automatic email extraction, direct Infor HMS live rates with audit screenshots, and 1-click formatted quotation drafts.
- **Step 4: Seamless Tool Handoff:** Instantly unlocks the active inquiry quoting view for the open email.

### 2. Native Infor HMS Quoting UI
- **Strict Infor HMS Nomenclature:** Uses `SEARCH CRITERIA` and `ROOM RATES` section headers, `Property *`, `Dates of Stay *`, `Meal Plan *`, `Room Types & Occupancy *`, `Sales Strategy *`, and `Organization`.
- **In-Pane 326px Calendar Widget:** 100% physically contained within the 380px pane (`left=29px, right=351px`), completely preventing horizontal scrollbars or OS popup z-index clipping.
- **Dual Audit Proof Tabs:** Toggles between `Availability Results` (price grid) and `Search Criteria` (search inputs), with a 1-click `1000×800` unscaled modal view to inspect the native Infor HMS grid at 100% DPI.
- **Direct Email Draft Generation:** Translates the selected rate tier into a structured, formatted HTML quotation table inserted directly into the active Outlook reply draft.
