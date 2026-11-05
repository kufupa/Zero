# Group scope review

Keep `group` as a category whenever the email establishes more than 10 rooms for one group; group emails remain in the reservation denominator.

For `can_help`, a quote, booking, change, cancellation, invoice or document filing **for that large group** is out of scope, even when that action type is usually supported. Examples: a quote for 18 rooms is not helpable; an invoice amendment for the same 18-room group is not helpable.

Set `can_help` true for a large-group email only if it also requests a separate supported task for a different individual or booking of at most 10 rooms. The reason must name that separate non-group task. General invoice, amendment or quote work attached to the large group does not qualify.

If 10 rooms are requested, it is not a large group. If more than 10 people are mentioned but room count cannot reasonably be inferred, keep `can_help` null and do not tag `group`.
