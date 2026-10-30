# Quantity-aware quote view

`getQuoteView(snapshot, { roomQuantity, ...filters })` adds a room-count check
to the bounded `getAvailabilityView` result. Supply a positive integer for the
number of rooms of this room type in the scenario. A `roomQuantity` already in
the snapshot's requested criteria is also accepted; conflicting values fail.
If the quantity is unknown, the result reports `ROOM_QUANTITY_UNKNOWN` and does
not assume one room.

Each returned night includes the requested quantity, the difference between it
and the observed room count (`observedShortfall`, never below zero), and a
status. A known shortfall is `shortfall`; missing inventory or unverified search
scope remains unknown. `count_sufficient` means only that the observed count is
large enough for that night. It does not establish rate eligibility, a hold,
combined availability across room types or a reservation. The option-level
status is `partial` when later nights have not been returned. Follow the view's
night-page cursor before using the whole stay.

Adult and child counts are per search scenario; guest names and room quantity
are separate inputs. Run separate searches for different dates or occupancies.
The underlying snapshot and quote view remain private. No total is inferred.
