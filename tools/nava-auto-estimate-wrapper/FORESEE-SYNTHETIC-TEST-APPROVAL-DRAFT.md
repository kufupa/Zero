# Foresee approval request: one synthetic MCP estimate test

**Status:** Draft only. Not sent.

To: support@go-foresee.com
Subject: Permission / sandbox for one synthetic `quote_insurance` MCP test

Hi Foresee team,

Thanks for confirming we may use the MCP and hide Foresee branding in a private, local Hermes demo. Before we make any live quote request, we need to confirm whether that permission includes a synthetic test profile.

Your current Terms (last updated 16 September 2026) say automated access must be on behalf of an actual person shopping for insurance and quote details must be accurate and the person's own or genuinely authorized. We do not want to violate that requirement or create a misleading quote record.

Could you confirm one of these paths in writing?

1. **Preferred:** a supported sandbox/test endpoint or test mode where fully invented auto-rating details can be submitted safely; or
2. Explicit permission for **one** clearly synthetic `quote_insurance` request from our local `nava-car` Hermes demo to `https://mcp.go-foresee.com/mcp`, using no real shopper/company data, no `live_carrier_quotes`, no carrier submission, and no resale/publication. Please also confirm whether this is an exception to the actual-shopper clause and whether the synthetic request would be retained as a quote record for 24 months.

We would make exactly one request after approval, label every result as a synthetic test, and keep the transcript private. Until you confirm, we will use only a local fake MCP service and will not call `quote_insurance` on the live endpoint.

Best,
Ansh
