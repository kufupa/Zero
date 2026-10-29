# Owner voice: booking completeness and next-run planning

Date: 2026-10-27. Intake for this planning session, not product execution authorization.
Original voice-dictated wording retained below. Spelling aliases Promenado / promenado refer to the owner's named Pomerado repository from prior asks; side paying means side pane in the surrounding sentence.

## Original words

> That's okay, what were the 19-33 PRs that changed the finish line? How important were they? Because normally when I make planning and I kind of describe the high level goals, I'm okay with it taking longer if it achieves the same amount of completeness. Well I guess we kind of have to time box it, you can't go off a crazy side tangent because maybe you're just coding the wrong shit. But main few things on my mind is maybe we should keep chatting in this chat instead now. What I'm thinking is that we do a big fat retro, not retro, you've just done the retro, but suggest what we can learn from this and check the latest chat again to see what it's kind of doing. Then we're gonna have like the next couple of hours to build as much as we can. I'm thinking that we do the Promenado test ASAP because it looks like amend and cancellations and shit are broken. Um, so I want to, I think that's going to be super useful with that. That was, I want to make sure I fist him with our current PMS tools. So basically I want to be able to like run Promenado live and make sure that we achieved like as much ROI on helping them book that shit as possible. Currently it looks like some things are like failing and breaking like multi room quotes, et cetera, aren't working. So that's, that's what's on my mind, but you're gonna read through everything and be like, okay, that's not actually the highest ROI. But tell me what are the most important things to get working. And actually the most important is side paying working for new bookings with all of the shit that they would otherwise fill out an info which does include add and and uh i don think we have an add feature yet so for that i think using promenado is the way to go so um then there other shit too like amends and cancellations and multi-room stays which by the way we probably should work on then the ui and then the actual questions i need to ask them like when do you charge cancellation fee when do you not find the lab test where we own the profiles i don't really give a shit then we got to make sure we test it too like uh is the party lookup still working are we pre-filling it when the inbound comes in and then are we syncing it to the side pane so it's all already looked up in the hms and they just have to like look at it and move on uh i.e human in the loop and like it's our human in the loop ui good as well so all of this crap like i want you to research everything i've upgraded you to 6.1 soul so this main chat is much much much slower now but you can use Sonic 5.5 slash Luna 6 max sub-agents Sonic 5.5 on this code code maps to Luna 6 max So use a Sonic 5.5 sub-agent so you can track them And of course, learn from the retro The main thing is, you gotta tell me what from the retro we're learning And how we're making it better for next time And then we're gonna devise up the next plan After also checking what the current code code CLI chat is gonna do But I'm gonna be running those two in parallel I reckon the main conclusion we're going to come to is that I should just have multiple chats open and be working in them, so that you can grill me and make sure that we're doing the right shit the whole time, so that we can ship it faster, but go and ship as fast as possible. And also, it is... Yeah, walk me through it. Oh yeah, make sure that any Lunar Soviet should be deployed. are anchored well so that they don't all like fall into the same tool cause and shit in fact we should write that up into memory somewhere as well so that we don't deploy like just straight sub-agents which aren't prompted correctly
>
> otherwise they take ages to all look up known context

## Request trace

| Item | Requested output |
|---|---|
| PR growth | Exact original-versus-extra PR list, importance, completion repair versus tangent |
| Retro application | Concrete next-run changes, not another full retro |
| Parallel chat | Latest Phase 1 plan/activity, work/file/HMS ownership boundaries |
| Highest priority | Complete new-booking side pane with all relevant Infor fields and native Add-Ons |
| Pomerado | Controlled live Labtest trial integrated with existing deterministic PMS tools; do not assume it fixes every failure |
| Other workflows | Multi-room quote/stay, date amend, unpaid cancel; rank without dropping requested scope |
| Preparation | Verify inbound-time party/rate/availability prefetch, persisted result, side-pane hydration |
| Human review | UI preserves editable options, provenance, approval and independent readback |
| Client frontier | Cancellation-fee policy and other facts only staff can answer; Labtest proof does not wait for these |
| Speed | Next couple of hours as an allocation window, not an invented promise of full completion |
| Research routing | Sonnet-slot max workers, exact non-overlapping anchors, concise dated evidence files |
| Memory | Update existing subagent-brief feedback instead of adding duplicate memory |

No implementation, install, deploy, flag change, real-guest action or email send is implied by this intake. The owner explicitly asks for research and next-plan discussion before the build window.
