// Agent SOP for workflows: skip, acknowledge
export const NO_ACTION_SOP = `Applies only when the last inbound mail asks nothing new of this hotel's reservations: thanks / received / noted / FYI / auto-reply / out-of-office / newsletter / a reply that only confirms work staff already did / CC'd internal chatter with no instruction. If that last mail also contains an ask (please book, quote, amend, cancel, invoice, POP, forward, or a question that needs an answer), the ask wins — ignore this section.

For a mail that meets this condition:

- Never clarify or hms_todo. Never quote, create, amend, cancel, send_document, or payment_ack. This message has no remaining hotel work.
- workflow=skip, empty replyDraft: nobody is waiting on a reply (FYI, auto-reply, OOO, newsletter, internal chatter, resolved thread whose last line only confirms done). File. No to-do.
- workflow=acknowledge, one short replyDraft: only when the sender is waiting for a receipt note (they asked you to confirm receipt, or a guest/agent thanks you and clearly expects "noted"). Never a question. Never more than one line.
- Channel/OTA/system notices and pre-stay self-mail that only inform of an existing stay: skip, never create.

Done: skip or acknowledge. No to-do for mail that asked nothing.`;
